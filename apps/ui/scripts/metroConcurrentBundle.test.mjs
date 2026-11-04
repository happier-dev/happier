import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer,get} from 'node:http';
const require=createRequire(import.meta.url);
const Server=require('metro/private/Server').default;
test('concurrent matching web responses share construction, with fresh subsequent reads and retry after failure',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'expo-storm-contract-'));let metro,http;
 try{
  writeFileSync(path.join(root,'entry.js'),'globalThis.stormValue = 1;');
  const config=await require('metro-config').getDefaultConfig(root);
  config.watchFolders=[root,path.dirname(require.resolve('metro-runtime/package.json'))];config.maxWorkers=1;
  config.resolver.nodeModulesPaths=[path.resolve(import.meta.dirname,'../../../node_modules')];
  config.resolver.useWatchman=false;config.cacheStores=[];config.fileMapCacheDirectory=path.join(root,'cache');mkdirSync(config.fileMapCacheDirectory);
  config.reporter={update(){}};
  const base=require('metro/private/DeltaBundler/Serializers/baseJSBundle').default;
  const toString=require('metro/private/lib/bundleToString').default;
  let constructions=0,fail=false;
  // An actual async serializer extension reads its authored source annotation.
  // This OS read keeps warm/failing constructions overlapping as well as cold ones.
  config.serializer.customSerializer=async (...args)=>{constructions++;const annotation=await readFile(path.join(root,'entry.js'),'utf8');if(fail)throw new Error('fixture serializer failure');return toString(base(...args)).code+'\n// '+annotation;};
  metro=new Server(config,{watch:false});
  http=createServer((req,res)=>{void metro.processRequest(req,res,()=>{res.writeHead(404);res.end();});});
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  // This private fixture Metro serves one five-word module, never shared Expo.
  const request=(suffix='',{platform='web',dev=true,headers={}}={})=>new Promise((resolve,reject)=>{get({hostname:'127.0.0.1',port:http.address().port,path:`/entry.bundle?platform=${platform}&dev=${dev}&minify=false`+suffix,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));res.on('error',reject);}).on('error',reject);});
  const first=await Promise.all(Array.from({length:3},()=>request()));
  console.log(JSON.stringify({responses:first.map(r=>({status:r.status,error:r.status!==200?JSON.parse(r.body).message:null}))}));
  assert.ok(first.every(r=>r.status===200&&/stormValue\s*=\s*1/.test(r.body)));
  console.log(JSON.stringify({requests:3,constructions}));
  assert.equal(constructions,1,'three concurrent identical responses must construct one bundle');
  assert.equal(new Set(first.map(r=>r.body)).size,1);
  const before=constructions;
  await request();assert.equal(constructions,before+1,'settled results are not cached');
  const variations=await Promise.all([request('&modulesOnly=true'),request('&runModule=false')]);
  assert.ok(variations.every(r=>r.status===200));assert.notEqual(variations[0].body,variations[1].body,'different serializer options retain distinct output');
  assert.equal(constructions,before+3);
  fail=true;const failureStart=constructions;const failures=await Promise.all([request(),request(),request()]);
  assert.ok(failures.every(r=>r.status===500));assert.equal(constructions,failureStart+1);
  fail=false;assert.equal((await request()).status,200);assert.equal(constructions,failureStart+2,'a failed construction releases its in-flight entry');
  const negotiationStart=constructions;
  const negotiated=await Promise.all([request(),request('',{headers:{'if-modified-since':first[0].headers['last-modified']}})]);
  assert.deepEqual(negotiated.map(r=>r.status),[200,304],'shared construction preserves each response negotiation');
  assert.equal(constructions,negotiationStart+1);
  for(const options of [{platform:'ios'},{dev:false}]){
   const bypassStart=constructions;
   const responses=await Promise.all([request('',options),request('',options)]);
   assert.ok(responses.every(r=>r.status===200));
   assert.equal(constructions,bypassStart+2,'native and production bundles retain separate constructions');
  }
 }finally{if(http)await new Promise(r=>http.close(r));if(metro)await metro.end();rmSync(root,{recursive:true,force:true});}
});
