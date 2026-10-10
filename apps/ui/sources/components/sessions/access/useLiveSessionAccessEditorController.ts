import * as React from 'react';
import type { PrincipalRefV1, SessionGrantMutationV1 } from '@happier-dev/protocol';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { createSessionAccessClient, SessionAccessApiError, SessionAccessApprovalPendingError } from '@/sync/api/session/sessionAccessApi';
import { readSessionDataKeyEnvelopeCollectionPage, prepareSessionDataKeyEnvelopesDetached } from '@/sync/api/session/sessionDataKeyEnvelopesApi';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { projectSessionAccessEditorSnapshot, sessionAccessSubjectKey } from './projectSessionAccessEditorSnapshot';
import { sessionAccessGrantMutation } from './sessionAccessGrantMutation';
import { projectSessionAccessEncryptionSection } from './projectSessionAccessEncryptionSection';
import { projectSessionAccessContextChange } from './projectSessionAccessContextChange';
import {
    createSessionAccessEditorState,
    reduceSessionAccessEditorState,
    settledEncryptionFromCollection,
    type SessionAccessEncryptionReadOrigin,
    settledEncryptionFromOutcome,
} from './sessionAccessEditorState';
import { useSessionAccessDirectory, type SessionAccessDirectoryTeamContext } from './useSessionAccessDirectory';
import { useSessionAccessTeamRecipientLabels } from './useSessionAccessTeamRecipientLabels';
import type {
    SessionAccessEditorActions,
    SessionAccessEditorController,
    SessionAccessEncryptionRecipientsView,
    SessionAccessUiError,
} from './sessionAccessEditorTypes';
import { presentSessionAccessFailure } from './presentSessionAccessFailure';
import { useSessionAccessApprovalHold } from './useSessionAccessApprovalHold';
import { migrateSessionForSharing } from './migrateSessionForSharing';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';

/** Mounted exact-scope grant state; acknowledged server rows remain visible until refreshed. */
export function useLiveSessionAccessEditorController(input: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    /** The Session's persisted metadata layout as the host's projection knows it; absent when unknown. */
    metadataLayoutVersion?: number | null;
}>): SessionAccessEditorController {
    const availability = useSessionCollaborationAvailability(input.scope.serverId);
    const viewerProfile = useShareViewerProfile(input.scope);
    const scopeKey = `${serverAccountScopeKeySuffix(input.scope)}:${input.sessionId}:${availability}`;
    const [state, dispatch] = React.useReducer(reduceSessionAccessEditorState,scopeKey,createSessionAccessEditorState);
    const [query,setQuery] = React.useState('');
    const [directoryRevision,setDirectoryRevision] = React.useState(0);
    const [pendingContextTeamId, setPendingContextTeamId] = React.useState<string | null | undefined>(undefined);
    const currentScope = React.useRef(scopeKey);
    currentScope.current = scopeKey;
    const lifetime = React.useMemo(()=>({current:true}),[scopeKey]);
    const client = React.useMemo(()=>createSessionAccessClient({
        scope:{serverId:input.scope.serverId,accountId:input.scope.accountId},sessionId:input.sessionId,
        availability,isCurrent:()=>lifetime.current && currentScope.current===scopeKey,
    }),[availability,input.scope.serverId,input.scope.accountId,input.sessionId,lifetime,scopeKey]);
    const stateRef=React.useRef(state);
    stateRef.current=state;
    // The one access change the canonical Action policy routed to an approval
    // Artifact, settled once through the shared continuation owner.
    const approval=useSessionAccessApprovalHold({scopeKey,scope:input.scope});
    const approvalHeldRef=approval.heldRef;
    const holdForApproval=approval.hold;
    const isScopeCurrent=React.useCallback(()=>lifetime.current&&currentScope.current===scopeKey,[lifetime,scopeKey]);
    const requestRevision=React.useRef(0);
    const refresh=React.useCallback(async()=>{
        if (!lifetime.current || currentScope.current!==scopeKey) return null;
        const revision=++requestRevision.current;
        dispatch({type:'refresh',scopeKey});
        try {
            const snapshot=await client.list();
            if (!lifetime.current || currentScope.current!==scopeKey || revision!==requestRevision.current) return null;
            dispatch({type:'snapshot',scopeKey,snapshot});
            // Opening and explicitly refreshing the editor both discover current
            // preparation work. No grant has to be mutated first: an existing Team
            // grant whose member finished setup on another device is exactly the case
            // a mutation-only trigger could never find.
            if (availability === 'available' && snapshot.effectiveAccess.capabilities.manageAccess) {
                try {
                    const page = await readSessionDataKeyEnvelopeCollectionPage({
                        scope: { serverId: input.scope.serverId, accountId: input.scope.accountId }, sessionId: input.sessionId, availability,
                        isCurrent: () => lifetime.current && currentScope.current === scopeKey,
                    });
                    if (lifetime.current && currentScope.current === scopeKey && revision === requestRevision.current) {
                        dispatch({type:'prepared',scopeKey,origin:'discovery',preparation:settledEncryptionFromCollection(page.summary)});
                        // The same page is the default expansion: the exception rows the
                        // aggregate counts, without a second request or a second owner.
                        dispatch({type:'recipientsPage',scopeKey,view:'exceptions',rows:page.items,nextCursor:page.nextCursor,append:false});
                    }
                } catch (error) {
                    if (lifetime.current && currentScope.current === scopeKey && revision === requestRevision.current) {
                        dispatch({type:'preparationFailed',scopeKey,origin:'discovery',error:presentSessionAccessFailure(error)});
                    }
                }
            }
            return snapshot;
        } catch(error) {
            if (!lifetime.current || currentScope.current!==scopeKey || revision!==requestRevision.current) return null;
            const issue=presentSessionAccessFailure(error);
            dispatch({type:'failed',scopeKey,issue,denied:(error instanceof HappyError || error instanceof SessionAccessApiError) && (error.status===403 || error.status===404 || error.code==='session_access_forbidden' || error.code==='session_access_session_not_found')});
            return null;
        }
    },[availability,client,input.scope.accountId,input.scope.serverId,input.sessionId,lifetime,scopeKey]);
    React.useEffect(()=>{
        lifetime.current=true;
        setContextOperation('idle');
        setContextError(undefined);
        setPendingContextTeamId(undefined);
        dispatch({type:'reset',scopeKey});setQuery('');
        const unsubscribe=subscribeHomeCredentialMutations((event)=>{
            if (!areServerProfileIdentifiersEquivalent(event.serverId,input.scope.serverId)) return;
            lifetime.current=false;requestRevision.current++;
            dispatch({type:'reset',scopeKey});
        });
        // A grant another manager changed or revoked reaches this mounted editor
        // through the existing exact-Home Account-change wake. The wake is
        // content-free and carries no authority: the authoritative inspection
        // below stays the only access state owner, and a denial it proves is
        // applied by the ordinary failure path rather than guessed here.
        const unsubscribeAccountChange=subscribeHomeAccountChange((event)=>{
            if (!areServerProfileIdentifiersEquivalent(event.serverId,input.scope.serverId)) return;
            // An absent entity page is a conservative wake and must be honored.
            // A named page refetches this private roster only when it actually
            // names this Session.
            if (event.entityIds&&!event.entityIds.includes(input.sessionId)) return;
            void refresh();
        });
        void refresh();
        return ()=>{lifetime.current=false;requestRevision.current++;unsubscribe();unsubscribeAccountChange();};
    },[input.scope.serverId,input.sessionId,lifetime,refresh,scopeKey]);
    // The rows beneath the aggregate. Discovery hands over the exception rows it
    // already fetched; the explicit `Show all people` view and every re-read page
    // the same authorized collection, so one transport and one summary serve both.
    const recipientPageRevision = React.useRef(0);
    const loadRecipientPage = React.useCallback((view: SessionAccessEncryptionRecipientsView, cursor: string | null) => {
        if (availability !== 'available' || !lifetime.current || currentScope.current !== scopeKey) return;
        const revision = ++recipientPageRevision.current;
        dispatch({type:'recipientsLoading',scopeKey,view});
        void readSessionDataKeyEnvelopeCollectionPage({
            scope: { serverId: input.scope.serverId, accountId: input.scope.accountId }, sessionId: input.sessionId,
            availability, state: view === 'all' ? 'all' : 'action_required', cursor,
            isCurrent: () => lifetime.current && currentScope.current === scopeKey,
        }).then((page) => {
            if (!lifetime.current || currentScope.current !== scopeKey || revision !== recipientPageRevision.current) return;
            // Every page carries the same server summary, so the aggregate above the
            // rows stays consistent with them without a second count owner.
            if (page.summary !== null) {
                dispatch({type:'prepared',scopeKey,origin:'discovery',preparation:settledEncryptionFromCollection(page.summary)});
            }
            dispatch({type:'recipientsPage',scopeKey,view,rows:page.items,nextCursor:page.nextCursor,append:cursor!==null});
        }).catch((error) => {
            if (!lifetime.current || currentScope.current !== scopeKey || revision !== recipientPageRevision.current) return;
            dispatch({type:'recipientsFailed',scopeKey,view,error:presentSessionAccessFailure(error)});
        });
    }, [availability, input.scope.accountId, input.scope.serverId, input.sessionId, lifetime, scopeKey]);
    const currentRecipientsView = React.useCallback((): SessionAccessEncryptionRecipientsView =>
        stateRef.current.scopeKey === scopeKey ? stateRef.current.recipients.view : 'exceptions', [scopeKey]);
    const toggleAllRecipients = React.useCallback(() => {
        if (!lifetime.current || currentScope.current !== scopeKey) return;
        // Hiding the all-people view re-reads the current exceptions rather than
        // rendering an audience that may have changed meanwhile.
        loadRecipientPage(currentRecipientsView() === 'all' ? 'exceptions' : 'all', null);
    }, [currentRecipientsView, lifetime, loadRecipientPage, scopeKey]);
    const loadMoreRecipients = React.useCallback(() => {
        const recipients = stateRef.current.scopeKey === scopeKey ? stateRef.current.recipients : null;
        if (!recipients || recipients.loading) return;
        loadRecipientPage(recipients.view, recipients.nextCursor);
    }, [loadRecipientPage, scopeKey]);
    // One preparation pass at a time for this exact scope. A grant committed while a
    // pass is already walking its pages would otherwise be missed by a worklist that
    // was fetched before that recipient existed, so the run re-enters instead of
    // racing itself or dropping the newer audience.
    const preparationRun=React.useRef<{
        scopeKey:string;rerun:boolean;origin:Extract<SessionAccessEncryptionReadOrigin,'pass'|'manual'>;
    }|null>(null);
    const prepareEncryptedAccess=React.useCallback((
        recipientAccountId?:string,
        // Only a pass that follows a committed grant mutation may tell the manager the
        // access was saved. The trigger is known here and nowhere else, so it travels
        // with the observation instead of being inferred from the copy.
        passOrigin:Extract<SessionAccessEncryptionReadOrigin,'pass'|'manual'>='manual',
    )=>{
        // Lane 06 owns every key decision, the audience worklist and the sealing
        // itself. This controller only starts that pass for the Session it is already
        // scoped to and renders the Session-scoped aggregate the Home reports back. A
        // Home that does not share Sessions exposes no envelope collection at all.
        if(availability!=='available')return;
        if(!lifetime.current||currentScope.current!==scopeKey)return;
        const active=preparationRun.current;
        // A grant committed while a pass is already walking its pages re-enters that
        // run, and the re-entered pass does follow a committed mutation — so it may
        // say the access was saved even when the manager started the first one.
        if(active?.scopeKey===scopeKey){
            if(recipientAccountId===undefined){active.rerun=true;if(passOrigin==='pass')active.origin='pass';}
            return;
        }
        // This ref survives a scope-key change. A pass still awaiting Session A
        // must not absorb work for replacement Session B; A's authority guard
        // independently prevents stale writes once it resumes.
        const run:{scopeKey:string;rerun:boolean;origin:Extract<SessionAccessEncryptionReadOrigin,'pass'|'manual'>}
            ={scopeKey,rerun:false,origin:passOrigin};
        preparationRun.current=run;
        void(async()=>{
            let selectedRecipient=recipientAccountId;
            try {
                do {
                    run.rerun=false;
                    dispatch({type:'preparing',scopeKey,preparedCount:0,actionableTotal:null});
                    try {
                        const outcome=await prepareSessionDataKeyEnvelopesDetached({
                            scope:{serverId:input.scope.serverId,accountId:input.scope.accountId},
                            sessionId:input.sessionId,availability,
                            ...(selectedRecipient===undefined?{}:{reprepareRecipientAccountId:selectedRecipient}),
                            // Progress is the Home's committed count, never a locally sealed one.
                            // Progress is committed work against the Home's own actionable
                            // total, so the denominator is server truth rather than the
                            // grant rows this editor happens to show.
                            onProgress:(progress)=>{
                                if(!lifetime.current||currentScope.current!==scopeKey)return;
                                dispatch({type:'preparing',scopeKey,preparedCount:progress.preparedCount,
                                    actionableTotal:progress.actionableTotal});
                            },
                        });
                        if(!lifetime.current||currentScope.current!==scopeKey)return;
                        dispatch({type:'prepared',scopeKey,origin:run.origin,preparation:settledEncryptionFromOutcome(outcome)});
                        // The rows beneath the aggregate must say what the Home says now, not
                        // what discovery said before this pass sealed some of them.
                        loadRecipientPage(currentRecipientsView(),null);
                    } catch(error) {
                        if(!lifetime.current||currentScope.current!==scopeKey)return;
                        // The grant was already acknowledged. Key preparation is a separate
                        // obligation, so its failure stays in this Session-scoped encryption
                        // state and never re-labels that committed mutation as failed.
                        dispatch({type:'preparationFailed',scopeKey,origin:run.origin,error:presentSessionAccessFailure(error)});
                    }
                    // A grant added during explicit repair schedules the ordinary audience pass,
                    // not another repair of the previously selected recipient.
                    selectedRecipient=undefined;
                } while(run.rerun&&lifetime.current&&currentScope.current===scopeKey);
            } finally {
                if(preparationRun.current===run)preparationRun.current=null;
            }
        })();
    },[availability,currentRecipientsView,input.scope.accountId,input.scope.serverId,input.sessionId,lifetime,loadRecipientPage,scopeKey]);
    /**
     * @param adds True only for the action that turned a searched-for candidate into a
     *   grant row. That action, and only that one, consumed the typed query; editing a
     *   live row must not rebuild the candidate list the person is reading.
     */
    // PA-L2: "Reachable layout-0 Sessions migrate through the canonical owner/tuple
    // CAS before sharing or other non-owner projection." The host supplies the
    // Session's persisted layout from the projection it already holds; an unknown
    // layout claims nothing. Only the owner can split the tuple, so the offer and
    // the pre-share step are owner-only.
    const sessionRowLayout=input.metadataLayoutVersion===undefined||input.metadataLayoutVersion===null
        ?null:readSessionMetadataLayoutVersion(input.metadataLayoutVersion);
    const [layoutMigration,setLayoutMigration]=React.useState<Readonly<{
        scopeKey:string;phase:'updating'|'failed'|'migrated';error?:SessionAccessUiError;
    }>|null>(null);
    const currentLayoutMigration=layoutMigration?.scopeKey===scopeKey?layoutMigration:null;
    const viewerOwnsSession=state.scopeKey===scopeKey&&state.snapshot?.effectiveAccess.level==='owner';
    const historicalLayoutPending=viewerOwnsSession&&sessionRowLayout===0&&currentLayoutMigration?.phase!=='migrated';
    const historicalLayoutPendingRef=React.useRef(historicalLayoutPending);
    historicalLayoutPendingRef.current=historicalLayoutPending;
    const migrateHistoricalLayout=React.useCallback(async():Promise<true|SessionAccessUiError>=>{
        const isMigrationCurrent=()=>lifetime.current&&currentScope.current===scopeKey;
        setLayoutMigration({scopeKey,phase:'updating'});
        try {
            await migrateSessionForSharing({
                scope:{serverId:input.scope.serverId,accountId:input.scope.accountId},
                sessionId:input.sessionId,isCurrent:isMigrationCurrent,
            });
            // The list row catches up on its own refresh; this editor already knows.
            if(isMigrationCurrent()){
                historicalLayoutPendingRef.current=false;
                setLayoutMigration({scopeKey,phase:'migrated'});
            }
            return true;
        } catch(error) {
            const issue=presentSessionAccessFailure(error);
            if(isMigrationCurrent())setLayoutMigration({scopeKey,phase:'failed',error:issue});
            return issue;
        }
    },[input.scope.accountId,input.scope.serverId,input.sessionId,lifetime,scopeKey]);
    const updateHistoricalLayout=React.useCallback(()=>{
        if(!historicalLayoutPendingRef.current||approvalHeldRef.current)return;
        if(currentLayoutMigration?.phase==='updating')return;
        void migrateHistoricalLayout();
    },[currentLayoutMigration?.phase,migrateHistoricalLayout]);
    /** The one tail for a committed set/remove, whether it answered directly or through its approval. */
    const settleCommittedMutation=React.useCallback(async(key:string,mutation:SessionGrantMutationV1|null,adds:boolean)=>{
        // Set responses contain acknowledged values but no allowed transitions or principal summary.
        // The authoritative list refresh supplies the complete current row before it is rendered.
        await refresh();
        if(!lifetime.current||currentScope.current!==scopeKey)return;
        dispatch({type:'operation',scopeKey,key,operation:{kind:'idle'}});
        dispatch({type:'confirm',scopeKey,key:null});
        if(adds)setQuery('');
        setDirectoryRevision(value=>value+1);
        // A newly authorized recipient can hold a grant long before it can open
        // anything, so the key owner's pass starts from the acknowledged audience.
        // Removing a grant leaves its stored tuple inert at that owner and needs
        // no pass. This deliberately follows the authoritative refresh: the worklist
        // is only worth fetching once the Home agrees the grant exists.
        if(mutation)prepareEncryptedAccess(undefined,'pass');
    },[lifetime,prepareEncryptedAccess,refresh,scopeKey]);
    const settleFailedMutation=React.useCallback(async(
        key:string,mutation:SessionGrantMutationV1|null,subject:PrincipalRefV1,issue:SessionAccessUiError,
    )=>{
        dispatch({type:'operation',scopeKey,key,operation:issue.retryable
            ? {kind:'error',error:issue,reconcileIntent:mutation?{kind:'set',mutation}:{kind:'remove',subject}}
            : {kind:'error',error:issue}});
        // A retryable transport/parse failure cannot prove whether the mutation
        // committed. The authoritative list settles the row only when it proves
        // this exact set/remove intent; a mismatching row keeps the retryable error.
        if(issue.retryable)await refresh();
    },[refresh,scopeKey]);
    const mutate=React.useCallback(async(subject:PrincipalRefV1,mutation:SessionGrantMutationV1|null,adds=false)=>{
        if (!lifetime.current || currentScope.current!==scopeKey) return;
        // One approval at a time, exactly like the Board: an open approval holds the editor.
        if (approvalHeldRef.current) return;
        const snapshot=stateRef.current.scopeKey===scopeKey?stateRef.current.snapshot:null;
        if (!snapshot?.effectiveAccess.capabilities.manageAccess) return;
        const key=sessionAccessSubjectKey(subject);
        const previous=stateRef.current.operations[key];
        if(previous?.kind==='saving'||previous?.kind==='removing')return;
        dispatch({type:'operation',scopeKey,key,operation:{kind:mutation?'saving':'removing'}});
        if(mutation&&historicalLayoutPendingRef.current){
            // PA-L2: a historical Session is split by its owner before it is shared.
            const migrated=await migrateHistoricalLayout();
            if(!lifetime.current||currentScope.current!==scopeKey)return;
            if(migrated!==true){
                dispatch({type:'operation',scopeKey,key,operation:{kind:'error',error:migrated}});
                return;
            }
        }
        try {
            if(mutation)await client.set(mutation);else await client.remove(subject);
            if(!lifetime.current||currentScope.current!==scopeKey)return;
            await settleCommittedMutation(key,mutation,adds);
        }catch(error){
            if(!lifetime.current||currentScope.current!==scopeKey)return;
            if(error instanceof SessionAccessApprovalPendingError){
                // Routed to an approval: nothing committed, and it is not an unknown outcome.
                dispatch({type:'operation',scopeKey,key,operation:{kind:'idle'}});
                dispatch({type:'confirm',scopeKey,key:null});
                holdForApproval(error,
                    mutation?'session.access.grant.set':'session.access.grant.remove',
                    mutation?{sessionId:input.sessionId,...mutation}:{sessionId:input.sessionId,subject},
                    {
                        isCurrent:isScopeCurrent,
                        onSucceeded:()=>settleCommittedMutation(key,mutation,adds),
                        onFailed:(issue)=>{if(issue)void settleFailedMutation(key,mutation,subject,issue);},
                    });
                return;
            }
            await settleFailedMutation(key,mutation,subject,presentSessionAccessFailure(error, { outcomeUnknown: true }));
        }
    },[approvalHeldRef,client,holdForApproval,input.sessionId,isScopeCurrent,lifetime,migrateHistoricalLayout,scopeKey,settleCommittedMutation,settleFailedMutation]);
    const retryMutation = React.useCallback((subject: PrincipalRefV1) => {
        const operation = stateRef.current.scopeKey === scopeKey
            ? stateRef.current.operations[sessionAccessSubjectKey(subject)]
            : undefined;
        if (operation?.kind !== 'error' || !operation.error.retryable || !operation.reconcileIntent) return;
        const intent = operation.reconcileIntent;
        void mutate(intent.kind === 'set' ? intent.mutation.subject : intent.subject,
            intent.kind === 'set' ? intent.mutation : null);
    }, [mutate, scopeKey]);
    const [contextOperation, setContextOperation] = React.useState<'idle' | 'saving' | 'error'>('idle');
    const [contextError, setContextError] = React.useState<SessionAccessUiError | undefined>();
    const submitContext = React.useCallback((teamId: string | null) => {
        if (contextOperation === 'saving') return;
        if (!lifetime.current || currentScope.current !== scopeKey) return;
        if (approvalHeldRef.current) return;
        const snapshot = stateRef.current.scopeKey === scopeKey ? stateRef.current.snapshot : null;
        if (!snapshot?.effectiveAccess.capabilities.manageAccess || snapshot.primaryTeamId === teamId) return;
        setContextOperation('saving');
        setContextError(undefined);
        const settleCommittedContext = async () => {
            await refresh();
            if (lifetime.current && currentScope.current === scopeKey) {
                setContextOperation('idle');
                setPendingContextTeamId(undefined);
            }
        };
        const settleFailedContext = async (issue: SessionAccessUiError) => {
            setContextError(issue);
            setContextOperation('error');
            // A retryable failure cannot prove whether the transaction committed.
            // Keep the reviewed choice and reconcile visible context/grants from
            // the authoritative inspection instead of guessing or compensating.
            if (issue.retryable) {
                const reconciled = await refresh();
                if (reconciled?.primaryTeamId === teamId
                    && lifetime.current && currentScope.current === scopeKey) {
                    setContextError(undefined);
                    setContextOperation('idle');
                    setPendingContextTeamId(undefined);
                }
            }
        };
        void client.setContext(teamId).then(async () => {
            if (!lifetime.current || currentScope.current !== scopeKey) return;
            await settleCommittedContext();
        }).catch(async (error) => {
            if (!lifetime.current || currentScope.current !== scopeKey) return;
            if (error instanceof SessionAccessApprovalPendingError) {
                // Routed to an approval: the acknowledged context is still the truth.
                setContextOperation('idle');
                holdForApproval(error, 'session.access.context.set', { sessionId: input.sessionId, primaryTeamId: teamId }, {
                    isCurrent: isScopeCurrent,
                    onSucceeded: settleCommittedContext,
                    onFailed: (issue) => {
                        if (issue) { void settleFailedContext(issue); return; }
                        // Declined or canceled: nothing changed and the review is over.
                        setPendingContextTeamId(undefined);
                    },
                });
                return;
            }
            await settleFailedContext(presentSessionAccessFailure(error, { outcomeUnknown: true }));
        });
    }, [approvalHeldRef, client, contextOperation, holdForApproval, input.sessionId, isScopeCurrent, lifetime, refresh, scopeKey]);
    const current=state.scopeKey===scopeKey?state:createSessionAccessEditorState(scopeKey);
    const projection=current.snapshot?projectSessionAccessEditorSnapshot({snapshot:current.snapshot,operations:current.operations,
        confirmingRemoval:current.confirmingRemoval,viewerAccountId:input.scope.accountId,viewerProfile}):{
        owner:null,grants:[],accessMode:'read_only' as const,summary:{label:t('session.access.title'),accessibilityLabel:t('session.access.title'),requiredByTeamPolicy:false},
    };
    // Current grant Teams preserve their admitted display names while the directory
    // independently pages every discoverable member Team. They seed presentation;
    // they never bound Group discovery to Teams this Session already names.
    const contextTeams=React.useMemo<readonly SessionAccessDirectoryTeamContext[]>(()=>projection.grants
        .filter(row=>row.grant.kind==='team')
        .map(row=>({teamId:row.grant.kind==='team'?row.grant.teamId:'',name:row.principal.displayName})),[projection.grants]);
    const directory=useSessionAccessDirectory({
        scope:input.scope,sessionId:input.sessionId,availability,contextTeams,
        operations:current.operations,revision:directoryRevision,enabled:projection.accessMode==='editable',
    });
    const directoryTeamsRef = React.useRef(directory.teamContexts);
    directoryTeamsRef.current = directory.teamContexts;
    const currentContextPolicyRef = React.useRef<Readonly<{
        team: SessionAccessDirectoryTeamContext | null;
        unavailable: boolean;
        locked: boolean;
    }>>({ team: null, unavailable: false, locked: false });
    const setContext = React.useCallback((teamId: string | null) => {
        const snapshot = stateRef.current.scopeKey === scopeKey ? stateRef.current.snapshot : null;
        if (!snapshot?.effectiveAccess.capabilities.manageAccess || snapshot.primaryTeamId === teamId) return;
        const target = teamId === null ? null : directoryTeamsRef.current.find((team) => team.teamId === teamId) ?? null;
        if (teamId !== null && (!target?.sessionCreationPolicy || !target.externalSharingPolicy)) return;
        const currentPolicy = currentContextPolicyRef.current;
        const currentTeam = snapshot.primaryTeamId === null ? null : currentPolicy.team;
        if (snapshot.primaryTeamId !== null && (currentPolicy.unavailable || currentPolicy.locked)) return;
        const consequences = projectSessionAccessContextChange({
            target,
            current: currentTeam,
            grants: snapshot.grants.map((row) => row.grant),
            ...(snapshot.visibility === 'complete' && snapshot.credentialBindingConsequences
                ? { credentialBindings: snapshot.credentialBindingConsequences } : {}),
        });
        if (consequences.length > 0) {
            setPendingContextTeamId(teamId);
            setContextError(undefined);
            setContextOperation('idle');
            return;
        }
        submitContext(teamId);
    }, [scopeKey, submitContext]);
    const confirmContext = React.useCallback(() => {
        if (pendingContextTeamId === undefined) return;
        submitContext(pendingContextTeamId);
    }, [pendingContextTeamId, submitContext]);
    const currentPendingApproval=approval.pendingApproval;
    const openPendingApproval=approval.openPendingApproval;
    const actions=React.useMemo<SessionAccessEditorActions>(()=>({
        setQuery,retryContent:()=>{void refresh();},
        retryDirectory:(kind)=>{directory.retry(kind);setDirectoryRevision(value=>value+1);},
        loadMore:(kind)=>directory.loadMore(kind),
        retryMutation,
        addPrincipal:(subject)=>{void mutate(subject,sessionAccessGrantMutation(subject,{accessLevel:'view',canApprovePermissions:false}),true);},
        setAccessLevel:(subject,level)=>{
            const row=stateRef.current.snapshot?.grants.find(row=>sessionAccessSubjectKey(row.grant.subject)===sessionAccessSubjectKey(subject));
            if(!row?.allowedTransitions.accessLevels.includes(level))return;
            void mutate(subject,sessionAccessGrantMutation(subject,{accessLevel:level,canApprovePermissions:level==='view'?false:row.grant.canApprovePermissions}));
        },
        setPermissionDelegation:(subject,enabled)=>{
            const row=stateRef.current.snapshot?.grants.find(row=>sessionAccessSubjectKey(row.grant.subject)===sessionAccessSubjectKey(subject));
            if(!row?.allowedTransitions.canChangePermissionDelegation)return;
            void mutate(subject,sessionAccessGrantMutation(subject,{accessLevel:row.grant.accessLevel,canApprovePermissions:enabled}));
        },
        requestRemove:(subject)=>{
            const row=stateRef.current.snapshot?.grants.find(row=>sessionAccessSubjectKey(row.grant.subject)===sessionAccessSubjectKey(subject));
            if(row?.allowedTransitions.canRemove)dispatch({type:'confirm',scopeKey,key:sessionAccessSubjectKey(subject)});
        },
        confirmRemove:(subject)=>{if(stateRef.current.confirmingRemoval===sessionAccessSubjectKey(subject))void mutate(subject,null);},
        cancelRemove:()=>dispatch({type:'confirm',scopeKey,key:null}),
        explain:(reason)=>dispatch({type:'failed',scopeKey,issue:{...reason,retryable:false}}),
        setContext,
        confirmContext,
        cancelContext:()=>setPendingContextTeamId(undefined),
        // Live access is never a draft; Private is expressed through explicit
        // grant removals and the server-owned Team-policy transition.
        clearAccess:()=>{},
        prepareAccess:(recipientAccountId?:string)=>prepareEncryptedAccess(recipientAccountId),
        toggleAllRecipients,
        loadMoreRecipients,
        openPendingApproval,
        updateHistoricalLayout,
    }),[confirmContext,directory,loadMoreRecipients,mutate,openPendingApproval,prepareEncryptedAccess,refresh,retryMutation,scopeKey,setContext,toggleAllRecipients,updateHistoricalLayout]);
    // Lane 04's existing projection names every grant principal; the encryption
    // resource deliberately carries no names, roles or avatars.
    const grantedDisplayNameForAccount=React.useCallback((accountId:string)=>{
        const owner=projection.owner;
        if(owner&&owner.principal.ref.kind==='account'&&owner.principal.ref.accountId===accountId){
            return owner.principal.displayName;
        }
        return projection.grants.find((row)=>row.grant.kind==='account'&&row.grant.accountId===accountId)?.principal.displayName;
    },[projection.grants,projection.owner]);
    // A recipient reachable only through a Team grant has no grant row at all, so the
    // Team's own bounded member lookup names the ones currently on screen. Everyone
    // else — Group-only and out-of-Team recipients — keeps the identifier.
    const sessionTeamIds=React.useMemo(
        ()=>current.snapshot?.grants.flatMap((row)=>row.grant.subject.kind==='team'?[row.grant.subject.teamId]:[])??[],
        [current.snapshot],
    );
    const visibleRecipientAccountIds=React.useMemo(
        ()=>current.recipients.rows.map((row)=>row.recipientAccountId),
        [current.recipients.rows],
    );
    const teamRecipientLabelFor=useSessionAccessTeamRecipientLabels({
        scope:input.scope,teamIds:sessionTeamIds,visibleRecipientAccountIds,
        isAlreadyNamed:(accountId)=>grantedDisplayNameForAccount(accountId)!==undefined,
        enabled:availability==='available'&&current.snapshot?.effectiveAccess.capabilities.manageAccess===true,
    });
    const displayNameForAccount=React.useCallback(
        (accountId:string)=>grantedDisplayNameForAccount(accountId)??teamRecipientLabelFor(accountId),
        [grantedDisplayNameForAccount,teamRecipientLabelFor],
    );
    const encryption=projectSessionAccessEncryptionSection({
        preparation:current.preparation,recipients:current.recipients,displayNameForAccount,
    });
    const currentContextPolicyTeam = current.snapshot?.primaryTeamId
        ? directory.activeTeamContexts.find((team) => team.teamId === current.snapshot?.primaryTeamId) ?? null
        : null;
    // The active-Team directory is authoritative only after its final page.
    // Absence before that point, or during a failed refresh, says nothing and
    // must not unlock a required context. A complete absence means the Team is
    // no longer an active eligible context, so the editor exposes recovery.
    const currentContextRecoveryAllowed = Boolean(current.snapshot?.primaryTeamId
        && directory.teamDirectoryStatus === 'ready'
        && directory.teamDirectoryComplete
        && !currentContextPolicyTeam);
    const currentContextPolicyUnavailable = Boolean(current.snapshot?.primaryTeamId
        && !currentContextPolicyTeam
        && !currentContextRecoveryAllowed);
    const contextLockedByTeamPolicy = Boolean(currentContextPolicyTeam?.sessionCreationPolicy === 'team_required'
        && projection.grants.some((row) => row.grant.kind === 'team'
            && row.grant.teamId === current.snapshot?.primaryTeamId && row.requiredByTeamPolicy));
    currentContextPolicyRef.current = {
        team: currentContextPolicyTeam,
        unavailable: currentContextPolicyUnavailable,
        locked: contextLockedByTeamPolicy,
    };
    const contextTeamsForModel = directory.teamContexts.map((team) => {
        const projected = team.teamId === current.snapshot?.primaryTeamId && currentContextPolicyTeam
            ? currentContextPolicyTeam
            : team;
        return { teamId: team.teamId, label: projected.name,
            ...((contextLockedByTeamPolicy && team.teamId !== current.snapshot?.primaryTeamId)
                ? { blockedReason: { code: 'session_access_team_policy_required', message: t('session.access.required') } }
                : !projected.sessionCreationPolicy || !projected.externalSharingPolicy || currentContextPolicyUnavailable ? { blockedReason: {
                code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed'),
            } } : {}),
        };
    });
    const currentContextTeam = current.snapshot?.primaryTeamId && !contextTeamsForModel.some((team) => team.teamId === current.snapshot?.primaryTeamId)
        ? [{ teamId: current.snapshot.primaryTeamId, label: t('session.access.team'), blockedReason: {
            code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed'),
        } }]
        : [];
    const pendingContextTeam = pendingContextTeamId === null ? null
        : pendingContextTeamId === undefined ? undefined
            : directory.teamContexts.find((team) => team.teamId === pendingContextTeamId);
    const pendingConsequences = pendingContextTeamId === undefined ? [] : projectSessionAccessContextChange({
        target: pendingContextTeam ?? null,
        current: currentContextPolicyTeam,
        grants: current.snapshot?.grants.map((row) => row.grant) ?? [],
        ...(current.snapshot?.visibility === 'complete' && current.snapshot.credentialBindingConsequences
            ? { credentialBindings: current.snapshot.credentialBindingConsequences } : {}),
    });
    return {actions,model:{...projection,revision:directoryRevision,
        ...(current.snapshot && availability === 'available' ? { context: { primaryTeamId: current.snapshot.primaryTeamId, options: [{ teamId: null, label: t('session.access.private'),
            ...(contextLockedByTeamPolicy ? { blockedReason: { code: 'session_access_team_policy_required', message: t('session.access.required') } }
                : currentContextPolicyUnavailable ? { blockedReason: { code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed') } } : {}) }, ...contextTeamsForModel, ...currentContextTeam], operation: contextOperation,
            ...(contextError ? { error: contextError } : {}),
            ...(pendingContextTeamId !== undefined ? { confirmation: {
                teamId: pendingContextTeamId,
                label: pendingContextTeam?.name ?? t('session.access.private'),
                consequences: pendingConsequences,
            } } : {}) } } : {}),
        content:{phase:current.refreshing?(current.snapshot?'refreshing':'initial'):current.issue?'error':current.snapshot?'ready':'initial',hasLastAcknowledgedSnapshot:current.snapshot!==null,...(current.issue?{issue:current.issue}:{})},
        directory:{query,sections:directory.sections},
        ...(encryption?{encryption}:{}),
        ...(currentPendingApproval?{pendingApproval:currentPendingApproval}:{}),
        ...(historicalLayoutPending?{historicalLayout:{
            updating:currentLayoutMigration?.phase==='updating',
            ...(currentLayoutMigration?.phase==='failed'&&currentLayoutMigration.error?{error:currentLayoutMigration.error}:{}),
        }}:{}),
    }};
}
