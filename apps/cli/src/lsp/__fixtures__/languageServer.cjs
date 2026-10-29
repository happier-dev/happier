// External stdio boundary used by the host integration tests.
const fs = require('node:fs');
const log = process.argv[2];
const options = JSON.parse(process.argv[3] || '{}');
let input = Buffer.alloc(0), registered = false, queued = [], documents = new Map(), pending = new Map(), externalDiagnosticMessage, progressRequest, commandRequest, organizerUri;
const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
const send = value => { const json = JSON.stringify({jsonrpc:'2.0', ...value}); process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`); };
const reply = (id, result) => send({id, result});
const range = {start:{line:0,character:0},end:{line:0,character:1}};
const answer = message => {
  if (message.method === 'shutdown') {reply(message.id,null);return;}
  const uri = message.params?.textDocument?.uri;
  const document = documents.get(uri);
  if (options.editingFeatures) {
    const item = {name:'fixture',kind:12,uri:uri || message.params?.item?.uri,range,selectionRange:range,data:{native:true}};
    if (message.method === 'textDocument/completion') {reply(message.id,options.completionItems?{isIncomplete:false,items:options.completionItems}:options.completionDefaults?{isIncomplete:false,itemDefaults:{data:{native:true},insertTextFormat:2,editRange:range},items:[{label:'fixture',kind:3,textEditText:'fixture(${1:value})$0'}]}:{isIncomplete:false,items:[{label:'fixture',kind:3,insertText:'fixture(${1:value})$0',insertTextFormat:2,data:{native:true}}]});return;}
    if (message.method === 'completionItem/resolve') {reply(message.id,{...message.params,detail:'resolved',additionalTextEdits:[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'import x;\n'}]});return;}
    if (message.method === 'textDocument/signatureHelp') {reply(message.id,{signatures:[{label:'fixture(value)',parameters:[{label:[8,13]}]}],activeSignature:0,activeParameter:0});return;}
    if (message.method === 'textDocument/formatting' || message.method === 'textDocument/rangeFormatting') {reply(message.id,[{range,newText:'formatted'}]);return;}
    if (message.method === 'textDocument/codeAction' && message.params?.context?.only?.includes('source.organizeImports')) {organizerUri=uri;reply(message.id,[{title:'Organize',kind:'source.organizeImports.fixture',...(options.organizerNeedsResolve?{}:options.organizerCommandOnly?{command:{title:'Organize',command:'fixture.fix'}}:{edit:{changes:{[uri]:[{range,newText:'organized'}]}}})}]);return;}
    if (message.method === 'codeAction/resolve') {reply(message.id,{...message.params,edit:{changes:{[organizerUri]:[{range,newText:'organized'}]}}});return;}
    if (message.method === 'textDocument/typeDefinition' || message.method === 'textDocument/implementation') {reply(message.id,[{uri,range}]);return;}
    if (message.method === 'textDocument/documentHighlight') {reply(message.id,[{range,kind:2}]);return;}
    if (message.method === 'textDocument/selectionRange') {reply(message.id,[{range,parent:{range:{start:range.start,end:{line:0,character:3}}}}]);return;}
    if (message.method === 'textDocument/inlayHint') {reply(message.id,[{position:range.start,label:'value:',kind:2,paddingRight:true}]);return;}
    if (message.method === 'textDocument/semanticTokens/range') {reply(message.id,{resultId:'tokens-1',data:[0,0,1,0,0]});return;}
    if (message.method === 'textDocument/semanticTokens/full') {reply(message.id,{resultId:'tokens-1',data:[0,0,1,0,0,1,0,1,0,0]});return;}
    if (message.method === 'textDocument/semanticTokens/full/delta') {reply(message.id,{resultId:'tokens-2',edits:[{start:0,deleteCount:5,data:[0,0,2,0,0]}]});return;}
    if (message.method === 'textDocument/prepareCallHierarchy') {reply(message.id,[item]);return;}
    if (message.method === 'callHierarchy/incomingCalls') {reply(message.id,[{from:item,fromRanges:[range]}]);return;}
    if (message.method === 'callHierarchy/outgoingCalls') {reply(message.id,[{to:item,fromRanges:[range]}]);return;}
    if (message.method === 'workspace/symbol') {reply(message.id,[{name:message.params.query,kind:12,location:{uri:new URL('a.ts',options.rootUri).href,range}}]);return;}
    if (message.method === 'workspace/diagnostic') {reply(message.id,{items:[{uri:new URL('a.ts',options.rootUri).href,version:null,kind:'full',items:Array.from({length:options.projectDiagnosticCount ?? 1},(_,index)=>({range,severity:1,message:options.projectDiagnosticCount?'project problem '+index:'project problem'}))}]});return;}
  }
  if (options.requiredLanguageId && document?.languageId !== options.requiredLanguageId) {
    send({id:message.id,error:{code:-32602,message:'The document language id is unsupported'}});return;
  }
  if (message.method === 'textDocument/hover') reply(message.id, {contents:{kind:'markdown',value:document?.text || ''},range});
  if (message.method === 'textDocument/definition') reply(message.id, [{uri,range}]);
  if (message.method === 'textDocument/references') reply(message.id, options.referenceCount ? Array.from({length:options.referenceCount},(_,line)=>({uri,range:{start:{line,character:0},end:{line,character:1}}})) : [{uri,range}]);
  if (message.method === 'textDocument/documentSymbol') reply(message.id, [{name:'fixture',kind:12,range,selectionRange:range}]);
  if (message.method === 'textDocument/rename') {
    const edit={range:{start:{line:0,character:0},end:{line:0,character:3}},newText:message.params.newName};
    if(message.params.newName==='orderedInserts') {reply(message.id,{changes:{[uri]:[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'x'},{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'x'}]}});return;}
    const target=message.params.newName==='outside'?new URL('../outside.ts',uri).href:new URL('b.ts',uri).href;
    reply(message.id,{documentChanges:[{textDocument:{uri,version:null},edits:[edit]}, {textDocument:{uri:target,version:null},edits:message.params.newName==='overlap'?[edit,edit]:[edit]}]});
  }
  if (message.method === 'textDocument/prepareRename') reply(message.id,{range:{start:{line:0,character:0},end:{line:0,character:3}},placeholder:'old'});
  if (message.method === 'textDocument/codeAction') {
    if(options.requireDiagnosticContext&&!message.params.context?.diagnostics?.some(diagnostic=>diagnostic.code===2322&&diagnostic.data?.fixToken==='native-fixture')){reply(message.id,[]);return;}
    const edit=options.commandDirectEdits?{documentChanges:[{textDocument:{uri:new URL('b.ts',uri).href,version:null},edits:[{range:{start:{line:0,character:0},end:{line:0,character:3}},newText:'mid'}]},{kind:'rename',oldUri:uri,newUri:new URL('moved.ts',uri).href}]}:undefined;
    reply(message.id,[{title:'Fix fixture',kind:'quickfix',...(edit?{edit}:{}),command:{title:'Fix fixture',command:'fixture.fix',arguments:[uri]}}]);
  }
  if (message.method === 'workspace/executeCommand') {
    if (options.delayCommand) {pending.set(message.id,message);return;}
    commandRequest=message;
    const target=new URL(options.refuseCommandEdit?'../outside.ts':'b.ts',message.params.arguments[0]).href;
    send({id:'server-edit',method:'workspace/applyEdit',params:{edit:{changes:{[target]:[{range:{start:{line:0,character:0},end:{line:0,character:3}},newText:'fixed'}]}}}});
  }
  if (message.method === 'textDocument/diagnostic') {
    if (externalDiagnosticMessage && options.failRefreshDiagnosticPath && uri?.endsWith('/'+options.failRefreshDiagnosticPath)) send({id:message.id,error:{code:-32000,message:'fixture refresh failed'}});
    else reply(message.id, {kind:'full',items:externalDiagnosticMessage || document?.text.includes('broken') ? [{range,severity:1,message:externalDiagnosticMessage || document.text,code:2322,source:'fixture',...(options.requireDiagnosticContext?{data:{fixToken:'native-fixture'},tags:[1]}:{})}] : []});
  }
};
const receive = (message, fromQueue = false) => {
  if (!fromQueue) record(message);
  if (message.id === 'registration' && !message.method) { registered = true; for (const item of queued.splice(0)) receive(item,true); return; }
  if (message.id === 'server-edit' && !message.method && commandRequest) {reply(commandRequest.id,message.result);commandRequest=undefined;return;}
  if (message.id === 'progress-create' && !message.method && progressRequest) {
    send({method:'$/progress',params:{token:progressRequest.token,value:{kind:'begin',title:'Loading fixture'}}});
    reply(progressRequest.id,null);progressRequest=undefined;return;
  }
  if (message.method === 'initialize') {
    options.rootUri=message.params.rootUri+'/';
    if (options.stallInitialize) return;
    if (options.failInitialize) { send({id:message.id,error:{code:-32000,message:'fixture initialization failed'}}); return; }
    reply(message.id,{capabilities:{positionEncoding:'utf-16',textDocumentSync:{openClose:true,change:options.syncKind ?? 2},hoverProvider:true,definitionProvider:true,referencesProvider:true,documentSymbolProvider:true,...(options.semanticEdits ? {renameProvider:{prepareProvider:true},codeActionProvider:true,executeCommandProvider:{commands:['fixture.fix']},workspace:{fileOperations:{willRename:{filters:[]},didRename:{filters:[]}}}}:{}),...(options.editingFeatures ? {completionProvider:{resolveProvider:true,triggerCharacters:['.']},signatureHelpProvider:{triggerCharacters:['('],retriggerCharacters:[',']},documentFormattingProvider:true,documentRangeFormattingProvider:true,codeActionProvider:{codeActionKinds:options.organizerGenericKind?['source']:['source.organizeImports.fixture'],resolveProvider:options.organizerNeedsResolve === true},typeDefinitionProvider:true,implementationProvider:true,documentHighlightProvider:true,selectionRangeProvider:true,inlayHintProvider:true,semanticTokensProvider:{legend:{tokenTypes:['variable'],tokenModifiers:[]},range:options.semanticRange !== false,full:options.semanticDelta === false ? true : {delta:true}},callHierarchyProvider:true,workspaceSymbolProvider:true}:{}),...(options.diagnosticsMode === 'push' ? {} : {diagnosticProvider:{interFileDependencies:true,workspaceDiagnostics:options.editingFeatures === true}})}}); return;
  }
  if (message.method === 'initialized') { send({id:'registration',method:'client/registerCapability',params:{registrations:options.watching === false ? [] : [{id:'files',method:'workspace/didChangeWatchedFiles',registerOptions:{watchers:[{globPattern:'**/*'}]}}]}}); return; }
  if (message.method === 'shutdown') {
    if (options.pushOnShutdown) for (const [uri,document] of documents) send({method:'textDocument/publishDiagnostics',params:{uri,version:document.version,diagnostics:[{range,severity:1,message:options.pushOnShutdown}]}});
    if (options.delayShutdown) pending.set(message.id,message);
    else reply(message.id,null);
    return;
  }
  if (message.method === 'exit') { process.exit(0); }
  if (!registered) { queued.push(message); return; }
  if (message.method === 'textDocument/didOpen') documents.set(message.params.textDocument.uri,message.params.textDocument);
  if (message.method === 'textDocument/didClose') documents.delete(uriOf(message));
  if (message.method === 'textDocument/didChange') {
    const previous=documents.get(uriOf(message));const change=message.params.contentChanges[0];
    if (previous) {const offset=p=>previous.text.split(/\r\n|\r|\n/).slice(0,p.line).reduce((a,l)=>a+l.length+1,0)+p.character;previous.text=change.range?previous.text.slice(0,offset(change.range.start))+change.text+previous.text.slice(offset(change.range.end)):change.text;previous.version=message.params.textDocument.version;}
  }
  if (message.method === 'workspace/didChangeWatchedFiles') {externalDiagnosticMessage=options.externalDiagnosticMessage;send({id:'refresh',method:'workspace/diagnostic/refresh'});}
  if (message.method === '$/cancelRequest') {const request=pending.get(message.params.id);if(request){pending.delete(message.params.id);send({id:request.id,error:{code:-32800,message:'RequestCancelled'}});}}
  if (message.method === 'fixture/release') {for(const [id,request] of pending){if(!message.params?.method||request.method===message.params.method){answer(request);pending.delete(id);}}}
  if (message.method === 'fixture/publishDiagnostics') send({method:'textDocument/publishDiagnostics',params:message.params});
  if (message.method === 'fixture/progress') {
    if (message.params.kind === 'begin') {progressRequest={id:message.id,token:message.params.token};send({id:'progress-create',method:'window/workDoneProgress/create',params:{token:message.params.token}});}
    else {send({method:'$/progress',params:{token:message.params.token,value:{kind:'end'}}});reply(message.id,null);}
  }
  if (message.method === 'fixture/barrier') reply(message.id,null);
  if (message.method === 'fixture/unsolicitedEdit') { commandRequest=message;send({id:'server-edit',method:'workspace/applyEdit',params:{edit:{changes:{[message.params.uri]:[{range,newText:'bad'}]}}}}); }
  if (message.method === 'workspace/willRenameFiles') {
    const target=new URL('b.ts',message.params.files[0].oldUri).href;
    reply(message.id,{changes:{[target]:[{range:{start:{line:0,character:0},end:{line:0,character:3}},newText:'updated'}]}});
  }
  if (message.method === 'workspace/executeCommand') answer(message);
  if ((message.method?.startsWith('textDocument/') || message.method?.startsWith('completionItem/') || message.method?.startsWith('callHierarchy/') || message.method?.startsWith('codeAction/') || ['workspace/symbol','workspace/diagnostic'].includes(message.method)) && message.id !== undefined) {
    if (options.crashOnHover && message.method === 'textDocument/hover') process.exit(2);
    if (options.delayMethod === message.method || (options.delayHover && message.method === 'textDocument/hover') || (options.delayDiagnostic && message.method === 'textDocument/diagnostic' && (!options.delayDiagnosticPath || uriOf(message)?.endsWith('/'+options.delayDiagnosticPath)))) pending.set(message.id,message);
    else answer(message);
  }
};
const uriOf=message=>message.params?.textDocument?.uri;
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);for(;;){const end=input.indexOf('\r\n\r\n');if(end<0)return;const length=Number(/Content-Length:\s*(\d+)/i.exec(input.subarray(0,end).toString())[1]);if(input.length<end+4+length)return;const body=input.subarray(end+4,end+4+length);input=input.subarray(end+4+length);receive(JSON.parse(body.toString()));}});
