import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineAccessGrantsListResponseV1Schema, MachineAccessMutationResultV1Schema,
    MachineKeyPreparationResultV1Schema, type MachineAccessGrantsListResponseV1,
    type MachineAccessLevelV1, type MachineAccessGrantRowV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { t } from '@/text';
import type { ShareGrantRowModel, ShareOperationModel, ShareSheetActions,
    ShareSheetModel, ShareUiError, ShareUiReason } from '../shareSheetTypes';
import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';

export type MachineShareGrantRow = ShareGrantRowModel & Readonly<{
    readiness: 'ready' | 'key_pending' | 'refused';
    audience: MachineAccessGrantRowV1['audience'];
    canPrepareKeys: boolean;
    viewer?: boolean;
}>;
type Mutation = Readonly<{ actionId: 'machines.access.grant.set'; principal: PrincipalRefV1; level: MachineAccessLevelV1 }>
    | Readonly<{ actionId: 'machines.access.grant.remove' | 'machines.access.leave' | 'machines.access.prepareKeys'; principal: PrincipalRefV1 }>;
type State = Readonly<{ response: MachineAccessGrantsListResponseV1 | null; phase: 'initial' | 'ready' | 'error';
    issue?: ShareUiError; operations: Readonly<Record<string, ShareOperationModel>>; confirming: ReadonlySet<string> }>;
const IDLE: ShareOperationModel = { kind: 'idle' };
const NO_TEAMS: readonly [] = [];

function failure(code: string, machine: string, person = t('shareSheet.person')): ShareUiError {
    if (code === 'recipient_encryption_incompatible' || code === 'recipient_incompatible') return { code,
        message: t('machines.sharing.incompatible', { machine, person }), retryable: false };
    if (code === 'access_denied' || code === 'custodian_protected') return { code,
        message: code === 'custodian_protected' ? t('machines.sharing.custodianProtected') : t('machines.sharing.denied', { machine }), retryable: false };
    // An issued mutation without acknowledgement cannot safely be replayed by a row Retry.
    return { code, message: t('machines.sharing.unavailable', { machine }),
        retryable: !['outcome_unknown', 'machine_access_stale_scope', 'unsupported_action', 'approval_rejected', 'approval_canceled'].includes(code) };
}
function errorCode(value: unknown): string {
    if (value && typeof value === 'object') {
        if ('code' in value && typeof value.code === 'string') return value.code;
        if ('errorCode' in value && typeof value.errorCode === 'string') return value.errorCode;
    }
    return 'machine_access_request_failed';
}

/** One Machine's permission projection; all reads and writes use canonical Actions. */
export function useMachineShareController(input: Readonly<{ machineId: string; machineName: string; scope: ServerAccountScope }>) {
    const { machineId, machineName, scope } = input;
    const viewerProfile = useShareViewerProfile(scope);
    const principal = (ref: PrincipalRefV1, name: string | null) => presentSharePrincipal({ ref, name,
        viewerAccountId: scope.accountId, profile: ref.kind === 'account' && ref.accountId === scope.accountId ? viewerProfile : null });
    const identity = `${scope.serverId}:${scope.accountId}:${machineId}`;
    const [execute] = React.useState(() => createFrontDoorActionExecute());
    const lifetimeRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        // Setup owns the lifetime: replayed effects must not reuse a retired signal.
        const lifetime = new AbortController();
        lifetimeRef.current = lifetime;
        return () => { lifetime.abort(); };
    }, [identity]);
    const [state, setState] = React.useState<State>({ response: null, phase: 'initial', operations: {}, confirming: new Set() });
    const [query, setQuery] = React.useState('');
    const [revision, setRevision] = React.useState(0);
    const [notice, setNotice] = React.useState<ShareUiReason>();
    const intents = React.useRef(new Map<string, Mutation>());
    const response = state.response;
    const target = React.useMemo(() => ({ serverId: scope.serverId, machineId }), [scope.serverId, machineId]);
    const context = React.useMemo(() => ({ surface: 'ui' as const, source: 'ui_button' as const, authority: 'present_user' as const,
        serverId: scope.serverId, expectedAccountId: scope.accountId }), [scope.serverId, scope.accountId]);

    const load = React.useCallback(async () => {
        const lifetime = lifetimeRef.current;
        if (!lifetime || lifetime.signal.aborted) return;
        const result = await execute('machines.access.grants.list', target, { ...context, signal: lifetime.signal }).catch(() => null);
        if (lifetime.signal.aborted) return;
        const parsed = result?.ok ? MachineAccessGrantsListResponseV1Schema.safeParse(result.result) : null;
        if (parsed?.success && parsed.data.machineId === machineId) {
            setState(previous => ({ ...previous, response: parsed.data, phase: 'ready', issue: undefined }));
        } else setState(previous => ({ ...previous, phase: 'error', issue: {
            ...failure(result?.ok ? errorCode(result.result) : errorCode(result), machineName),
            message: t('machines.sharing.readError', { machine: machineName }),
        } }));
    }, [execute, target, context, machineId, machineName]);
    React.useEffect(() => {
        const lifetime = lifetimeRef.current;
        if (!lifetime) return;
        // Observe the existing catch-up wake, including roster-only edits whose Machine
        // DTO is unchanged. Keep draft/selection state while replacing only the safe census.
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (!lifetime.signal.aborted && areServerProfileIdentifiersEquivalent(event.serverId, scope.serverId)
                && (event.entityIds === undefined || event.entityIds.includes(machineId))) void load();
        });
        void load();
        return unsubscribe;
    }, [load, scope.serverId, machineId]);
    const approval = useActionApprovalContinuation({ scopeKey: identity, serverId: scope.serverId, onExecuted: () => { void load(); } });
    const directory = useSessionAccessDirectory({ scope, availability: 'available', contextTeams: NO_TEAMS,
        operations: state.operations, revision, enabled: response?.canManage === true && state.phase === 'ready' });
    const names = React.useRef(new Map<string, string>());
    for (const row of response?.grants ?? []) names.current.set(sessionAccessSubjectKey(row.principal), row.display.name ?? principal(row.principal, null).displayName);
    const ownPrincipal = React.useMemo<PrincipalRefV1>(() => ({ kind: 'account', accountId: scope.accountId }), [scope.accountId]);
    const ownKey = sessionAccessSubjectKey(ownPrincipal);
    const isCustodian = response?.custodian.accountId === scope.accountId;
    const canWrite = response?.canManage === true && state.phase === 'ready';
    const canLeave = response?.ownDirectGrant === true && !isCustodian && state.phase === 'ready';

    const mutate = React.useCallback(async (mutation: Mutation) => {
        const lifetime = lifetimeRef.current;
        if (!lifetime || lifetime.signal.aborted) return;
        const key = sessionAccessSubjectKey(mutation.principal);
        intents.current.set(key, mutation);
        setState(previous => ({ ...previous, operations: { ...previous.operations,
            [key]: { kind: mutation.actionId === 'machines.access.grant.remove' || mutation.actionId === 'machines.access.leave' ? 'removing' : 'saving' } } }));
        const payload = mutation.actionId === 'machines.access.grant.set' ? { ...target, principal: mutation.principal, level: mutation.level }
            : mutation.actionId === 'machines.access.grant.remove' ? { ...target, principal: mutation.principal } : target;
        const fail = (code: string) => {
            if (lifetime.signal.aborted) return;
            setState(previous => ({ ...previous, operations: { ...previous.operations,
                [key]: { kind: 'error', error: failure(code, machineName, names.current.get(key)) } } }));
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
                const confirming = new Set(previous.confirming); confirming.delete(key);
                if (parsed.data.kind === 'left' && parsed.data.effectiveAccess === 'none') return { ...previous,
                    phase: 'ready', response: null, issue: undefined, operations, confirming };
                return { ...previous, operations, confirming };
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
    }, [target, context, execute, scope, machineName, approval.requestApproval, load]);

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
        requestRemove: ref => { if (!canWrite && !(canLeave && sessionAccessSubjectKey(ref) === ownKey)) return;
            if (ref.kind === 'account' && ref.accountId === response?.custodian.accountId) return;
            setState(previous => ({ ...previous, confirming: new Set([...previous.confirming, sessionAccessSubjectKey(ref)]) })); },
        confirmRemove: ref => { const key = sessionAccessSubjectKey(ref);
            if (!state.confirming.has(key)) return;
            if (key === ownKey && canLeave) void mutate({ actionId: 'machines.access.leave', principal: ref });
            else if (canWrite && !(ref.kind === 'account' && ref.accountId === response?.custodian.accountId)) void mutate({ actionId: 'machines.access.grant.remove', principal: ref }); },
        cancelRemove: ref => setState(previous => { const confirming = new Set(previous.confirming); confirming.delete(sessionAccessSubjectKey(ref)); return { ...previous, confirming }; }),
        explain: reason => Modal.alert(t('machines.sharing.title'), reason.message),
    }), [directory.retry, directory.loadMore, canWrite, canLeave, mutate, state.operations, state.confirming, ownKey, response]);

    const removal = (ref: PrincipalRefV1, loss: boolean): MachineShareGrantRow['removal'] =>
        ref.kind === 'account' && ref.accountId === response?.custodian.accountId
            ? { kind: 'blocked', reason: { code: 'custodian_protected', message: t('machines.sharing.custodianProtected') } }
            : state.confirming.has(sessionAccessSubjectKey(ref)) ? { kind: 'confirming', consequences: [t(loss ? 'machines.sharing.effectiveLoss' : 'machines.sharing.overlap')] } : { kind: 'allowed' };
    const grants = React.useMemo<readonly MachineShareGrantRow[]>(() => (response?.canManage ? response.grants : []).map((row): MachineShareGrantRow => {
        const key = sessionAccessSubjectKey(row.principal);
        const operation = state.operations[key] ?? IDLE;
        const draft = intents.current.get(key);
        const incompatible = row.principal.kind === 'account'
            && row.audience.some(member => member.reason === 'recipient_encryption_incompatible');
        return { grant: row.principal, principal: principal(row.principal, row.display.name), readiness: row.readiness,
            audience: row.audience, canPrepareKeys: row.audience.some(member => member.canPrepareKeys),
            level: incompatible ? { kind: 'locked', value: row.level,
                reason: failure('recipient_encryption_incompatible', machineName, row.display.name ?? undefined) }
                : { kind: 'editable', value: draft?.actionId === 'machines.access.grant.set' ? draft.level : row.level, options: ['view', 'admin'] },
            removal: removal(row.principal, row.removal.losesAccessAccountIds.length > 0), operation };
    }), [response, state.operations, state.confirming, machineName, scope.accountId, viewerProfile]);
    const inherited = (response?.ownAccessSources ?? []).filter(source => source.principal.kind !== 'account');
    const viewerRow: MachineShareGrantRow | null = response && !isCustodian ? {
        grant: ownPrincipal, principal: principal(ownPrincipal, null), viewer: true,
        readiness: response.access.accessState,
        audience: [], canPrepareKeys: false,
        level: { kind: 'locked', value: response.access.role === 'manage' ? 'admin' : 'view', reason: { code: 'own_access', message: t('machines.sharing.ownHistory', { machine: machineName }) } },
        removal: response.ownDirectGrant ? removal(ownPrincipal, inherited.length === 0) : { kind: 'blocked',
            reason: { code: 'inherited_access', message: t('machines.sharing.inherited', { audience: inherited.map(source => principal(source.principal, source.displayName).displayName).join(', ') }) } },
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
    return { model, actions, response, viewerRow, inherited, canLeave, loading: state.phase === 'initial', issue: state.issue,
        notice, retryContent: load, approvalId: approval.approvalId,
        prepareKeys: (ref: PrincipalRefV1) => { if (canWrite && response?.grants.some(row =>
            sessionAccessSubjectKey(row.principal) === sessionAccessSubjectKey(ref) && row.audience.some(member => member.canPrepareKeys)))
            void mutate({ actionId: 'machines.access.prepareKeys', principal: ref }); } };
}
