/* Sombras de la Pampa - laboratorio diagnóstico v0.2.
 * No requiere framework; funciona en Chrome Android, Safari iOS, PC.
 * Todos los fallos quedan clasificados sin inventar un diagnóstico definitivo.
 */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const logEntries = [];
  const tests = new Map();
  const msgSeqs = new Set();
  const REPORT_VERSION = '0.2';
  const state = {server:'',expectedSid:'',actualSid:'',socket:null,socketPing:null,poller:null,busy:false,db:null};
  const currentTime = () => new Date().toISOString();
  const randId = () => (globalThis.crypto && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `r${Date.now()}-${Math.round(Math.random()*1e8)}`);
  const errorToObj = ex => ({name:String(ex?.name||'Error'),message:String(ex?.message||ex||''),stack:String(ex?.stack||'').slice(0,700)});
  const isHTTPS = location.protocol === 'https:';
  const isTrusted = window.isSecureContext;
  const isLocalTest = location.pathname.includes('/local/');

  function log(code,level='INFO',details={}) {
    const e = {at:currentTime(),side:'CLIENT',code,level,details};
    logEntries.push(e);
    if (logEntries.length>900) logEntries.shift();
    const fn = level==='ERROR'?'error':level==='WARN'?'warn':'log';
    try{console[fn]('[SOMBRAS-LAB]',e.code,e.details);}catch(_){}
    renderLog();return e;
  }
  function renderLog(){
    $('log-count').textContent=String(logEntries.length);
    $('error-count').textContent=String(logEntries.filter(x=>x.level==='ERROR').length);
    $('warning-count').textContent=String(logEntries.filter(x=>x.level==='WARN').length);
    const filter=$('log-filter')?.value||'ALL';
    const view=$('log-view');view.replaceChildren();
    const kept=logEntries.filter(x=>filter==='ALL'||x.level==='ERROR'||(filter==='WARN'&&x.level==='WARN')).slice(-100);
    for(const entry of kept){
      const node=document.createElement('div');node.className=`log-entry ${entry.level}`;
      const label=document.createElement('span');label.className='code';label.textContent=`${entry.at.slice(11,23)} [${entry.level}] ${entry.code}`;
      node.append(label);
      if(entry.details && Object.keys(entry.details).length){const extra=document.createElement('span');extra.textContent=' '+JSON.stringify(entry.details);node.append(extra);}
      view.append(node);
    }
    view.scrollTop=view.scrollHeight;
  }
  function setCheck(key,title,status,code,detail=''){
    tests.set(key,{key,title,status,code,detail,at:currentTime()});renderTests();
    log(code,status==='fail'?'ERROR':status==='warn'?'WARN':'INFO',{test:key,detail});
  }
  function renderTests(){
    const view=$('test-results');view.replaceChildren();
    for(const t of tests.values()){
      const row=document.createElement('div');row.className='test-row';
      const dot=document.createElement('span');dot.className='status-dot '+t.status;
      const body=document.createElement('div');const strong=document.createElement('strong');strong.textContent=t.title;
      const sub=document.createElement('small');sub.textContent=`${t.code}${t.detail?' · '+t.detail:''}`;
      body.append(strong,sub);row.append(dot,body);view.append(row);
    }
  }
  function context(){
    return {
      client_version:REPORT_VERSION,href:location.href,origin:location.origin,protocol:location.protocol,
      ua:navigator.userAgent,platform:navigator.platform,language:navigator.language,
      isSecureContext:isTrusted,standalone:window.matchMedia('(display-mode: standalone)').matches,
      onlineHint:navigator.onLine,serviceWorkerAPI:'serviceWorker' in navigator,
      indexedDBAPI:'indexedDB' in window,webSocketAPI:'WebSocket' in window,
      barcodeDetectorAPI:'BarcodeDetector' in window,
      targetAddressSpaceSupported:(()=>{try{return 'targetAddressSpace' in new Request(location.href,{targetAddressSpace:'local'});}catch(ex){return 'error:'+String(ex);}})(),
      storage_estimate_available:!!navigator.storage?.estimate,
      server:state.server,server_id_expected:state.expectedSid||null,server_id_seen:state.actualSid||null
    };
  }
  function cleanServer(value){
    let s=String(value||'').trim();if(!s)throw new Error('Ingresá IP y puerto.');
    if(!/^https?:\/\//i.test(s)) s='http://'+s;
    const u=new URL(s);
    if(!['http:','https:'].includes(u.protocol)||!u.hostname)throw new Error('Solo direcciones HTTP o HTTPS válidas.');
    return u.origin;
  }
  function saveServer(){
    try{
      state.server=cleanServer($('server-url').value);
      localStorage.setItem('sombras-lab-server',state.server);
      $('server-url').value=state.server;
      $('direct-link').href=state.server+'/api/ping';
      $('server-state-label').textContent='Configurado; falta probar';
      $('server-state').className='status-dot neutral';
      log('I_SERVER_ENDPOINT_SET','INFO',{server:state.server});
      if(state.socket) {try{state.socket.close(1000,'server changed');}catch(_){}}
      return true;
    }catch(ex){log('E_SERVER_URL_INVALID','ERROR',errorToObj(ex));setCheck('server','Dirección del servidor','fail','E_SERVER_URL_INVALID',ex.message);return false;}
  }
  function currentServer(override){return override||state.server||'http://127.0.0.1:8765';}
  function baseResult(status,error,data,ms,rid,url){return {status,error,data,ms,rid,url};}
  function diagnosticFromFetch(ex,url){
    if(ex?.name==='AbortError')return {code:'E_NET_TIMEOUT',help:'No respondió a tiempo: comprobá IP, puerto, Wi-Fi y firewall.'};
    if(ex?.name==='TypeError')return {code:'E_NET_BLOCKED_OR_UNREACHABLE',help:isHTTPS&&url.startsWith('http:')?'La página HTTPS no pudo leer HTTP local. Puede ser contenido mixto, permiso LNA, CORS, firewall o servidor apagado. No distinguible con este error.':'Posibles causas: IP/puerto erróneos, firewall, Wi-Fi, CORS o servidor apagado. No distinguible con este error.'};
    if(ex?.name==='SyntaxError')return {code:'E_HTTP_INVALID_RESPONSE',help:'Se recibió una respuesta, pero no era JSON válido.'};
    return {code:'E_HTTP_UNKNOWN',help:'Error inesperado: revisá nombre, mensaje y stack.'};
  }
  function timeoutFetch(url,options={},timeout=6000){
    const c=new AbortController();const h=setTimeout(()=>c.abort(),timeout);
    return fetch(url,{...options,signal:c.signal}).finally(()=>clearTimeout(h));
  }
  async function api(path,{method='GET',payload=null,hint=true,serverOverride=null,expectedStatus=200}={}){
    const server=currentServer(serverOverride);const rid=randId();
    const u=new URL(path,server+'/');u.searchParams.set('rid',rid);
    const url=u.toString();const st=performance.now();
    const options={method,mode:'cors',credentials:'omit',cache:'no-store'};
    if(hint && isHTTPS && url.startsWith('http:'))options.targetAddressSpace='local';
    if(payload!==null){options.headers={'Content-Type':'application/json','X-Diagnostic-Id':rid};options.body=JSON.stringify(payload);}
    log('D_HTTP_START','DEBUG',{method,url,rid,targetAddressSpace:options.targetAddressSpace||'none',preflightExpected:payload!==null});
    try{
      const response=await timeoutFetch(url,options);
      const ms=Math.round(performance.now()-st);
      const raw=await response.text();
      let data;
      try{data=JSON.parse(raw);}catch(ex){log('E_HTTP_INVALID_RESPONSE','ERROR',{rid,status:response.status,bodySnippet:raw.slice(0,120),error:errorToObj(ex)});throw new SyntaxError('La respuesta HTTP no contiene JSON válido.');}
      const headerRID=response.headers.get('X-Diagnostic-Id');
      log('I_HTTP_RESPONSE','INFO',{rid,serverRID:headerRID,status:response.status,ms,serverId:data.server_id||null,headers:{allowOrigin:response.headers.get('Access-Control-Allow-Origin'),version:response.headers.get('X-Lab-Version')}});
      if(response.status!==expectedStatus){const code='E_HTTP_STATUS_'+response.status;log(code,'ERROR',{rid,expectedStatus,status:response.status,serverCode:data.code||null});return baseResult('fail',code,data,ms,rid,url);}
      if(expectedStatus>=400){log('I_TEST_EXPECTED_HTTP_ERROR','INFO',{rid,code:data.code,status:response.status});return baseResult('ok',null,data,ms,rid,url);}
      if(state.expectedSid && data.server_id && state.expectedSid!==data.server_id){const code='E_SERVER_ID_MISMATCH';log(code,'ERROR',{rid,expected:state.expectedSid,received:data.server_id});return baseResult('fail',code,data,ms,rid,url);}
      if(data.server_id){state.actualSid=data.server_id;$('server-id-label').textContent='Servidor: '+data.server_id.slice(0,8)+'…';}
      return baseResult('ok',null,data,ms,rid,url);
    }catch(ex){
      const ms=Math.round(performance.now()-st),classified=diagnosticFromFetch(ex,url);
      log(classified.code,'ERROR',{rid,method,url,ms,error:errorToObj(ex),hypothesis:classified.help,
        caution:'La ausencia de respuesta no demuestra una causa concreta; comparar log del servidor y abrir /api/ping directamente.'});
      return baseResult('fail',classified.code,{help:classified.help,exception:errorToObj(ex)},ms,rid,url);
    }
  }
  async function probePing(hint=true,key='ping'){
    if(!saveServer())return;
    setCheck(key,hint?'HTTP GET (modo LNA)':'HTTP GET (sin LNA explícito)','run','I_TEST_RUNNING');
    const result=await api('/api/ping',{hint});
    const detail=result.status==='ok'?`HTTP OK, ${result.ms} ms, rid ${result.rid}`:`${result.data?.help||''} · rid ${result.rid}`;
    setCheck(key,hint?'HTTP GET (modo LNA)':'HTTP GET (sin LNA explícito)',result.status,result.error||'OK_HTTP_PING',detail);
    $('server-state').className='status-dot '+result.status;
    $('server-state-label').textContent=result.status==='ok'?'HTTP disponible':'HTTP falló · '+result.error;
    if(result.status==='ok'&&!state.poller)startPolling();
    return result;
  }
  async function probeEcho(){
    if(!saveServer())return;
    setCheck('echo','POST JSON + preflight CORS','run','I_TEST_RUNNING');
    const result=await api('/api/echo',{method:'POST',payload:{probe:'preflight-cors',sent_at:currentTime(),note:'No contiene datos personales'}});
    const valid=result.status==='ok' && result.data?.echo?.probe==='preflight-cors';
    setCheck('echo','POST JSON + preflight CORS',valid?'ok':'fail',valid?'OK_CORS_PREFLIGHT_AND_POST':(result.error||'E_ECHO_DIFFERENT'),valid?`${result.ms} ms · rid ${result.rid}`:'Comparar S_CORS_PREFLIGHT en logs del servidor.');
    return result;
  }
  function wsURL(){let u=new URL(state.server);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname='/ws';u.search='?rid='+encodeURIComponent(randId());return u.toString();}
  function closeWS(){
    if(state.socket){try{state.socket.close(1000,'new test');}catch(_){}}
    if(state.socketPing){clearInterval(state.socketPing);state.socketPing=null;}
  }
  async function probeWS(){
    if(!saveServer())return;
    closeWS();setCheck('ws','WebSocket en tiempo real','run','I_TEST_RUNNING');
    if(!window.WebSocket){setCheck('ws','WebSocket en tiempo real','fail','E_WS_API_MISSING');return false;}
    const url=wsURL(),started=performance.now();
    log('D_WS_CONNECT','DEBUG',{url,rid:new URL(url).searchParams.get('rid')});
    return new Promise(resolve=>{
      let finished=false;
      const timeout=setTimeout(()=>finish(false,'E_WS_TIMEOUT','No llegó el saludo del servidor en 7 segundos.'),7000);
      function finish(ok,code,reason){
        if(finished)return;finished=true;clearTimeout(timeout);
        setCheck('ws','WebSocket en tiempo real',ok?'ok':'fail',code,`${Math.round(performance.now()-started)} ms · ${reason}`);
        $('ws-dot').className='status-dot '+(ok?'ok':'fail');$('ws-status').textContent=ok?'WebSocket conectado':code;
        resolve(ok);
      }
      try{
        const sock=new WebSocket(url);state.socket=sock;
        sock.onopen=()=>{log('I_WS_OPEN','INFO',{url,ms:Math.round(performance.now()-started)});};
        sock.onmessage=event=>{
          try{
            const obj=JSON.parse(event.data);
            if(obj.type==='hello'){
              if(state.expectedSid&&state.expectedSid!==obj.server_id){finish(false,'E_SERVER_ID_MISMATCH','WebSocket pertenece a otra instalación.');return;}
              log('OK_WS_HELLO','INFO',{serverId:obj.server_id,rid:obj.rid});
              finish(true,'OK_WS_CONNECTED','Recibido saludo del servidor.');
              if(state.socketPing)clearInterval(state.socketPing);
              state.socketPing=setInterval(()=>{if(sock.readyState===WebSocket.OPEN)try{sock.send('ping')}catch(ex){log('E_WS_SEND_PING','WARN',errorToObj(ex))}},25000);
            } else if(obj.type==='message'){
              log('I_WS_MESSAGE_RECEIVED','INFO',{seq:obj.message?.seq,from:obj.message?.sender});addMessage(obj.message);
            } else if(obj.type==='pong'){log('D_WS_PONG','DEBUG',{at:obj.server_time});}
          }catch(ex){log('E_WS_JSON_INVALID','ERROR',errorToObj(ex));}
        };
        sock.onerror=()=>{log('E_WS_ERROR','ERROR',{url,hypothesis:'Error opaco de WebSocket: posible bloqueo de contenido mixto, permiso LNA o conexión. El navegador no entrega causa precisa.'});finish(false,'E_WS_ERROR','Consultar log del servidor para ver si llegó S_WS_OPEN.');};
        sock.onclose=e=>{
          if(state.socket===sock){$('ws-dot').className='status-dot warn';$('ws-status').textContent=`WebSocket cerrado (${e.code})`;}
          log('W_WS_CLOSED','WARN',{code:e.code,reason:e.reason,wasClean:e.wasClean});
          if(!finished)finish(false,'E_WS_CLOSED_BEFORE_HELLO',`Cierre antes del saludo: ${e.code}`);
        };
      }catch(ex){log('E_WS_CONSTRUCTOR','ERROR',errorToObj(ex));finish(false,'E_WS_CONSTRUCTOR',String(ex));}
    });
  }
  async function probeExpectedError(){
    if(!saveServer())return;
    setCheck('418','Error intencional HTTP 418','run','I_TEST_RUNNING');
    const r=await api('/api/expected-error',{expectedStatus:418});
    const good=r.status==='ok'&&r.data?.code==='E_TEST_EXPECTED_418';
    setCheck('418','Error intencional HTTP 418',good?'ok':'fail',good?'OK_EXPECTED_HTTP_418':(r.error||'E_418_UNEXPECTED'),good?`HTTP 418 y código E_TEST_EXPECTED_418 correctamente recibidos · rid ${r.rid}`:'Se esperaba HTTP 418.');
  }
  async function probeWrongPort(){
    if(!saveServer())return;
    let u=new URL(state.server);u.port=String(Number(u.port||((u.protocol==='https:')?'443':'80'))+1);
    setCheck('wrong-port','Puerto equivocado (simulado)','run','I_TEST_RUNNING');
    const r=await api('/api/ping',{serverOverride:u.origin});
    if(r.status==='fail')setCheck('wrong-port','Puerto equivocado (simulado)','ok','OK_FAILURE_DETECTED',`Se detectó fallo como estaba previsto: ${r.error}. Puerto habitual conservado.`);
    else setCheck('wrong-port','Puerto equivocado (simulado)','warn','W_ALT_PORT_HAS_SERVER','El puerto alternativo también respondió; no es necesariamente un error.');
  }
  function openDB(){
    if(!('indexedDB' in window))return Promise.reject(Object.assign(new Error('No existe IndexedDB'),{name:'UnsupportedError'}));
    if(state.db)return Promise.resolve(state.db);
    return new Promise((resolve,reject)=>{
      try{
        const req=indexedDB.open('sombras-lab-local-v02',1);
        req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('notes'))db.createObjectStore('notes',{keyPath:'id'});};
        req.onsuccess=()=>{state.db=req.result;state.db.onversionchange=()=>{state.db.close();state.db=null;};resolve(state.db)};
        req.onerror=()=>reject(req.error||new Error('IndexedDB open error'));
        req.onblocked=()=>log('W_IDB_OPEN_BLOCKED','WARN',{detail:'Otra pestaña conserva abierta una versión incompatible'});
      }catch(ex){reject(ex)}
    });
  }
  function dbOperation(mode,op){
    return openDB().then(db=>new Promise((resolve,reject)=>{
      try{const tx=db.transaction('notes',mode),store=tx.objectStore('notes');const req=op(store);
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('IndexedDB request failed'));
        tx.onabort=()=>reject(tx.error||new Error('IndexedDB transaction aborted'));
      }catch(ex){reject(ex)}
    }));
  }
  async function saveNote(){
    const note=$('offline-note').value.trim();if(!note){setCheck('idb','IndexedDB offline','warn','W_NOTE_EMPTY','Escribí primero una nota de prueba.');return;}
    try{const record={id:'offline-test',body:note,updated:currentTime()};await dbOperation('readwrite',store=>store.put(record));
      log('OK_IDB_NOTE_WRITTEN','INFO',{id:record.id,length:note.length});
      setCheck('idb','IndexedDB offline','ok','OK_IDB_WRITE','Nota guardada localmente, no se envió al servidor.');
      $('storage-dot').className='status-dot ok';$('storage-status').textContent='Nota guardada localmente';
    }catch(ex){log('E_IDB_WRITE','ERROR',errorToObj(ex));setCheck('idb','IndexedDB offline','fail','E_IDB_WRITE',ex.message);}
  }
  async function readNote(){
    try{const r=await dbOperation('readonly',store=>store.get('offline-test'));
      if(!r){setCheck('idb','IndexedDB offline','warn','W_IDB_NOTE_NOT_FOUND','No se guardó una nota todavía.');return;}
      $('offline-note').value=r.body;
      log('OK_IDB_NOTE_READ','INFO',{updated:r.updated,characters:r.body.length});
      setCheck('idb','IndexedDB offline','ok','OK_IDB_READ',`Nota recuperada: ${r.body.length} caracteres, guardada ${r.updated}`);
      $('storage-dot').className='status-dot ok';$('storage-status').textContent='Nota recuperada correctamente';
    }catch(ex){log('E_IDB_READ','ERROR',errorToObj(ex));setCheck('idb','IndexedDB offline','fail','E_IDB_READ',ex.message);}
  }
  async function clearNote(){
    try{await dbOperation('readwrite',store=>store.delete('offline-test'));$('offline-note').value='';
      log('OK_IDB_NOTE_DELETED','INFO');setCheck('idb','IndexedDB offline','ok','OK_IDB_NOTE_DELETED','Nota de prueba eliminada');
    }catch(ex){log('E_IDB_DELETE','ERROR',errorToObj(ex))}
  }
  async function probeIDB(){
    const probe='prueba-'+randId();
    try{
      await dbOperation('readwrite',store=>store.put({id:'idb-health',body:probe,updated:currentTime()}));
      const r=await dbOperation('readonly',store=>store.get('idb-health'));
      if(!r||r.body!==probe)throw new Error('El valor leído no coincide con el valor guardado.');
      setCheck('idb-health','Escritura y lectura IndexedDB','ok','OK_IDB_ROUNDTRIP','La prueba sobrevivirá a recargar la página; las notas son independientes del servidor.');
      log('OK_IDB_ROUNDTRIP','INFO',{id:r.id});
    }catch(ex){log('E_IDB_ROUNDTRIP','ERROR',errorToObj(ex));setCheck('idb-health','Escritura y lectura IndexedDB','fail','E_IDB_ROUNDTRIP',ex.message);}
  }
  async function probeSW(){
    if(!('serviceWorker' in navigator)||!isTrusted){
      const msg=!isTrusted?'Origen HTTP de red (no seguro): Service Worker no disponible. Es ESPERADO para la prueba local.':'Navegador sin API Service Worker.';
      log('E_SW_UNAVAILABLE','WARN',{origin:location.origin,secure:isTrusted,reason:msg});
      setCheck('sw','Service Worker / offline instalable','warn','E_SW_UNAVAILABLE',msg);
      return;
    }
    try{
      const r=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
      await navigator.serviceWorker.ready;
      const keys=await caches.keys();
      const hasCache=keys.some(x=>x.startsWith('sombras-lab-shell-'));
      log('OK_SW_REGISTERED','INFO',{scope:r.scope,active:!!r.active,caches:keys,controlled:!!navigator.serviceWorker.controller});
      setCheck('sw','Service Worker / offline instalable',hasCache?'ok':'warn',hasCache?'OK_SW_CACHE_READY':'W_SW_CACHE_NOT_VISIBLE',hasCache?'Archivos de interfaz cacheados. Hacé la prueba real sin Wi‑Fi.':'Service Worker listo; caché todavía no visible.');
      if(navigator.serviceWorker.controller){
        const callback=e=>{if(e.data?.type==='PONG_SW'){log('OK_SW_MESSAGE','INFO',{version:e.data.version});navigator.serviceWorker.removeEventListener('message',callback)}};
        navigator.serviceWorker.addEventListener('message',callback);
        navigator.serviceWorker.controller.postMessage({type:'PING_SW'});
      }
    }catch(ex){log('E_SW_REGISTER','ERROR',errorToObj(ex));setCheck('sw','Service Worker / offline instalable','fail','E_SW_REGISTER',ex.message);}
  }
  async function sendMessage(){
    if(!saveServer())return;
    const text=$('message').value.trim();if(!text){log('W_MESSAGE_EMPTY','WARN');return;}
    const sender=($('nickname').value||'Celular').trim().slice(0,32);
    const r=await api('/api/message',{method:'POST',payload:{sender,text}});
    if(r.status==='ok'){$('message').value='';log('OK_MESSAGE_SENT','INFO',{seq:r.data.message?.seq,ms:r.ms,rid:r.rid});addMessage(r.data.message);}else{log('E_MESSAGE_SEND','ERROR',{reason:r.error,rid:r.rid});}
  }
  function addMessage(msg){
    if(!msg||msgSeqs.has(msg.seq))return;
    msgSeqs.add(msg.seq);const box=$('chat-messages');
    const intro=box.querySelector('.hint');if(intro)intro.remove();
    const el=document.createElement('div');el.className='msg';
    const b=document.createElement('b');b.textContent=msg.sender+' · ';
    const t=document.createElement('span');t.textContent=msg.text;
    const stamp=document.createElement('small');stamp.textContent=`Secuencia ${msg.seq} · ${msg.at}`;
    el.append(b,t,stamp);box.append(el);box.scrollTop=box.scrollHeight;
    while(box.children.length>30)box.firstChild.remove();
  }
  async function pollMessages(silent=false){
    if(!state.server)return;
    const r=await api('/api/messages',{hint:true});
    if(r.status==='ok'){
      let newCount=0;
      for(const m of (r.data.messages||[])){if(!msgSeqs.has(m.seq)){newCount++;addMessage(m)}}
      if(newCount)log('OK_POLL_NEW_MESSAGES','INFO',{newCount});
      $('polling-status').textContent='Lectura HTTP activa';
    }else{
      if(!silent)log('W_POLL_FAILED','WARN',{code:r.error});
      $('polling-status').textContent='Lectura HTTP falló';
    }
  }
  function startPolling(){
    if(state.poller)return;
    pollMessages(true);
    state.poller=setInterval(()=>{if(!document.hidden && navigator.onLine)pollMessages(true)},12000);
    log('I_HTTP_POLLING_STARTED','INFO',{intervalMs:12000});
  }
  async function runAll(){
    if(state.busy)return;state.busy=true;$('run-all').disabled=true;
    log('I_FULL_DIAGNOSTIC_STARTED','INFO',{context:context()});
    try{
      if(!saveServer())return;
      await probePing(true,'ping');
      await probePing(false,'plain-ping');
      await probeEcho();
      await probeWS();
      await probeExpectedError();
      await probeIDB();
      await probeSW();
      try{if(navigator.storage?.estimate){const e=await navigator.storage.estimate();log('I_STORAGE_ESTIMATE','INFO',{usage:e.usage,quota:e.quota});}}catch(ex){log('W_STORAGE_ESTIMATE_FAILED','WARN',errorToObj(ex));}
      log('I_FULL_DIAGNOSTIC_FINISHED','INFO',{results:Array.from(tests.values()).map(t=>({test:t.key,status:t.status,code:t.code}))});
    }finally{state.busy=false;$('run-all').disabled=false;}
  }
  function downloadReport(){
    const report={schema:'sombras-lab-report-v02',exported_at:currentTime(),context:context(),checks:Array.from(tests.values()),logs:logEntries};
    const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
    const a=document.createElement('a');const url=URL.createObjectURL(blob);a.href=url;
    a.download='sombras-diagnostico-'+new Date().toISOString().slice(0,19).replace(/:/g,'-')+'.json';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
    log('I_DIAGNOSTIC_EXPORTED','INFO',{records:logEntries.length,filename:a.download});
  }
  async function copyReport(){
    const list=Array.from(tests.values()).map(t=>`${t.status.toUpperCase()} ${t.code}: ${t.title} ${t.detail}`).join('\n');
    const text=`Sombras Lab v${REPORT_VERSION}\n${JSON.stringify(context(),null,2)}\n\nPRUEBAS\n${list}\n\nERRORES\n${logEntries.filter(t=>t.level==='ERROR').map(t=>t.at+' '+t.code+' '+JSON.stringify(t.details)).join('\n')}`;
    try{await navigator.clipboard.writeText(text);log('OK_DIAGNOSTIC_COPIED','INFO',{chars:text.length});}
    catch(ex){log('E_CLIPBOARD_FAILED','ERROR',errorToObj(ex));alert('El navegador no permitió copiar. Usá Descargar diagnóstico JSON.');}
  }
  function initBindings(){
    $('save-server').addEventListener('click',saveServer);
    $('server-url').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();saveServer();}});
    $('run-all').addEventListener('click',runAll);
    $('run-ping').addEventListener('click',()=>probePing());
    $('run-echo').addEventListener('click',probeEcho);
    $('run-ws').addEventListener('click',probeWS);
    $('run-offline').addEventListener('click',async()=>{await probeIDB();await probeSW();});
    $('run-error').addEventListener('click',probeExpectedError);
    $('run-wrong-port').addEventListener('click',probeWrongPort);
    $('send-message').addEventListener('click',sendMessage);
    $('message').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();sendMessage()}});
    $('save-note').addEventListener('click',saveNote);
    $('read-note').addEventListener('click',readNote);
    $('clear-note').addEventListener('click',clearNote);
    $('export-log').addEventListener('click',downloadReport);
    $('copy-log').addEventListener('click',copyReport);
    $('clear-log').addEventListener('click',()=>{logEntries.length=0;renderLog();log('I_LOG_SCREEN_CLEARED','INFO');});
    $('log-filter').addEventListener('change',renderLog);
  }
  function initListeners(){
    window.addEventListener('error',e=>log('E_BROWSER_JS_ERROR','ERROR',{message:e.message,file:e.filename,line:e.lineno,column:e.colno,error:errorToObj(e.error)}));
    window.addEventListener('unhandledrejection',e=>log('E_UNHANDLED_PROMISE','ERROR',{error:errorToObj(e.reason)}));
    window.addEventListener('securitypolicyviolation',e=>log('E_BROWSER_SECURITY_POLICY','ERROR',{directive:e.violatedDirective,blockedURI:e.blockedURI,disposition:e.disposition}));
    window.addEventListener('online',()=>log('I_BROWSER_ONLINE','INFO',{note:'navigator.onLine no confirma acceso al servidor LAN.'}));
    window.addEventListener('offline',()=>log('W_BROWSER_OFFLINE','WARN',{note:'El navegador informa pérdida de conexión de red.'}));
    document.addEventListener('visibilitychange',()=>log('I_VISIBILITY_CHANGE','DEBUG',{visibility:document.visibilityState}));
    if('serviceWorker' in navigator)navigator.serviceWorker.addEventListener('controllerchange',()=>log('I_SW_CONTROLLER_CHANGED','INFO',{controlled:!!navigator.serviceWorker.controller}));
  }
  function init(){
    initBindings();initListeners();
    const qp=new URLSearchParams(location.search);
    const candidate=qp.get('server')||localStorage.getItem('sombras-lab-server')||(isLocalTest?location.origin:'');
    $('server-url').value=candidate;
    if(qp.get('sid')){state.expectedSid=qp.get('sid');log('I_QR_SERVER_ID_RECEIVED','INFO',{sid:state.expectedSid});}
    if(candidate)saveServer();
    const ua=navigator.userAgent;
    $('nickname').value=/iPhone|iPad/.test(ua)?'iPhone':/Android/.test(ua)?'Android':'Notebook';
    const secure=isTrusted;
    $('security-pill').className='pill '+(secure?'ok':'warn');
    $('security-pill').textContent=secure?'Origen seguro':'HTTP local';
    $('mode-notice').className='notice '+(secure?'ok':'warn');
    $('mode-notice').textContent=secure? 'Modo HTTPS: esta página puede instalarse y guardar recursos offline. Las llamadas HTTP a la notebook pueden ser bloqueadas por el navegador, especialmente Safari/iPhone.':'Modo HTTP local: útil para comprobar que la notebook es alcanzable por Wi-Fi. En un celular NO puede registrar el Service Worker para funcionar como PWA offline. Usá también la variante HTTPS publicada.';
    log('I_APP_START','INFO',{context:context()});
    if(qp.get('server'))log('I_QR_SERVER_ADDRESS_RECEIVED','INFO',{server:qp.get('server'),sid:qp.get('sid')||null});
    if(!secure)log('W_INSECURE_CONTEXT','WARN',{origin:location.origin,reason:'Service Worker requiere HTTPS o localhost; esta IP de red no es localhost.'});
    setTimeout(async()=>{await probeSW();await readNote();},150);
  }
  init();
})();
