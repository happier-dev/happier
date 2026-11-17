import type { MachineWorkSummaryV1 } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import { describeMachineWorkCounts } from './MachineWorkSummarySection';
import { machineWorkSummaryKey, useMachineWorkSummaries } from './machineWorkSummary';
import { useMachineGuestExecution } from '@/hooks/machine/useMachineGuestExecution';
import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { ActionApprovalRequestCreatedResultSchema, isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineAccessGrantsListResponseV1Schema, MachineAccessRefusalV1Schema, MachineAccessMutationResultV1Schema,
    MachineAccessGrantSetInputV1Schema, MachineKeyPreparationResultV1Schema, type MachineAccessGrantsListResponseV1,
    type MachineAccessLevelV1, type MachineAccessGrantRowV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { presentActionApproval } from '@/components/approvals/actionApprovalPresentation';
import { confirmActionReview } from '@/components/approvals/ActionConfirmationReview';
import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { parseToken } from '@/utils/auth/parseToken';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { t } from '@/text';
import type { ShareGrantRowModel, ShareOperationModel, ShareSheetActions,
    ShareSheetModel, ShareUiError, ShareUiReason } from '../shareSheetTypes';
import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';
import { useActiveHomeSettling } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { describeMachineShareTrust } from './machineShareTrust';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { useTeamGroupNameProjectionDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';

export type MachineShareGrantRow = ShareGrantRowModel & Readonly<{
    readiness: 'ready' | 'key_pending' | 'refused';
    audience: MachineAccessGrantRowV1['audience'];
    canPrepareKeys: boolean;
    viewer?: boolean;
}>;
type Mutation = Readonly<{ actionId: 'machines.access.grant.set'; principal: PrincipalRefV1; level: MachineAccessLevelV1 }>
    | Readonly<{ actionId: 'machines.access.grant.remove' | 'machines.access.leave' | 'machines.access.prepareKeys'; principal: PrincipalRefV1 }>;
type State = Readonly<{ response: MachineAccessGrantsListResponseV1 | null; phase: 'initial' | 'ready' | 'error';
    issue?: ShareUiError; operations: Readonly<Record<string, ShareOperationModel>> }>;
const IDLE: ShareOperationModel = { kind: 'idle' };
const NO_TEAMS: readonly [] = [];

function isAuthorityLoss(code: string): boolean {
    return ['access_denied', 'account_scope_mismatch', 'action_account_scope_changed', 'not_authenticated', 'machine_access_stale_scope'].includes(code);
}

/** A role change that did not save: what was asked for, and the access that still holds. */
type UnsavedRoleChange = Readonly<{ draft: MachineAccessLevelV1; current: MachineAccessLevelV1 }>;
const levelLabel = (level: MachineAccessLevelV1) => t(level === 'admin' ? 'machines.sharing.manage' : 'machines.sharing.use');

function failure(code: string, machine: string, person = t('shareSheet.person'), change?: UnsavedRoleChange): ShareUiError {
    // Each cause names who can fix it; none clears by retrying until that person acts.
    if (code === 'content_unpublished') return { code, message: t('machines.sharing.unpublished', { machine }), retryable: false };
    if (code === 'custodian_only') return { code, message: t('machines.sharing.custodianOnly', { machine }), retryable: false };
    if (code === 'daemon_upgrade_required') return { code, message: t('machines.sharing.upgradeRequired', { machine }), retryable: false };
    if (code === 'principal_not_found') return { code, message: t('session.access.subjectNotFound'), retryable: false };
    if (code === 'principal_ineligible') return { code, message: t('session.access.subjectIneligible'), retryable: false };
    if (code === 'unsupported_operation') return { code, message: t('machines.sharing.unsupportedOperation'), retryable: false };
    if (code === 'outcome_unknown') return { code, message: t('machines.sharing.outcomeUnknown'), retryable: false };
    if (code === 'recipient_encryption_incompatible' || code === 'recipient_incompatible') return { code,
        message: t('machines.sharing.incompatible', { machine, person }), retryable: false };
    if (isAuthorityLoss(code) || code === 'custodian_protected') return { code,
        message: code === 'custodian_protected' ? t('machines.sharing.custodianProtected') : t('machines.sharing.denied', { machine }), retryable: false };
    // An issued mutation without acknowledgement cannot safely be replayed by a row Retry.
    const retryable = !['outcome_unknown', 'machine_access_stale_scope', 'unsupported_action'].includes(code);
    return { code, retryable, message: change && retryable
        ? t('machines.sharing.saveFailed', { person, draft: levelLabel(change.draft), current: levelLabel(change.current) })
        : t('machines.sharing.unavailable', { machine }) };
}
function errorCode(value: unknown): string {
    if (value && typeof value === 'object') {
        if ('code' in value && typeof value.code === 'string') return value.code;
        if ('errorCode' in value && typeof value.errorCode === 'string') return value.errorCode;
    }
    return 'machine_access_request_failed';
}

/**
 * What a removal changes, for the row's review (lab m-share R): who loses their last access and what happens at the
 * natural boundary, then the work each of them has running. Unread work claims nothing, never a reassuring zero.
 */
export function describeMachineRemovalConsequences(input: Readonly<{ machine: string;
    people: readonly Readonly<{ accountId: string; name: string }>[];
    requesters: Extract<MachineWorkSummaryV1, { kind: 'current' }>['requesters'] | null }>): readonly string[] {
    if (input.people.length === 0) return [t('machines.sharing.overlap')];
    const work = (input.requesters ?? []).flatMap(requester => {
        const person = input.people.find(candidate => candidate.accountId === requester.accountId);
        const counts = person ? describeMachineWorkCounts(requester) : '';
        return person && counts ? [t('machines.sharing.removalWork', { person: person.name, work: counts, machine: input.machine })] : [];
    });
    return [t('machines.sharing.effectiveLoss', { people: input.people.map(person => person.name).join(', '), machine: input.machine }), ...work];
}

/** One Machine's permission projection; all reads and writes use canonical Actions. */
export function useMachineShareController(input: Readonly<{ machineId: string; machineName: string; scope: ServerAccountScope | null; online?: boolean | null }>) {
    const { machineId, machineName, scope, online } = input;
    const viewerProfile = useShareViewerProfile(scope);
    const principal = (ref: PrincipalRefV1, name: string | null) => presentSharePrincipal({ ref, name,
        viewerAccountId: scope?.accountId, profile: ref.kind === 'account' && ref.accountId === scope?.accountId ? viewerProfile : null });
    const identity = scope ? `${scope.serverId}:${scope.accountId}:${machineId}` : null;
    type ConfirmUserAction = NonNullable<NonNullable<Parameters<typeof createFrontDoorActionExecute>[1]>['presentUserActionConfirmation']>;
    const confirmUserAction = React.useRef<ConfirmUserAction | null>(null);
    const [execute] = React.useState(() => createFrontDoorActionExecute(undefined, {
        presentUserActionConfirmation: args => confirmUserAction.current!(args),
    }));
    const lifetimeRef = React.useRef<AbortController | null>(null);
    const pending = React.useRef<AbortController | null>(null);
    const [state, setState] = React.useState<State>({ response: null, phase: 'initial', operations: {} });
    const [query, setQuery] = React.useState('');
    const [revision, setRevision] = React.useState(0);
    const [notice, setNotice] = React.useState<ShareUiReason>();
    const intents = React.useRef(new Map<string, Mutation>());
    const names = React.useRef(new Map<string, string>());
    const responseIdentity = React.useRef<string | null>(null);
    const response = identity !== null && responseIdentity.current === identity ? state.response : null;
    const groupLabelInputs = React.useMemo(() => response ? [
        ...response.grants.flatMap(row => row.principal.kind === 'group' && row.display.groupName !== undefined
            ? [{ id: row.principal.groupId, name: row.display.groupName }]
            : []),
        ...response.ownAccessSources.flatMap(source => source.principal.kind === 'group' && source.groupName !== undefined
            ? [{ id: source.principal.groupId, name: source.groupName }]
            : []),
    ] : [], [response]);
    const groupDisplayNames = useTeamGroupNameProjectionDisplayNames({ scope, groups: groupLabelInputs });
    const grantDisplayName = (row: MachineAccessGrantRowV1) => row.principal.kind === 'group' && row.display.groupName !== undefined
        ? groupDisplayNames.get(row.principal.groupId) ?? null
        : row.display.name;
    const sourceDisplayName = (source: MachineAccessGrantsListResponseV1['ownAccessSources'][number]) => source.principal.kind === 'group' && source.groupName !== undefined
        ? groupDisplayNames.get(source.principal.groupId) ?? null
        : source.displayName;
    const guestExecution = useMachineGuestExecution({ machineId, scope, execute, canManage: response?.canManage === true });
    // The grant confirmation is worded after commit; it reads the current placement, not a render-time copy.
    const guestExecutionRef = React.useRef(guestExecution);
    guestExecutionRef.current = guestExecution;
    const stateRef = React.useRef(state);
    stateRef.current = state;
    // The Action policy decides whether a confirmation shows; this only words it. A grant names the
    // machine, the person and the role it gives, so "Share a machine" is never a bare question.
    confirmUserAction.current = async ({ actionId, input, context, preview }) => {
        if (!scope) return false;
        const presentation = presentActionApproval({ actionId, actionArgs: input, preview, kind: 'confirmation', subject: machineName });
        const grant = actionId === 'machines.access.grant.set' ? MachineAccessGrantSetInputV1Schema.safeParse(input) : null;
        let message: string | null = null;
        if (grant?.success) {
            const trust = describeMachineShareTrust(guestExecutionRef.current.placement, false, machineName, guestExecutionRef.current.isolation);
            message = [`${names.current.get(sessionAccessSubjectKey(grant.data.principal)) ?? t('shareSheet.person')} · ${
                t(grant.data.level === 'admin' ? 'machines.sharing.manage' : 'machines.sharing.use')}`,
                trust.lead, trust.detail].join('\n\n');
        }
        return confirmActionReview({ actionId, actionArgs: input, preview,
            title: presentation.title ?? t('approvals.untitled'), summary: message,
            confirmLabel: presentation.confirmLabel ?? t('approvals.approve'), irreversible: presentation.destructive === true,
            serverId: context.serverId ?? scope?.serverId, ...(context.signal ? { signal: context.signal } : {}) });
    };
    const target = React.useMemo(() => scope ? ({ serverId: scope.serverId, machineId }) : null, [scope?.serverId, machineId]);
    const context = React.useMemo(() => ({ surface: 'ui' as const, source: 'ui_button' as const, authority: 'present_user' as const,
        serverId: scope?.serverId, expectedAccountId: scope?.accountId }), [scope?.serverId, scope?.accountId]);

    const clearProjection = React.useCallback((issue: ShareUiError) => {
        pending.current?.abort();
        intents.current.clear();
        names.current.clear();
        setNotice(undefined);
        setState({ response: null, phase: 'error', issue, operations: {} });
        setRevision(value => value + 1);
    }, []);
    const load = React.useCallback(async () => {
        pending.current?.abort();
        const lifetime = lifetimeRef.current;
        if (!scope || !target || !lifetime || lifetime.signal.aborted) return;
        const unknownIntents = Object.entries(stateRef.current.operations).flatMap(([key, operation]) => {
            const intent = intents.current.get(key);
            return operation.kind === 'error' && operation.error.code === 'outcome_unknown' && intent
                ? [{ key, operation, intent }] : [];
        });
        const request = new AbortController();
        pending.current = request;
        const result = await execute('machines.access.grants.list', target, { ...context, signal: request.signal }).catch(() => null);
        if (request.signal.aborted || lifetime.signal.aborted) return;
        const parsed = result?.ok ? MachineAccessGrantsListResponseV1Schema.safeParse(result.result) : null;
        if (parsed?.success && parsed.data.machineId === machineId) {
            responseIdentity.current = identity;
            // Only the requested outcome in the authoritative census resolves an
            // unacknowledged write. A different or partial result keeps the intent.
            const confirmedOperations = unknownIntents.filter(({ key, intent }) => {
                if (intents.current.get(key) !== intent) return false;
                const grant = parsed.data.grants.find(row => sessionAccessSubjectKey(row.principal) === key);
                return intent.actionId === 'machines.access.grant.set' ? grant?.level === intent.level
                    : intent.actionId === 'machines.access.grant.remove' ? grant === undefined
                        : intent.actionId === 'machines.access.leave' ? !parsed.data.ownDirectGrant : false;
            });
            for (const { key } of confirmedOperations) intents.current.delete(key);
            setState(previous => {
                const operations = { ...previous.operations };
                for (const { key, operation } of confirmedOperations) {
                    if (operations[key] === operation) delete operations[key];
                }
                return retainDeep<State>(previous, { ...previous, response: parsed.data, phase: 'ready', issue: undefined, operations });
            });
        } else {
            const refusal = result?.ok ? MachineAccessRefusalV1Schema.safeParse(result.result) : null;
            const code = result?.ok ? refusal?.success ? refusal.data.code : 'machine_access_invalid_response' : errorCode(result);
            const issue = failure(code, machineName);
            // Only transport unavailability permits retaining the old privileged census.
            if (code === 'machine_unavailable' || code === 'machine_access_request_failed') {
                setState(previous => ({ ...previous, phase: 'error', issue: { ...issue,
                    message: t('machines.sharing.readError', { machine: machineName }) } }));
            } else clearProjection(issue);
        }
    }, [execute, target, context, machineId, machineName, clearProjection, scope?.serverId, scope?.accountId, identity]);
    React.useEffect(() => {
        if (!scope) return;
        // Setup owns the lifetime: replayed effects must not reuse a retired signal.
        let lifetime = new AbortController();
        lifetimeRef.current = lifetime;
        // Observe the existing catch-up wake, including roster-only edits whose Machine
        // DTO is unchanged. Keep draft/selection state while replacing only the safe census.
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (!lifetime.signal.aborted && areServerProfileIdentifiersEquivalent(event.serverId, scope.serverId)
                && (event.entityIds === undefined || event.entityIds.includes(machineId))) void load();
        }, { reconnect: 'refresh' });
        const stopCredentials = subscribeHomeCredentialChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, scope.serverId)) return;
            let actor: string | null = null;
            try { actor = event.credentials ? parseToken(event.credentials.token) : null; } catch { /* Invalid identity retires this census. */ }
            if (event.kind === 'credentials_removed' || actor !== scope.accountId) {
                lifetime.abort();
                clearProjection(failure('not_authenticated', machineName));
            } else {
                // Old requests keep their retired lifetime even after this Account returns.
                if (lifetime.signal.aborted) {
                    lifetime = new AbortController();
                    lifetimeRef.current = lifetime;
                }
                void load();
            }
        });
        void load();
        return () => { unsubscribe(); stopCredentials(); lifetime.abort(); pending.current?.abort(); };
    }, [load, scope?.serverId, scope?.accountId, machineId, machineName, clearProjection]);
    // A read that failed while the Home was still being reached (right after a restart) has not settled into a
    // failure: it reads as loading, and is read again once the Home answers.
    const homeSettling = useActiveHomeSettling(scope?.serverId);
    const retryableReadRef = React.useRef(false);
    retryableReadRef.current = state.phase === 'error' && state.issue?.retryable === true;
    const wasSettling = React.useRef(false);
    React.useEffect(() => {
        // A definitive Home refusal has already answered; reconnecting cannot repair it.
        if (wasSettling.current && !homeSettling && retryableReadRef.current) void load();
        wasSettling.current = homeSettling;
    }, [homeSettling, load]);
    const readSettling = homeSettling && state.phase === 'error' && state.issue?.retryable === true;
    const approval = useActionApprovalContinuation({ scopeKey: identity ?? '', serverId: scope?.serverId ?? '', onExecuted: () => { void load(); } });
    const directory = useSessionAccessDirectory({ scope, availability: 'available', contextTeams: NO_TEAMS,
        operations: state.operations, revision, enabled: response?.canManage === true && state.phase === 'ready' });
    for (const row of response?.grants ?? []) names.current.set(sessionAccessSubjectKey(row.principal), grantDisplayName(row) ?? principal(row.principal, null).displayName);
    const ownPrincipal = React.useMemo<PrincipalRefV1 | null>(() => scope ? ({ kind: 'account', accountId: scope.accountId }) : null, [scope?.accountId]);
    const ownKey = ownPrincipal ? sessionAccessSubjectKey(ownPrincipal) : null;
    const isCustodian = response?.custodian.accountId === scope?.accountId;
    const canWrite = response?.canManage === true && state.phase === 'ready';
    const canLeave = response?.ownDirectGrant === true && !isCustodian && state.phase === 'ready';

    const mutate = React.useCallback(async (mutation: Mutation) => {
        const lifetime = lifetimeRef.current;
        if (!scope || !target || !lifetime || lifetime.signal.aborted) return;
        const key = sessionAccessSubjectKey(mutation.principal);
        intents.current.set(key, mutation);
        setState(previous => ({ ...previous, operations: { ...previous.operations,
            [key]: { kind: mutation.actionId === 'machines.access.grant.remove' || mutation.actionId === 'machines.access.leave' ? 'removing' : 'saving' } } }));
        const payload = mutation.actionId === 'machines.access.grant.set' ? { ...target, principal: mutation.principal, level: mutation.level }
            : mutation.actionId === 'machines.access.grant.remove' ? { ...target, principal: mutation.principal } : target;
        const fail = (code: string) => {
            if (lifetime.signal.aborted) return;
            if (isActionApprovalDeclinedErrorCode(code)) {
                // The person said no: nothing changed and nothing failed, so the row returns to its saved level.
                intents.current.delete(key);
                setState(previous => {
                    const { [key]: _declined, ...operations } = previous.operations;
                    return { ...previous, operations };
                });
                return;
            }
            const row = stateRef.current.response?.grants.find(candidate => sessionAccessSubjectKey(candidate.principal) === key);
            const issue = failure(code, machineName, names.current.get(key) ?? row?.display.name ?? undefined,
                mutation.actionId === 'machines.access.grant.set' && row && row.level !== mutation.level
                    ? { draft: mutation.level, current: row.level } : undefined);
            // Replace the previous successful mutation's live-region status too.
            announceAccessibilityMessage(issue.message);
            if (isAuthorityLoss(code)) { clearProjection(issue); return; }
            setState(previous => ({ ...previous, operations: { ...previous.operations,
                [key]: { kind: 'error', error: issue } } }));
        };
        const settle = async (value: unknown) => {
            if (lifetime.signal.aborted) return;
            const parsed = mutation.actionId === 'machines.access.prepareKeys'
                ? MachineKeyPreparationResultV1Schema.safeParse(value) : MachineAccessMutationResultV1Schema.safeParse(value);
            if (!parsed.success) { fail('machine_access_invalid_response'); return; }
            if (parsed.data.kind === 'refused') { fail(parsed.data.code); return; }
            if (parsed.data.kind === 'unavailable') { fail(parsed.data.code); return; }
            if (parsed.data.kind === 'recipient_incompatible') { fail('recipient_incompatible'); return; }
            // Keep the acknowledged intent visible until its authoritative projection is loaded;
            // clearing it first briefly displays the old level while the read is in flight.
            if (parsed.data.kind !== 'left' || parsed.data.effectiveAccess !== 'none') await load();
            if (lifetime.signal.aborted) return;
            intents.current.delete(key);
            setState(previous => {
                const { [key]: _settled, ...operations } = previous.operations;
                if (parsed.data.kind === 'left' && parsed.data.effectiveAccess === 'none') return { ...previous,
                    phase: 'ready', response: null, issue: undefined, operations };
                return { ...previous, operations };
            });
            setNotice(parsed.data.kind === 'pending_holder' ? { code: parsed.data.kind,
                message: t('machines.sharing.pending', { machine: machineName }) } : undefined);
            if (parsed.data.kind !== 'pending_holder') announceAccessibilityMessage(t('machines.sharing.saved'));
            setRevision(value => value + 1);
        };
        const actionRequestId = randomUUID();
        const result = await execute(mutation.actionId, payload, { ...context, actionRequestId, signal: lifetime.signal }).catch(() => null);
        if (lifetime.signal.aborted) return;
        if (!result?.ok) { fail(errorCode(result)); return; }
        const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (pending.success) {
            approval.requestApproval(createActionApprovalContinuation<unknown, Mutation['actionId']>({
                artifactId: pending.data.artifactId, actionId: mutation.actionId, scope,
                expectedInput: payload, expectedRequestId: actionRequestId, signal: lifetime.signal, onSucceeded: settle, onFailed: fail,
            }));
            return;
        }
        await settle(result.result);
    }, [target, context, execute, scope, machineName, approval.requestApproval, load, clearProjection]);

    // Other-person removal uses the row review; a person's own Leave is a direct Action.
    const [confirmingRemoval, setConfirmingRemoval] = React.useState<string | null>(null);
    const canRemove = React.useCallback((ref: PrincipalRefV1) => (canWrite || (canLeave && sessionAccessSubjectKey(ref) === ownKey))
        && !(ref.kind === 'account' && ref.accountId === response?.custodian.accountId), [canWrite, canLeave, ownKey, response]);
    const requestRemove = React.useCallback<ShareSheetActions['requestRemove']>(ref => {
        if (!canRemove(ref)) return;
        const key = sessionAccessSubjectKey(ref);
        if (key === ownKey && canLeave) void mutate({ actionId: 'machines.access.leave', principal: ref });
        else setConfirmingRemoval(key);
    }, [canRemove, ownKey, canLeave, mutate]);
    const confirmRemove = React.useCallback<ShareSheetActions['confirmRemove']>(ref => {
        const key = sessionAccessSubjectKey(ref);
        if (confirmingRemoval !== key || !canRemove(ref)) return;
        setConfirmingRemoval(null);
        void mutate({ actionId: 'machines.access.grant.remove', principal: ref });
    }, [confirmingRemoval, canRemove, mutate]);
    // The work a removal would touch is read only while its review is open.
    const workTargets = React.useMemo(() => confirmingRemoval === null || scope === null ? [] : [{ machineId, scope, online: online ?? null }],
        [confirmingRemoval === null, machineId, scope?.serverId, scope?.accountId, online]);
    const workRead = useMachineWorkSummaries(workTargets);
    const workState = workTargets[0] ? workRead.states.get(machineWorkSummaryKey(workTargets[0])) : undefined;
    const workRequesters = workState?.kind === 'summary' && workState.summary.kind === 'current' ? workState.summary.requesters : null;

    const actions = React.useMemo<ShareSheetActions>(() => ({
        setQuery, retryDirectory: directory.retry, loadMore: directory.loadMore,
        addPrincipal: ref => { const operation = state.operations[sessionAccessSubjectKey(ref)];
            if (canWrite && !(operation?.kind === 'error' && !operation.error.retryable)) void mutate({ actionId: 'machines.access.grant.set', principal: ref, level: 'view' }); },
        setAccessLevel: (ref, level) => { if (canWrite && (level === 'view' || level === 'admin')
            && !response?.grants.some(row => sessionAccessSubjectKey(row.principal) === sessionAccessSubjectKey(ref)
                && row.principal.kind === 'account' && row.audience.some(member => member.reason === 'recipient_encryption_incompatible')))
            void mutate({ actionId: 'machines.access.grant.set', principal: ref, level }); },
        retryMutation: ref => { const intent = intents.current.get(sessionAccessSubjectKey(ref));
            const operation = state.operations[sessionAccessSubjectKey(ref)];
            if (intent && operation?.kind === 'error' && operation.error.retryable && (canWrite || canLeave)) void mutate(intent); },
        requestRemove,
        confirmRemove,
        cancelRemove: () => setConfirmingRemoval(null),
        explain: reason => Modal.alert(t('machines.sharing.title'), reason.message),
    }), [directory.retry, directory.loadMore, canWrite, canLeave, mutate, state.operations, requestRemove, confirmRemove, response]);

    const removal = (ref: PrincipalRefV1, consequences: readonly string[]): MachineShareGrantRow['removal'] => {
        if (ref.kind === 'account' && ref.accountId === response?.custodian.accountId) return { kind: 'blocked',
            reason: { code: 'custodian_protected', message: t('machines.sharing.custodianProtected') } };
        return confirmingRemoval === sessionAccessSubjectKey(ref) ? { kind: 'confirming', consequences } : { kind: 'allowed' };
    };
    const removalConsequences = (losesAccessAccountIds: readonly string[], audience: MachineAccessGrantRowV1['audience'] = []): readonly string[] => {
        const audienceNames = new Map(audience.map(member => [member.accountId, member.displayName]));
        return describeMachineRemovalConsequences({ machine: machineName, requesters: workRequesters,
            people: losesAccessAccountIds.map(accountId => ({ accountId,
                name: principal({ kind: 'account', accountId }, audienceNames.get(accountId) ?? null).displayName })) });
    };
    const grants = React.useMemo<readonly MachineShareGrantRow[]>(() => (response?.canManage ? response.grants : []).map((row): MachineShareGrantRow => {
        const key = sessionAccessSubjectKey(row.principal);
        const operation = state.operations[key] ?? IDLE;
        const draft = intents.current.get(key);
        const incompatible = row.principal.kind === 'account'
            && row.audience.some(member => member.reason === 'recipient_encryption_incompatible');
        const displayName = grantDisplayName(row);
        return { grant: row.principal, principal: principal(row.principal, displayName), readiness: row.readiness,
            audience: row.audience, canPrepareKeys: row.audience.some(member => member.canPrepareKeys),
            level: incompatible ? { kind: 'locked', value: row.level,
                reason: failure('recipient_encryption_incompatible', machineName, displayName ?? undefined) }
                : { kind: 'editable', value: draft?.actionId === 'machines.access.grant.set' ? draft.level : row.level, options: ['view', 'admin'] },
            removal: removal(row.principal, removalConsequences(row.removal.losesAccessAccountIds, row.audience)), operation };
    }), [response, state.operations, machineName, scope?.accountId, viewerProfile, confirmingRemoval, workRequesters, groupDisplayNames]);
    const inherited = (response?.ownAccessSources ?? []).filter(source => source.principal.kind !== 'account');
    const viewerRow: MachineShareGrantRow | null = response && ownPrincipal && ownKey !== null && !isCustodian ? {
        grant: ownPrincipal, principal: principal(ownPrincipal, null), viewer: true,
        readiness: response.access.accessState,
        audience: [], canPrepareKeys: false,
        level: { kind: 'locked', value: response.access.role === 'manage' ? 'admin' : 'view', reason: { code: 'own_access', message: t('machines.sharing.ownHistory', { machine: machineName }) } },
        removal: response.ownDirectGrant ? { kind: 'allowed' } : { kind: 'blocked',
            reason: { code: 'inherited_access', message: t('machines.sharing.inherited', { audience: inherited.map(source => principal(source.principal, sourceDisplayName(source)).displayName).join(', ') }) } },
        operation: state.operations[ownKey] ?? IDLE,
    } : null;
    const model: ShareSheetModel<MachineShareGrantRow> = {
        revision, editable: canWrite, stale: state.phase === 'error',
        owner: response ? { principal: principal({ kind: 'account', accountId: response.custodian.accountId }, response.custodian.displayName) } : null,
        grants, directory: { query, sections: directory.sections.map(section => ({ ...section,
            resolveCandidates: section.resolveCandidates ? async (search, signal) => (await section.resolveCandidates!(search, signal)).map(candidate => {
                names.current.set(candidate.principal.key, candidate.principal.displayName);
                const operation = state.operations[candidate.principal.key];
                return operation?.kind === 'error' && !operation.error.retryable ? { ...candidate, addition: { kind: 'blocked' as const, reason: operation.error } } : candidate;
            }) : undefined,
            candidates: section.candidates.map(candidate => {
                names.current.set(candidate.principal.key, candidate.principal.displayName);
                const operation = state.operations[candidate.principal.key];
                return operation?.kind === 'error' && !operation.error.retryable ? { ...candidate, addition: { kind: 'blocked' as const, reason: operation.error } } : candidate;
            }),
        })) },
    };
    const unknownOperation = Object.values(state.operations).find(operation => operation.kind === 'error' && operation.error.code === 'outcome_unknown');
    const audience = React.useMemo<readonly PrincipalRefV1[] | undefined>(() => canWrite && response
        ? [{ kind: 'account', accountId: response.custodian.accountId }, ...response.grants.map(row => row.principal)]
        : undefined, [canWrite, response]);
    return { model, actions, response, guestExecution, viewerRow, inherited, canLeave, loading: scope !== null && (state.phase === 'initial' || readSettling), issue: scope === null || readSettling ? undefined : state.issue,
        audience,
        notice: unknownOperation?.kind === 'error' ? unknownOperation.error : notice, retryContent: load, approvalId: approval.approvalId,
        prepareKeys: (ref: PrincipalRefV1) => { if (canWrite && response?.grants.some(row =>
            sessionAccessSubjectKey(row.principal) === sessionAccessSubjectKey(ref) && row.audience.some(member => member.canPrepareKeys)))
            void mutate({ actionId: 'machines.access.prepareKeys', principal: ref }); } };
}
