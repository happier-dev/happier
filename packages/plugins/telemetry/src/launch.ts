import { createCanonicalJsonSigningInput, type PluginWorktreeDatabaseMemberV1 } from '@happier-dev/plugin-sdk';
import { parseDatabaseConnectionUrl } from '@happier-dev/databases/connection';
import { startPostgresProxy } from './proxy.js';
import type { CapturePartition, CaptureRuntime } from './runtime.js';
import type { AutomationDatabaseFindingSubjectV1 } from '@happier-dev/plugin-sdk/events';
import type { WorktreeFindingSubjects } from './telemetry/databaseFindings.js';

/** Eligibility/spans come from the dialect, private original values from A and ports from B. */
export type CaptureUrlOffer = Readonly<{
 name: string; original: string; upstream: Readonly<{host:string;port:number}>;
 hostSpan: Readonly<{start:number;end:number}>; assignedPort:number;
 databaseMember?: PluginWorktreeDatabaseMemberV1;
}>;
type Proxy = Awaited<ReturnType<typeof startPostgresProxy>>;
type Receiver = Awaited<ReturnType<CaptureRuntime['acquireReceiver']>>;
type ProxySlot = {proxy:Proxy; users:Set<symbol>; recorders:Set<symbol>; attribution:{ binding?: { database: string; memberKey: string } }};
type ReceiverSlot = {receiver:Receiver; users:Map<symbol, WorktreeFindingSubjects | undefined>};
type WorktreeFindingDelivery = (traceIds: readonly string[], subjects: WorktreeFindingSubjects) => void;
// These are actual live socket references, never persisted assignments or a port allocator.
const proxySlots = new WeakMap<CaptureRuntime,Map<string,Promise<ProxySlot>>>();
const receiverSlots = new WeakMap<CaptureRuntime,Map<string,Promise<ReceiverSlot>>>();
function slots<T>(owner:WeakMap<CaptureRuntime,Map<string,T>>,runtime:CaptureRuntime) {
 let result=owner.get(runtime);if(!result){result=new Map();owner.set(runtime,result);}return result;
}
type LocalPartition = Required<Pick<CapturePartition, 'partition' | 'physicalRootIdentity'>>;
async function acquireProxy(runtime:CaptureRuntime,context:LocalPartition,offer:CaptureUrlOffer) {
 const { partition } = context;
 const active=slots(proxySlots,runtime),key=JSON.stringify([partition,offer.assignedPort,offer.upstream]);
 const database = offer.databaseMember && parseDatabaseConnectionUrl(offer.original).database;
 const binding = database && offer.databaseMember
  ? { database, memberKey: createCanonicalJsonSigningInput(offer.databaseMember) }
  : undefined;
 let pending=active.get(key);
 if(!pending){
  const attribution: ProxySlot['attribution'] = { binding };
  pending=startPostgresProxy({listenHost:'127.0.0.1',listenPort:offer.assignedPort,upstream:offer.upstream,
   onObservation: (observation, observedDatabase) => {
    const selected = attribution.binding;
    runtime.observeWire(observation, context, selected && observedDatabase === selected.database ? selected.memberKey : undefined);
   },
   onCoverage:coverage=>{ if(coverage.reason !== 'cancel') runtime.recordCoverage(partition,coverage.reason,context.physicalRootIdentity); },
  }).then(proxy=>({proxy,users:new Set<symbol>(),recorders:new Set<symbol>(),attribution}));
  active.set(key,pending);
  void pending.catch(()=>{if(active.get(key)===pending)active.delete(key);});
 }
 const slot=await pending,token=Symbol();
 // A shared listener can keep live connections after either lease ends.
 const current = slot.attribution.binding;
 if (current?.memberKey !== binding?.memberKey || current?.database !== binding?.database) slot.attribution.binding = undefined;
 slot.users.add(token);slot.recorders.add(token);slot.proxy.setRecording(true);
 let released:Promise<void>|undefined;
 const stopRecording=()=>{slot.recorders.delete(token);if(!slot.recorders.size)slot.proxy.setRecording(false);};
 return {port:slot.proxy.port,stopRecording,release(){
  released??=(async()=>{stopRecording();slot.users.delete(token);if(!slot.users.size){if(active.get(key)===pending)active.delete(key);await slot.proxy.stop();}})();return released;
 }};
}
async function acquireReceiver(runtime: CaptureRuntime, context: LocalPartition, port: number,
 subjects: WorktreeFindingSubjects | undefined, deliver: WorktreeFindingDelivery | undefined) {
 const active=slots(receiverSlots,runtime),key=JSON.stringify([context.partition,port]);
 let pending=active.get(key);
 if (!pending) {
  const users = new Map<symbol, WorktreeFindingSubjects | undefined>();
  pending = runtime.acquireReceiver({ port, context, ...(deliver && { onTraceBatchCommitted(_context, traceIds) {
   let admitted: Map<string, AutomationDatabaseFindingSubjectV1> | undefined;
   for (const subjects of users.values()) {
    if (!subjects) continue;
    admitted ??= new Map();
    for (const [member, subject] of subjects) admitted.set(member, subject);
   }
   if (admitted) deliver(traceIds, admitted);
  } }) }).then(receiver => ({ receiver, users }));
  active.set(key, pending);
  void pending.catch(() => { if (active.get(key) === pending) active.delete(key); });
 }
 const slot=await pending,token=Symbol();slot.users.set(token, subjects);let released:Promise<void>|undefined;
 return {endpoint:slot.receiver.endpoint,release(){released??=(async()=>{slot.users.delete(token);if(!slot.users.size){if(active.get(key)===pending)active.delete(key);await slot.receiver.release();}})();return released;}};
}
/** A consumes these prepared values; this function never composes an environment. */
export async function bindLocalCapture(input: LocalPartition & {
 enabled: boolean; runtime: CaptureRuntime; urls: readonly CaptureUrlOffer[]; otlpPort?: number; signal: AbortSignal;
 onBindingStart?(): void;
 findingSubjects?: WorktreeFindingSubjects;
 onWorktreeTracesCommitted?: WorktreeFindingDelivery;
}) {
 const context = { partition: input.partition, physicalRootIdentity: input.physicalRootIdentity };
 const replacements:Record<string,string>={},proxies:Awaited<ReturnType<typeof acquireProxy>>[]=[];
 let receiver:Awaited<ReturnType<typeof acquireReceiver>>|undefined,released:Promise<void>|undefined;
 const failures:{name:string;code:string}[]=[];
 function release():Promise<void>{
  released??=(async()=>{input.signal.removeEventListener('abort',onAbort);await Promise.all([...proxies.map(proxy=>proxy.release()),receiver?.release()]);})();return released;
 }
 function onAbort(){void release();}
 const unavailable=(name:string,error:unknown)=>failures.push({name,code:error!==null&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'action_failed'});
 if(input.enabled&&!input.signal.aborted){
  if (input.urls.length || input.otlpPort !== undefined) input.onBindingStart?.();
  for(const offer of input.urls){try{
   const proxy=await acquireProxy(input.runtime,context,offer);proxies.push(proxy);
   replacements[offer.name]=offer.original.slice(0,offer.hostSpan.start)+`127.0.0.1:${proxy.port}`+offer.original.slice(offer.hostSpan.end);
  }catch(error){unavailable(offer.name,error);}}
  if(input.otlpPort!==undefined){try{receiver=await acquireReceiver(input.runtime,context,input.otlpPort,input.findingSubjects,input.onWorktreeTracesCommitted);}catch(error){unavailable('otlp',error);}}
  input.signal.addEventListener('abort',onAbort,{once:true});if(input.signal.aborted)await release();
 }
 return {replacements:input.signal.aborted?{}:replacements,endpoint:input.signal.aborted?undefined:receiver?.endpoint,failures,
  async stopRecording(){for(const proxy of proxies)proxy.stopRecording();await receiver?.release();receiver=undefined;},release};
}
