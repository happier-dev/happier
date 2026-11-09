import { describe,expect,it } from 'vitest';
import type { SessionAccessGrantsListResponseV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import {createSessionAccessEditorState,reduceSessionAccessEditorState} from './sessionAccessEditorState';
const snapshot:SessionAccessGrantsListResponseV1={visibility:'self',owner:{kind:'account',accountId:'owner',name:'Owner',firstName:'Owner',lastName:null,username:null,avatarUrl:null},primaryTeamId:null,grants:[],effectiveAccess:{v:1,level:'view',sources:[],capabilities:{readTranscript:true,submitAgentInput:false,editSessionRecords:false,approveRuntimePermissions:false,manageAccess:false,managePermissionDelegation:false,managePublicLink:false,archiveSession:false,renameSession:false,assignResponsibility:false,stopSession:false,deleteSession:false}}};
const managerSnapshot:SessionAccessGrantsListResponseV1={...snapshot,visibility:'complete',
 effectiveAccess:{...snapshot.effectiveAccess,level:'admin',
  capabilities:{...snapshot.effectiveAccess.capabilities,manageAccess:true}}};
describe('access acknowledged state',()=>{
 it('retains acknowledged topology during refresh and failed removal, but clears it on access denial',()=>{
  let state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{type:'snapshot',scopeKey:'a',snapshot});
  state=reduceSessionAccessEditorState(state,{type:'operation',scopeKey:'a',key:'account:x',operation:{kind:'removing'}});
  expect(state.snapshot).toBe(snapshot);
  state=reduceSessionAccessEditorState(state,{type:'failed',scopeKey:'a',issue:{code:'network',message:'Offline',retryable:true}});
  expect(state.snapshot).toBe(snapshot);
  state=reduceSessionAccessEditorState(state,{type:'failed',scopeKey:'a',denied:true,issue:{code:'forbidden',message:'Denied',retryable:false}});
  expect(state.snapshot).toBeNull();expect(state.operations).toEqual({});
 });
 it('ignores late responses from a former Home or Account after resetting the mounted scope',()=>{
  const state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{type:'reset',scopeKey:'b'});
  const next=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot});
  expect(next.scopeKey).toBe('b');expect(next.snapshot).toBeNull();
 });
 it('settles an uncertain set only when the authoritative row matches its exact intent',()=>{
  const subject={kind:'account' as const,accountId:'recipient'};
  const intent={kind:'set' as const,mutation:{subject,accessLevel:'edit' as const,canApprovePermissions:false}};
  let state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{
   type:'operation',scopeKey:'a',key:'account:recipient',operation:{
    kind:'error',error:{code:'outcome_unknown',message:'Unknown',retryable:true},reconcileIntent:intent,
   },
  });
  state=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot:{...snapshot,visibility:'complete',grants:[{
   grant:{subject,accessLevel:'view',canApprovePermissions:false},
   principal:{kind:'account',accountId:'recipient',name:null,firstName:null,lastName:null,username:'recipient',avatarUrl:null},
   allowedTransitions:{accessLevels:['view','edit','admin'],canChangePermissionDelegation:true,canRemove:true},
  }]}});
  expect(state.operations['account:recipient']?.kind).toBe('error');

  state=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot:{...snapshot,visibility:'complete',grants:[{
   grant:{subject,accessLevel:'edit',canApprovePermissions:false},
   principal:{kind:'account',accountId:'recipient',name:null,firstName:null,lastName:null,username:'recipient',avatarUrl:null},
   allowedTransitions:{accessLevels:['view','edit','admin'],canChangePermissionDelegation:true,canRemove:true},
  }]}});
  expect(state.operations['account:recipient']).toBeUndefined();
 });
 it('settles an uncertain removal only after the authoritative row is absent',()=>{
  const subject={kind:'account' as const,accountId:'recipient'};
  const row={
   grant:{subject,accessLevel:'view' as const,canApprovePermissions:false},
   principal:{kind:'account' as const,accountId:'recipient',name:null,firstName:null,lastName:null,username:'recipient',avatarUrl:null},
   allowedTransitions:{accessLevels:['view' as const,'edit' as const,'admin' as const],canChangePermissionDelegation:true,canRemove:true},
  };
  let state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{
   type:'operation',scopeKey:'a',key:'account:recipient',operation:{
    kind:'error',error:{code:'outcome_unknown',message:'Unknown',retryable:true},
    reconcileIntent:{kind:'remove',subject},
   },
  });
  state=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot:{...snapshot,visibility:'complete',grants:[row]}});
  expect(state.operations['account:recipient']?.kind).toBe('error');
  state=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot});
  expect(state.operations['account:recipient']).toBeUndefined();
 });
 it('keeps discovered exceptions as the default view and replaces them only with a view the manager asked for',()=>{
  const row=(recipientAccountId:string)=>({
   recipientAccountId,envelopeState:'missing' as const,
   contentKey:{status:'available' as const,accountSigningPublicKey:'s',contentPublicKey:'c',contentPublicKeySignature:'g'},
  });
  let state=createSessionAccessEditorState('a');
  expect(state.recipients).toMatchObject({view:'exceptions',rows:[],loading:false});
  // Only a manager sees recipient rows at all, so discovery follows the authoritative snapshot.
  state=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot:managerSnapshot});
  // Discovery hands its exception rows straight to the default view: nothing was opened first.
  state=reduceSessionAccessEditorState(state,{type:'recipientsPage',scopeKey:'a',view:'exceptions',rows:[row('first')],nextCursor:'page-two',append:false});
  expect(state.recipients).toMatchObject({view:'exceptions',nextCursor:'page-two'});
  expect(state.recipients.rows.map((item)=>item.recipientAccountId)).toEqual(['first']);
  // An authoritative grant refresh keeps the last-known exceptions until discovery replaces them.
  state=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot:managerSnapshot});
  expect(state.recipients.rows.map((item)=>item.recipientAccountId)).toEqual(['first']);
  // Asking for everyone clears the rows it is about to replace, then pages within that view.
  state=reduceSessionAccessEditorState(state,{type:'recipientsLoading',scopeKey:'a',view:'all'});
  expect(state.recipients).toMatchObject({view:'all',rows:[],nextCursor:null,loading:true});
  state=reduceSessionAccessEditorState(state,{type:'recipientsPage',scopeKey:'a',view:'all',rows:[row('first')],nextCursor:'page-two',append:false});
  state=reduceSessionAccessEditorState(state,{type:'recipientsPage',scopeKey:'a',view:'all',rows:[row('second')],nextCursor:null,append:true});
  expect(state.recipients.rows.map((item)=>item.recipientAccountId)).toEqual(['first','second']);
  // A continuation page of a view no longer shown cannot append to the current one.
  state=reduceSessionAccessEditorState(state,{type:'recipientsPage',scopeKey:'a',view:'exceptions',rows:[row('late')],nextCursor:null,append:true});
  expect(state.recipients.rows.map((item)=>item.recipientAccountId)).toEqual(['first','second']);
  // An authoritative refresh discards the open all-people view; discovery follows it.
  state=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot:managerSnapshot});
  expect(state.recipients).toMatchObject({view:'exceptions',rows:[],nextCursor:null});
 });
 it('lets a recipient page refresh the settled summary without overwriting a running or failed pass',()=>{
  const row=(recipientAccountId:string)=>({
   recipientAccountId,envelopeState:'missing' as const,
   contentKey:{status:'available' as const,accountSigningPublicKey:'s',contentPublicKey:'c',contentPublicKeySignature:'g'},
  });
  const summary={prepared:1,pending:2,invalid:0,recipientKeyUnavailable:0,total:3};
  let state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{type:'snapshot',scopeKey:'a',snapshot:managerSnapshot});
  state=reduceSessionAccessEditorState(state,{type:'preparing',scopeKey:'a',preparedCount:1,actionableTotal:4});
  // Opening `Show all people` mid-pass is a collection read, not an operation
  // transition: the progress the Home committed stays on screen.
  state=reduceSessionAccessEditorState(state,{type:'prepared',scopeKey:'a',origin:'discovery',
   preparation:{kind:'settled',status:'incomplete',summary}});
  state=reduceSessionAccessEditorState(state,{type:'recipientsPage',scopeKey:'a',view:'all',rows:[row('first')],nextCursor:null,append:false});
  expect(state.preparation).toMatchObject({kind:'preparing',preparedCount:1,actionableTotal:4});

  // The pass's own outcome is the transition that settles it.
  state=reduceSessionAccessEditorState(state,{type:'prepared',scopeKey:'a',origin:'pass',
   preparation:{kind:'settled',status:'incomplete',summary}});
  expect(state.preparation).toMatchObject({kind:'settled',status:'incomplete'});

  // A failed pass keeps its recovery reason through a later collection page.
  state=reduceSessionAccessEditorState(state,{type:'preparationFailed',scopeKey:'a',origin:'pass',
   error:{code:'network',message:'Offline',retryable:true}});
  state=reduceSessionAccessEditorState(state,{type:'prepared',scopeKey:'a',origin:'discovery',
   preparation:{kind:'settled',status:'complete',summary}});
  expect(state.preparation).toMatchObject({kind:'failed',origin:'pass'});
 });
 it('drops manager-only recipient diagnostics the moment the authoritative snapshot says this viewer no longer manages access',()=>{
  const row=(recipientAccountId:string)=>({
   recipientAccountId,envelopeState:'missing' as const,
   contentKey:{status:'available' as const,accountSigningPublicKey:'s',contentPublicKey:'c',contentPublicKeySignature:'g'},
  });
  let state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{type:'snapshot',scopeKey:'a',snapshot:managerSnapshot});
  state=reduceSessionAccessEditorState(state,{type:'prepared',scopeKey:'a',origin:'discovery',preparation:{kind:'settled',status:'incomplete',summary:null}});
  state=reduceSessionAccessEditorState(state,{type:'recipientsPage',scopeKey:'a',view:'exceptions',rows:[row('first')],nextCursor:null,append:false});
  expect(state.recipients.rows).toHaveLength(1);

  // The same Session, re-read after this manager was downgraded to a reader.
  state=reduceSessionAccessEditorState(state,{type:'snapshot',scopeKey:'a',snapshot});
  expect(state.recipients).toMatchObject({view:'exceptions',rows:[],nextCursor:null});
  expect(state.preparation.kind).toBe('idle');

  // A manager-era page that settles after the downgrade cannot restore them.
  state=reduceSessionAccessEditorState(state,{type:'recipientsPage',scopeKey:'a',view:'exceptions',rows:[row('late')],nextCursor:null,append:false});
  state=reduceSessionAccessEditorState(state,{type:'prepared',scopeKey:'a',origin:'discovery',preparation:{kind:'settled',status:'incomplete',summary:null}});
  expect(state.recipients.rows).toEqual([]);
  expect(state.preparation.kind).toBe('idle');
 });
 it('retains a device-key stop through diagnostic refresh and clears it only for a new pass',()=>{
  let state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{type:'snapshot',scopeKey:'a',snapshot:managerSnapshot});
  state=reduceSessionAccessEditorState(state,{type:'prepared',scopeKey:'a',origin:'manual',
   preparation:{kind:'settled',status:'session_data_key_unavailable',summary:null}});
  state=reduceSessionAccessEditorState(state,{type:'prepared',scopeKey:'a',origin:'discovery',
   preparation:{kind:'settled',status:'incomplete',summary:{prepared:0,pending:1,invalid:0,recipientKeyUnavailable:0}}});
  expect(state.preparation).toMatchObject({kind:'settled',status:'session_data_key_unavailable'});
  state=reduceSessionAccessEditorState(state,{type:'preparing',scopeKey:'a',preparedCount:0,actionableTotal:null});
  expect(state.preparation.kind).toBe('preparing');
 });
 it('keeps pass progress through a failed diagnostic, but permits discovery-only failure recovery',()=>{
  let state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{type:'snapshot',scopeKey:'a',snapshot:managerSnapshot});
  const error={code:'network',message:'Offline',retryable:true};
  state=reduceSessionAccessEditorState(state,{type:'preparing',scopeKey:'a',preparedCount:2,actionableTotal:4});
  state=reduceSessionAccessEditorState(state,{type:'preparationFailed',scopeKey:'a',origin:'discovery',error});
  expect(state.preparation).toMatchObject({kind:'preparing',preparedCount:2,actionableTotal:4});
  state=reduceSessionAccessEditorState(createSessionAccessEditorState('a'),{type:'snapshot',scopeKey:'a',snapshot:managerSnapshot});
  state=reduceSessionAccessEditorState(state,{type:'preparationFailed',scopeKey:'a',origin:'discovery',error});
  state=reduceSessionAccessEditorState(state,{type:'prepared',scopeKey:'a',origin:'discovery',
   preparation:{kind:'settled',status:'complete',summary:{prepared:1,pending:0,invalid:0,recipientKeyUnavailable:0}}});
  expect(state.preparation).toMatchObject({kind:'settled',status:'complete'});
 });
});
