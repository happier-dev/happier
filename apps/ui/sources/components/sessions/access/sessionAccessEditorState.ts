import type {
    PrincipalRefV1} from '@happier-dev/protocol/teams/principal';
import type {
    SessionAccessGrantsListResponseV1} from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import type {
    SessionDataKeyEnvelopeItemV1,
    SessionDataKeyEnvelopeSummaryV1} from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import type {
    SessionGrantMutationV1,
} from '@happier-dev/protocol/sessions/access/sessionAccessGrantV1';
import type { CurrentSessionPreparationOutcome } from '@/sync/encryption/prepareCurrentSessionDataKeyEnvelopes';
import type { SessionAccessEncryptionRecipientsView, SessionAccessGrantOperationModel, SessionAccessUiError } from './sessionAccessEditorTypes';
import { sessionAccessSubjectKey } from './projectSessionAccessEditorSnapshot';

/**
 * What the recipient-key owner last reported about this Session's audience.
 *
 * It is deliberately one Session-scoped fact rather than a per-grant census: the
 * only aggregate any producer publishes is the server's own summary for the whole
 * Session, and a Team row's member readiness is not something this editor may
 * recompute from the rows it happens to hold.
 *
 * It is also kept apart from `operations` so that a failed key preparation can
 * never re-label an acknowledged grant mutation as failed.
 */
export type SessionAccessEncryptionSettledStatus =
    /** Plain Session: no recipient key material exists or is needed. */
    | 'not_required'
    | 'complete'
    | 'incomplete'
    | 'scope_changed'
    /** This device holds no transferable Session key, so it cannot prepare anyone. */
    | 'session_data_key_unavailable';

export type SessionAccessEncryptionPreparation =
    | Readonly<{kind:'idle'}>
    | Readonly<{
        kind:'preparing';
        /** Committed by the Home, never a locally sealed count. */
        preparedCount:number;
        /** The Home's authoritative actionable total, or null before the first page. */
        actionableTotal:number|null;
    }>
    | Readonly<{
        kind:'settled';
        status:SessionAccessEncryptionSettledStatus;
        summary:SessionDataKeyEnvelopeSummaryV1|null;
    }>
    | Readonly<{
        kind:'failed';
        /**
         * Which read failed. Only a pass that followed a committed mutation may say
         * the access was saved; a failed opening discovery proves nothing about a save,
         * and a pass the manager started themselves saved nothing at all.
         */
        origin:SessionAccessEncryptionReadOrigin;
        error:SessionAccessUiError;
    }>;
/**
 * Which read produced an encryption observation.
 *
 * `discovery` is a collection read — the opening one, a `Show all people` page, or a
 * re-read after a wake. `pass` is the preparation run that followed a committed grant
 * mutation, and `manual` is the same run started by the manager with no mutation behind
 * it. The distinction is the same one the failure copy already made; it is written once
 * here so both the copy and the reducer's admission rule read the same fact.
 */
export type SessionAccessEncryptionReadOrigin='discovery'|'pass'|'manual';
const IDLE_PREPARATION: SessionAccessEncryptionPreparation = Object.freeze({kind:'idle'});

/**
 * Projects one settled server or pass observation into the editor's encryption state.
 *
 * Discovery and a finished pass are the same fact from the manager's point of view —
 * what the Home currently reports about this Session's audience — so they share one
 * representation instead of two similar-but-different ones.
 */
export function settledEncryptionFromOutcome(
    outcome:CurrentSessionPreparationOutcome,
):Extract<SessionAccessEncryptionPreparation,{kind:'settled'}> {
    return {kind:'settled',status:outcome.status,summary:outcome.summary};
}

export function settledEncryptionFromCollection(
    summary:SessionDataKeyEnvelopeSummaryV1|null,
):Extract<SessionAccessEncryptionPreparation,{kind:'settled'}> {
    if(!summary)return {kind:'settled',status:'not_required',summary:null};
    const remaining=summary.pending+summary.invalid+summary.recipientKeyUnavailable;
    return {kind:'settled',status:remaining===0?'complete':'incomplete',summary};
}

/**
 * The rows beneath the aggregate.
 *
 * The default `exceptions` view is the discovery page itself: the exception rows
 * the aggregate counts, handed over without a second request. `all` is the
 * explicit diagnostic the manager asked for. Either is a view, not a store: it
 * keeps the resource's own cursor, an authoritative refresh returns it to the
 * discovered exceptions, and a page from a view no longer shown is dropped, so it
 * can never become a second stale readiness authority.
 */
export type SessionAccessEncryptionRecipientsState = Readonly<{
    view:SessionAccessEncryptionRecipientsView;
    rows:readonly SessionDataKeyEnvelopeItemV1[];
    nextCursor:string|null;
    loading:boolean;
    error:SessionAccessUiError|null;
}>;
const DISCOVERED_EXCEPTIONS: SessionAccessEncryptionRecipientsState = Object.freeze({
    view:'exceptions',rows:[],nextCursor:null,loading:false,error:null,
});

type SessionAccessGrantReconciliationIntent =
    | Readonly<{kind:'set';mutation:SessionGrantMutationV1}>
    | Readonly<{kind:'remove';subject:PrincipalRefV1}>;
type SessionAccessGrantOperationState = Exclude<SessionAccessGrantOperationModel, { kind: 'error' }>
    | Readonly<{
        kind:'error';
        error:SessionAccessUiError;
        reconcileIntent?:SessionAccessGrantReconciliationIntent;
    }>;

export type SessionAccessEditorState = Readonly<{
    scopeKey: string;
    snapshot: SessionAccessGrantsListResponseV1 | null;
    refreshing: boolean;
    issue: SessionAccessUiError | null;
    operations: Readonly<Record<string, SessionAccessGrantOperationState>>;
    confirmingRemoval: string | null;
    preparation: SessionAccessEncryptionPreparation;
    recipients: SessionAccessEncryptionRecipientsState;
}>;
export type SessionAccessEditorEvent =
    | Readonly<{type:'reset';scopeKey:string}>
    | Readonly<{type:'refresh';scopeKey:string}>
    | Readonly<{type:'snapshot';scopeKey:string;snapshot:SessionAccessGrantsListResponseV1}>
    | Readonly<{type:'failed';scopeKey:string;issue:SessionAccessUiError;denied?:boolean}>
    | Readonly<{type:'operation';scopeKey:string;key:string;operation:SessionAccessGrantOperationState}>
    | Readonly<{type:'confirm';scopeKey:string;key:string|null}>
    | Readonly<{type:'preparing';scopeKey:string;preparedCount:number;actionableTotal:number|null}>
    | Readonly<{type:'prepared';scopeKey:string;origin:SessionAccessEncryptionReadOrigin;preparation:SessionAccessEncryptionPreparation}>
    | Readonly<{type:'preparationFailed';scopeKey:string;origin:SessionAccessEncryptionReadOrigin;error:SessionAccessUiError}>
    | Readonly<{type:'recipientsLoading';scopeKey:string;view:SessionAccessEncryptionRecipientsView}>
    | Readonly<{type:'recipientsPage';scopeKey:string;view:SessionAccessEncryptionRecipientsView;rows:readonly SessionDataKeyEnvelopeItemV1[];nextCursor:string|null;append:boolean}>
    | Readonly<{type:'recipientsFailed';scopeKey:string;view:SessionAccessEncryptionRecipientsView;error:SessionAccessUiError}>;
export function createSessionAccessEditorState(scopeKey:string):SessionAccessEditorState {
    return {scopeKey,snapshot:null,refreshing:false,issue:null,operations:{},confirmingRemoval:null,
        preparation:IDLE_PREPARATION,recipients:DISCOVERED_EXCEPTIONS};
}

function snapshotProvesMutationIntent(
    snapshot:SessionAccessGrantsListResponseV1,
    intent:SessionAccessGrantReconciliationIntent,
):boolean {
    const subject=intent.kind==='set'?intent.mutation.subject:intent.subject;
    const row=snapshot.grants.find((candidate)=>sessionAccessSubjectKey(candidate.grant.subject)===sessionAccessSubjectKey(subject));
    if(intent.kind==='remove')return row===undefined;
    return row?.grant.accessLevel===intent.mutation.accessLevel
        && row.grant.canApprovePermissions===intent.mutation.canApprovePermissions;
}

function reconcileOperations(
    operations:SessionAccessEditorState['operations'],
    snapshot:SessionAccessGrantsListResponseV1,
):SessionAccessEditorState['operations'] {
    let next:Record<string,SessionAccessGrantOperationState>|null=null;
    for(const [key,operation] of Object.entries(operations)){
        if(operation.kind!=='error'||!operation.reconcileIntent
            ||!snapshotProvesMutationIntent(snapshot,operation.reconcileIntent))continue;
        next??={...operations};
        delete next[key];
    }
    return next??operations;
}

/**
 * Preparation and recipient rows are the key owner's answer about the Session's
 * whole audience, which only a manager may read. They are therefore admitted only
 * while the current authoritative snapshot still says this viewer manages access:
 * a manager-era page that settles after a downgrade is as inadmissible as one that
 * arrives after an outright denial.
 */
function isManagerOnlyDiagnosticEvent(type:SessionAccessEditorEvent['type']):boolean {
    return type==='preparing'||type==='prepared'||type==='preparationFailed'
        ||type==='recipientsLoading'||type==='recipientsPage'||type==='recipientsFailed';
}

function managesAccess(snapshot:SessionAccessGrantsListResponseV1|null):boolean {
    return snapshot?.effectiveAccess.capabilities.manageAccess === true;
}

export function reduceSessionAccessEditorState(state:SessionAccessEditorState,event:SessionAccessEditorEvent):SessionAccessEditorState {
    if (event.type === 'reset') return createSessionAccessEditorState(event.scopeKey);
    if (event.scopeKey !== state.scopeKey) return state;
    if (isManagerOnlyDiagnosticEvent(event.type) && !managesAccess(state.snapshot)) return state;
    switch (event.type) {
        case 'refresh': return {...state,refreshing:true,issue:null};
        // An authoritative grant refresh can have changed the audience, so an open
        // all-people view is discarded rather than left describing the previous one;
        // the last discovered exceptions stay until discovery replaces them.
        // Losing `manageAccess` is the same privacy fact as an outright denial for the
        // audience detail: the authoritative answer now says this viewer may not read
        // it, so it goes with the snapshot that proved it rather than lingering.
        case 'snapshot': return {...state,snapshot:event.snapshot,refreshing:false,issue:null,
            ...(managesAccess(event.snapshot)
                ? {recipients:state.recipients.view==='all'?DISCOVERED_EXCEPTIONS:state.recipients}
                : {preparation:IDLE_PREPARATION,recipients:DISCOVERED_EXCEPTIONS}),
            operations:reconcileOperations(state.operations,event.snapshot)};
        // Losing access clears the audience detail this viewer may no longer see,
        // including whatever the key owner last said about its recipients.
        case 'failed': return {...state,refreshing:false,issue:event.issue,...(event.denied ? {snapshot:null,operations:{},confirmingRemoval:null,preparation:IDLE_PREPARATION,recipients:DISCOVERED_EXCEPTIONS} : {})};
        case 'operation': return {...state,operations:{...state.operations,[event.key]:event.operation}};
        case 'confirm': return {...state,confirmingRemoval:event.key};
        case 'preparing': return {...state,preparation:{kind:'preparing',preparedCount:event.preparedCount,actionableTotal:event.actionableTotal}};
        // A collection page reports what the Home currently holds; it is not an
        // operation transition. It may settle an idle or already-settled section, but a
        // running pass's committed progress and a failed pass's recovery reason both
        // belong to the operation and are replaced only by that operation's own result.
        // A device-key stop is also operation-owned: diagnostics cannot turn it into a
        // misleading incomplete/failed discovery state before the user retries.
        case 'prepared': return event.origin==='discovery'
            && (state.preparation.kind==='preparing'
                || (state.preparation.kind==='failed' && state.preparation.origin!=='discovery')
                || (state.preparation.kind==='settled' && state.preparation.status==='session_data_key_unavailable'))
            ? state
            : {...state,preparation:event.preparation};
        case 'preparationFailed': return event.origin==='discovery'
            && (state.preparation.kind==='preparing'
                || (state.preparation.kind==='settled' && state.preparation.status==='session_data_key_unavailable'))
            ? state
            : {...state,preparation:{kind:'failed',origin:event.origin,error:event.error}};
        // Asking for a different view clears the rows it is about to replace; a
        // continuation within the current view keeps them while the page loads.
        case 'recipientsLoading': return {...state,recipients:event.view===state.recipients.view
            ? {...state.recipients,loading:true,error:null}
            : {view:event.view,rows:[],nextCursor:null,loading:true,error:null}};
        // A page of a view no longer shown cannot append to the current one.
        case 'recipientsPage': return event.view===state.recipients.view
            ? {...state,recipients:{view:event.view,
                rows:event.append?[...state.recipients.rows,...event.rows]:event.rows,
                nextCursor:event.nextCursor,loading:false,error:null}}
            : state;
        case 'recipientsFailed': return event.view===state.recipients.view
            ? {...state,recipients:{...state.recipients,loading:false,error:event.error}}
            : state;
    }
}
