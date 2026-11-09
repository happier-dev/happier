import * as React from 'react';
import type { DiscussionAnswerPolicyV1, DiscussionParticipantsListResponseV1 } from '@happier-dev/protocol/discussions/participants';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import type { ResourceCallerAccessV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { randomUUID } from '@/platform/randomUUID';
import { normalizeExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { resolveExecutableModelParticipantDisplay } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { watchMountedDiscussions } from '@/sync/domains/discussions/discussionChangeWatch';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

type Participant = DiscussionParticipantsListResponseV1['participants'][number];
/** Admitted roster rows keep their identity across fresh reads and membership reordering. */
export function reconcileDiscussionParticipantRoster(previous: DiscussionParticipantsListResponseV1, incoming: DiscussionParticipantsListResponseV1): DiscussionParticipantsListResponseV1 {
    const participants = retainKeyedRows(previous.participants, incoming.participants, row => row.participant.kind === 'session'
        ? `session:${row.participant.sessionId}` : `model:${row.participant.participantSlotId}`);
    const grants = retainKeyedRows(previous.grants, incoming.grants, row => {
        const principal = row.principal;
        return JSON.stringify(principal.kind === 'account' ? [principal.kind, principal.accountId]
            : principal.kind === 'team' ? [principal.kind, principal.teamId] : [principal.kind, principal.teamId, principal.groupId]);
    });
    const accountActors = incoming.accountActors === undefined ? undefined
        : retainKeyedRows(previous.accountActors ?? [], incoming.accountActors, actor => actor.accountId);
    return participants === previous.participants && grants === previous.grants && accountActors === previous.accountActors
        && previous.ownerAccountId === incoming.ownerAccountId && previous.access === incoming.access
        && previous.discussionId === incoming.discussionId ? previous : { ...incoming, participants, grants,
            ...(accountActors === undefined ? {} : { accountActors }) };
}
type PolicyParticipant = Parameters<DiscussionRepository['setParticipantPolicy']>[0]['participant'];
type RemovedParticipant = Parameters<DiscussionRepository['removeParticipant']>[0]['participant'];
type Intent =
    | Readonly<{ kind: 'invite'; input: Parameters<DiscussionRepository['inviteExecutableParticipant']>[0] }>
    | Readonly<{ kind: 'policy'; participant: PolicyParticipant; answerPolicy: DiscussionAnswerPolicyV1 }>
    | Readonly<{ kind: 'remove'; participant: RemovedParticipant }>
    | Readonly<{ kind: 'transfer'; accountId: string; phase: 'transfer' | 'leave' }>
    | Readonly<{ kind: 'leave' | 'archive' }>;
type Action = Intent['kind'];
type ModelAttempt = Readonly<{ participantSlotId: string; sessionStart?: SessionSpawnNewResultV1 }>;
function isModelInvitation(intent: Intent | undefined): boolean {
    return intent?.kind === 'invite' && normalizeExecutableParticipantSelectionV1(intent.input.selection)?.kind === 'model';
}
type Outcome = Awaited<ReturnType<DiscussionRepository['inviteExecutableParticipant']>>
    | Awaited<ReturnType<DiscussionRepository['removeParticipant']>>
    | Awaited<ReturnType<DiscussionRepository['leave']>>
    | Awaited<ReturnType<DiscussionRepository['archive']>>;
export type DiscussionParticipantManagementOperation =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'working'; action: Action }>
    | Readonly<{ kind: 'succeeded'; action: Action; remainingAccess?: ResourceCallerAccessV1 | null }>
    | Readonly<{ kind: 'approval_pending'; action: Action; artifactId: string }>
    | Readonly<{ kind: 'checking'; action: Action; errorCode?: string }>
    | Readonly<{ kind: 'failed'; action: Action; errorCode: string }>;
const IDLE = Object.freeze({ kind: 'idle' } as const);
export type DiscussionModelParticipantBirth =
    | Readonly<{ kind: 'starting' }>
    | Readonly<{ kind: 'started'; session: Readonly<{ serverId: string; sessionId: string }> }>
    | Readonly<{ kind: 'failed'; errorCode: string; sessionStart?: Extract<SessionSpawnNewResultV1, { type: 'error' }> }>
    | Readonly<{ kind: 'unknown'; reason: 'not_observed' | 'outcome_unknown' | 'approval_pending' | 'pending' }>;
export type DiscussionModelParticipantViewModel = Readonly<{
    participantSlotId: string;
    display: ReturnType<typeof resolveExecutableModelParticipantDisplay>;
    birth: DiscussionModelParticipantBirth;
    canRetry: boolean;
}>;

/** The demanded roster remains bound to the same captured Account as its Discussion repository. */
export function useDiscussionParticipantManagement(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
    discussionId: string;
    repository: DiscussionRepository;
    enabled: boolean;
    summary: DiscussionOpenedSummaryV1 | null;
}>) {
    const { accountLifetime, discussionId, repository } = input;
    const current = React.useRef(input);
    current.current = input;
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const isCurrent = React.useCallback(() => current.current.accountLifetime === accountLifetime
        && mounted.current && current.current.discussionId === discussionId && current.current.enabled && accountLifetime?.isCurrent() === true,
    [accountLifetime, discussionId]);
    const subscribe = React.useCallback((notify: () => void) => {
        const retirement = accountLifetime?.onRetire(notify);
        return () => retirement?.dispose();
    }, [accountLifetime]);
    const live = React.useSyncExternalStore(subscribe, () => accountLifetime?.isCurrent() === true, () => false);
    const [load, setLoad] = React.useState<Readonly<{ accountLifetime: ServerAccountScopeLifetime | null; discussionId: string;
        status: 'loading' | 'ready' | 'error'; errorCode: string | null }> | null>(null);
    const [projection, setProjection] = React.useState<Readonly<{
        accountLifetime: ServerAccountScopeLifetime; discussionId: string; roster: DiscussionParticipantsListResponseV1;
    }> | null>(null);
    const roster = projection?.accountLifetime === accountLifetime && projection.discussionId === discussionId
        && input.enabled && live ? projection.roster : null;
    const latestRead = React.useRef<ReturnType<DiscussionRepository['participants']> | null>(null);
    const refresh = React.useCallback(async (signal?: AbortSignal) => {
        if (!isCurrent() || !accountLifetime || signal?.aborted) return;
        setLoad(previous => previous?.accountLifetime === accountLifetime && previous.discussionId === discussionId
            && previous.errorCode === null ? previous : { accountLifetime, discussionId, status: 'loading', errorCode: null });
        const read = repository.participants(discussionId, signal);
        latestRead.current = read;
        try {
            const outcome = await read;
            // An earlier read cannot undo a newer membership/policy admission.
            if (latestRead.current !== read || !isCurrent() || signal?.aborted) return;
            if (outcome.kind === 'succeeded') {
                setProjection(previous => {
                    const sameDiscussion = previous?.accountLifetime === accountLifetime && previous.discussionId === discussionId;
                    const roster = sameDiscussion ? reconcileDiscussionParticipantRoster(previous.roster, outcome.value) : outcome.value;
                    return sameDiscussion && roster === previous.roster ? previous : { accountLifetime, discussionId, roster };
                });
                setLoad(previous => previous?.accountLifetime === accountLifetime && previous.discussionId === discussionId
                    && previous.status === 'ready' && previous.errorCode === null ? previous
                    : { accountLifetime, discussionId, status: 'ready', errorCode: null });
            } else {
                if (repository.getSnapshot().threads[discussionId]?.status === 'revoked') setProjection(null);
                setLoad({ accountLifetime, discussionId, status: 'error', errorCode: outcome.kind === 'failed' ? outcome.errorCode : 'approval_request_created' });
            }
            return outcome;
        } catch {
            if (latestRead.current === read && isCurrent() && !signal?.aborted) setLoad({ accountLifetime, discussionId, status: 'error', errorCode: 'offline' });
        } finally { if (latestRead.current === read) latestRead.current = null; }
    }, [accountLifetime, discussionId, isCurrent, repository]);
    React.useEffect(() => {
        if (!input.enabled || !accountLifetime?.isCurrent()) return;
        const abort = new AbortController();
        const retirement = accountLifetime.onRetire(() => abort.abort());
        // AccountChange coalesces by resource, not mutation subtype. The exact
        // Discussion invalidation must re-admit its roster, including policy/access.
        const watch = watchMountedDiscussions({ scope: accountLifetime.scope, address: { serverId: accountLifetime.scope.serverId },
            onInvalidated: discussionIds => { if (discussionIds.includes(discussionId)) void refresh(abort.signal); } });
        void refresh(abort.signal);
        return () => { watch.dispose(); retirement.dispose(); abort.abort(); };
    }, [accountLifetime, discussionId, input.enabled, refresh]);
    const [result, setResult] = React.useState<Readonly<{ accountLifetime: ServerAccountScopeLifetime | null;
        discussionId: string; operation: DiscussionParticipantManagementOperation; modelAttempt?: ModelAttempt }> | null>(null);
    const currentResult = result?.accountLifetime === accountLifetime && result.discussionId === discussionId && live && input.enabled ? result : null;
    const operation = currentResult?.operation ?? IDLE;
    const retained = React.useRef<Readonly<{ accountLifetime: ServerAccountScopeLifetime | null; discussionId: string; intent: Intent }> | null>(null);
    const busy = React.useRef<Readonly<{ accountLifetime: ServerAccountScopeLifetime; discussionId: string; abort: AbortController }> | null>(null);
    React.useEffect(() => {
        setResult(previous => previous?.modelAttempt ? null : previous);
        if (isModelInvitation(retained.current?.intent)) retained.current = null;
        return () => {
            const attempt = busy.current;
            if (!attempt || attempt.accountLifetime !== accountLifetime || attempt.discussionId !== discussionId) return;
            // Demand-close retires local model-start evidence, not an unrelated
            // durable approval or a possibly committed owner effect.
            if (mounted.current && current.current.accountLifetime === accountLifetime
                && current.current.discussionId === discussionId && !isModelInvitation(retained.current?.intent)) return;
            attempt.abort.abort();
            if (busy.current === attempt) busy.current = null;
        };
    }, [accountLifetime, discussionId, input.enabled]);
    const [leaveResolution, setLeaveResolution] = React.useState<Readonly<{ accountLifetime: ServerAccountScopeLifetime | null; discussionId: string }> | null>(null);
    const publish = React.useCallback((next: DiscussionParticipantManagementOperation, modelAttempt?: ModelAttempt) => {
        if (isCurrent()) setResult({ accountLifetime, discussionId, operation: next, ...(modelAttempt ? { modelAttempt } : {}) });
    }, [accountLifetime, discussionId, isCurrent]);
    const run = React.useCallback(async (intent: Intent): Promise<Outcome | undefined> => {
        if (!isCurrent() || !accountLifetime || busy.current?.accountLifetime === accountLifetime && busy.current.discussionId === discussionId) return;
        const attempt = { accountLifetime, discussionId, abort: new AbortController() };
        const signal = attempt.abort.signal;
        const retirement = accountLifetime.onRetire(() => attempt.abort.abort());
        busy.current = attempt;
        retained.current = { accountLifetime, discussionId, intent };
        let modelAttempt: ModelAttempt | undefined = intent.kind === 'invite' && intent.input.participantSlotId
            && normalizeExecutableParticipantSelectionV1(intent.input.selection)?.kind === 'model'
            ? { participantSlotId: intent.input.participantSlotId } : undefined;
        let action: Action = intent.kind === 'transfer' && intent.phase === 'leave' ? 'leave' : intent.kind;
        publish({ kind: 'working', action }, modelAttempt);
        try {
            let outcome: Outcome;
            if (intent.kind === 'transfer') {
                if (intent.phase === 'transfer') {
                    const transferred = await repository.transferOwner({ discussionId, accountId: intent.accountId }, signal);
                    if (!isCurrent() || signal?.aborted) return transferred;
                    if (transferred.kind !== 'succeeded') outcome = transferred;
                    else if (transferred.value.ownerAccountId !== intent.accountId) outcome = { kind: 'failed', errorCode: 'outcome_unknown' };
                    else if (transferred.value.ownerAccountId === accountLifetime.scope.accountId) outcome = { kind: 'failed', errorCode: 'discussion_owner_transfer_required' };
                    else {
                        // Only an acknowledged transfer admits the next explicit effect. Unknown
                        // transfers retain this exact target; unknown Leaves retry only the Leave.
                        retained.current = { accountLifetime, discussionId, intent: { ...intent, phase: 'leave' } };
                        action = 'leave'; publish({ kind: 'working', action });
                        outcome = await repository.leave(discussionId, signal);
                    }
                } else outcome = await repository.leave(discussionId, signal);
            } else if (intent.kind === 'invite') {
                const invited = await repository.inviteExecutableParticipant(intent.input, signal);
                const start = 'value' in invited ? invited.value?.sessionStart : undefined;
                if (modelAttempt && start) modelAttempt = { ...modelAttempt, sessionStart: start };
                outcome = invited;
            }
            else if (intent.kind === 'policy') outcome = await repository.setParticipantPolicy({ discussionId, participant: intent.participant, answerPolicy: intent.answerPolicy }, signal);
            else if (intent.kind === 'remove') outcome = await repository.removeParticipant({ discussionId, participant: intent.participant }, signal);
            else if (intent.kind === 'archive') outcome = await repository.archive(discussionId, signal);
            else outcome = await repository.leave(discussionId, signal);
            if (!isCurrent() || signal?.aborted) return outcome;
            // A failed/uncertain birth may have committed its slot. Re-read the
            // demanded roster, without manufacturing a local participant row.
            if (modelAttempt && outcome.kind !== 'approval_request_created') {
                await refresh(signal);
                if (!isCurrent() || signal?.aborted) return outcome;
            }
            if (outcome.kind === 'approval_request_created') publish({ kind: 'approval_pending', action, artifactId: outcome.artifactId }, modelAttempt);
            else if (outcome.kind === 'checking') publish({ kind: 'checking', action }, modelAttempt);
            else if (outcome.kind === 'failed') publish({ kind: outcome.errorCode === 'outcome_unknown' ? 'checking' : 'failed', action, errorCode: outcome.errorCode }, modelAttempt);
            else {
                retained.current = null;
                const access = 'access' in outcome.value ? outcome.value.access : undefined;
                publish({ kind: 'succeeded', action, ...(action === 'leave' ? { remainingAccess: access } : {}) }, modelAttempt);
                if (action === 'leave' || action === 'archive') setLeaveResolution(null);
                if (action === 'leave' && access === null) setProjection(null);
                else if (!modelAttempt) await refresh(signal);
            }
            return outcome;
        } catch {
            if (!signal.aborted) publish({ kind: 'checking', action, errorCode: 'outcome_unknown' }, modelAttempt);
            return { kind: 'failed', errorCode: 'outcome_unknown' };
        } finally {
            retirement.dispose();
            if (busy.current === attempt) busy.current = null;
        }
    }, [accountLifetime, discussionId, isCurrent, publish, refresh, repository]);
    const requestLeave = React.useCallback(async () => {
        if (!isCurrent() || !roster) return;
        if (roster.ownerAccountId === accountLifetime?.scope.accountId) setLeaveResolution({ accountLifetime, discussionId });
        else return run({ kind: 'leave' });
    }, [accountLifetime, discussionId, isCurrent, roster, run]);
    const unresolvedOwnerEffect = (operation.kind === 'working' || operation.kind === 'checking' || operation.kind === 'approval_pending')
        && (operation.action === 'transfer' || operation.action === 'leave' || operation.action === 'archive');
    const ownerLeave = React.useMemo(() => leaveResolution?.accountLifetime === accountLifetime
        && leaveResolution.discussionId === discussionId && live && roster ? {
            kind: 'transfer_or_archive' as const,
            // These are existing invitees to choose from, not a second eligibility policy.
            // The transfer Action rechecks active membership, mode and recipient-key readiness.
            transferCandidates: roster.grants.flatMap(grant => grant.principal.kind === 'account'
                && grant.principal.accountId !== roster.ownerAccountId ? [{ accountId: grant.principal.accountId }] : []),
            canArchive: input.summary?.capabilities.archive === true,
            canCancel: !unresolvedOwnerEffect,
        } : { kind: 'closed' as const }, [accountLifetime, discussionId, input.summary?.capabilities.archive, leaveResolution, live, roster, unresolvedOwnerEffect]);
    const inviteExecutable = React.useCallback((selection: ExecutableParticipantSelectionV1,
        options?: Readonly<{ participantSlotId?: string; answerPolicy?: DiscussionAnswerPolicyV1 }>) => run({ kind: 'invite', input: {
            discussionId, selection, ...(selection.kind === 'model' ? { participantSlotId: options?.participantSlotId ?? randomUUID() } : {}),
            ...(options?.answerPolicy ? { answerPolicy: options.answerPolicy } : {}),
        } }), [discussionId, run]);
    const setPolicy = React.useCallback((participant: PolicyParticipant, answerPolicy: DiscussionAnswerPolicyV1) => run({ kind: 'policy', participant, answerPolicy }), [run]);
    const remove = React.useCallback((participant: RemovedParticipant) => run({ kind: 'remove', participant }), [run]);
    const transferAndLeave = React.useCallback((accountId: string) => run({ kind: 'transfer', accountId, phase: 'transfer' }), [run]);
    const archiveInsteadOfLeave = React.useCallback(() => run({ kind: 'archive' }), [run]);
    const cancelLeave = React.useCallback(() => {
        // Closing a local sheet cannot cancel a possibly committed effect or a
        // durable approval request. Reconcile it or use its existing review UI.
        if (unresolvedOwnerEffect) return false;
        setLeaveResolution(null);
        return true;
    }, [unresolvedOwnerEffect]);
    const retry = React.useCallback(() => {
        const attempt = retained.current;
        if ((operation.kind !== 'failed' && operation.kind !== 'checking') || attempt?.accountLifetime !== accountLifetime || attempt.discussionId !== discussionId) return;
        if (currentResult?.modelAttempt?.sessionStart?.type === 'error' && currentResult.modelAttempt.sessionStart.retryable === false) return;
        return run(attempt.intent);
    }, [accountLifetime, currentResult, discussionId, operation.kind, run]);
    const sessionAddress = React.useCallback((participant: Participant) => {
        if (!accountLifetime?.isCurrent()) return null;
        const sessionId = participant.participant.kind === 'session' ? participant.participant.sessionId
            : 'sessionId' in participant ? participant.sessionId : null;
        return sessionId ? { serverId: accountLifetime.scope.serverId, sessionId } : null;
    }, [accountLifetime]);
    // Only a model participant's label reads Machine names; a roster without one demands no Machine inventory.
    const namesModel = roster?.participants.some(participant => participant.participant.kind === 'model') === true;
    const machines = useMachineListForServer(accountLifetime?.scope.serverId ?? '', namesModel);
    const modelParticipants = React.useMemo<readonly DiscussionModelParticipantViewModel[]>(() => {
        if (!roster || !accountLifetime?.isCurrent()) return [];
        const unsettled = operation.kind === 'working' || operation.kind === 'approval_pending';
        return roster.participants.flatMap(participant => {
            if (participant.participant.kind !== 'model' || !('launch' in participant)) return [];
            const participantSlotId = participant.participant.participantSlotId;
            const attempt = currentResult?.modelAttempt?.participantSlotId === participantSlotId ? currentResult.modelAttempt : null;
            let birth: DiscussionModelParticipantBirth;
            if (participant.sessionId) birth = { kind: 'started', session: { serverId: accountLifetime.scope.serverId, sessionId: participant.sessionId } };
            else if (!attempt || operation.kind === 'idle' || operation.action !== 'invite') birth = { kind: 'unknown', reason: 'not_observed' };
            else if (operation.kind === 'working') birth = { kind: 'starting' };
            else if (operation.kind === 'failed') birth = { kind: 'failed', errorCode: operation.errorCode,
                ...(attempt.sessionStart?.type === 'error' ? { sessionStart: attempt.sessionStart } : {}) };
            else if (operation.kind === 'approval_pending') birth = { kind: 'unknown', reason: 'approval_pending' };
            else birth = { kind: 'unknown', reason: attempt.sessionStart?.type === 'pending' && attempt.sessionStart.outcome === 'accepted'
                ? 'pending' : 'outcome_unknown' };
            const canRetry = !unsettled && (birth.kind === 'unknown'
                || birth.kind === 'failed' && birth.sessionStart?.retryable !== false)
                && input.summary?.capabilities.manageAccess === true;
            return [{ participantSlotId, display: resolveExecutableModelParticipantDisplay(participant.launch, machines ?? []), birth, canRetry }];
        });
    }, [accountLifetime, currentResult, input.summary?.capabilities.manageAccess, machines, operation, roster]);
    const currentLoad = load?.accountLifetime === accountLifetime && load.discussionId === discussionId && live ? load : null;
    return { roster, status: currentLoad?.status ?? 'idle', errorCode: currentLoad?.errorCode ?? null,
        operation, modelParticipants, ownerLeave, refresh, inviteExecutable, setPolicy, remove, sessionAddress,
        requestLeave, transferAndLeave, archiveInsteadOfLeave, cancelLeave, retry };
}
