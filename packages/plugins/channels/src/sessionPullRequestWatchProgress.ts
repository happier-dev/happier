import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { SessionPullRequestUpdateV1Schema, type SessionPullRequestFixProgressV1,
    type SessionPullRequestUpdateV1, type SessionPullRequestConfiguredFixInputV1, type ConversationBindingV1,
    type ConversationPullRequestFixResolutionV1 } from '@happier-dev/channels-protocol/v1';
import { CHANNEL_STATE_COLLECTION, SessionPullRequestConfiguredFixCustodySchema } from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { commitConversationBindingMutation, readConversationBindingUpdateRow, readConversationConnectionUpdateRow,
    withConversationBindingPolicy, type ChannelStateRow } from './accountLocalBindingPolicy.js';
import { advanceSessionPullRequestFixProgress, isSessionPullRequestFixSequenceExhausted,
    readSessionPullRequestWatchPolicy } from './sessionPullRequestWatchPolicy.js';
import type { SessionPullRequestWatchContext } from './sessionPullRequestWatch.js';

type ProgressContext = Pick<SessionPullRequestWatchContext, 'services' | 'signal'>;
type BindingRead = Readonly<{ row: ChannelStateRow; binding: ConversationBindingV1;
    /** Read-only recovery evidence for the incumbent ingress lifecycle writer. */
    unstartedPreparation?: ChannelStateRow;
}>;
const initialProgress = (): SessionPullRequestFixProgressV1 => ({ roundsStarted: 0, continuationRounds: 0 });
function record(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function error(code: string): PluginError {
    return new PluginError({ code, message: 'The PR fixing input or binding changed; retain its custody and retry the current state.', retryable: true });
}
async function read(bindingId: string, context: ProgressContext): Promise<BindingRead | null> {
    const row = await requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION).get(bindingId, { signal: context.signal });
    if (!row) return null;
    const { binding } = readConversationBindingUpdateRow({ row, bindingId });
    if (binding.target.kind !== 'session' || !binding.target.pullRequestLink || binding.deletionState !== 'none') return null;
    return { row, binding };
}
async function write(current: BindingRead, progress: SessionPullRequestFixProgressV1, context: ProgressContext,
    observedEnding?: Readonly<{ row: ChannelStateRow; value?: Readonly<Record<string, JsonValue>> }>,
    newObligation?: Readonly<Record<string, JsonValue>>): Promise<BindingRead> {
    if (current.binding.target.kind !== 'session' || !current.binding.target.pullRequestWatch) throw error('channels_pr_round_binding_unavailable');
    const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
    const connectionRow = await collection.get(current.binding.connectionId, { signal: context.signal });
    if (!connectionRow) throw error('channels_pr_round_binding_unavailable');
    const connection = readConversationConnectionUpdateRow({ row: connectionRow, connectionId: current.binding.connectionId });
    if (connection.lifecycle.deletionState !== 'none') throw error('channels_pr_round_binding_unavailable');
    const parsed = readConversationBindingUpdateRow({ row: current.row, bindingId: current.binding.id });
    const binding = { ...current.binding, target: { ...current.binding.target,
        pullRequestWatch: { ...current.binding.target.pullRequestWatch, progress } } };
    const updatedAt = Date.now();
    const result = await commitConversationBindingMutation({ collection, row: current.row,
        current: parsed, connectionRow, binding,
        additionalMutations: [...(observedEnding === undefined ? [] : [observedEnding.value === undefined
            ? { kind: 'assert' as const, rowId: observedEnding.row.rowId, expectedRevision: observedEnding.row.revision }
            : { kind: 'put' as const, value: observedEnding.value, expectedRevision: observedEnding.row.revision }]),
            ...(newObligation === undefined ? [] : [{ kind: 'put' as const, value: newObligation, expectedRevision: 'absent' as const }])],
        updatedAt, signal: context.signal });
    if (result.kind !== 'updated') throw error('channels_pr_round_conflict');
    // Continue from this CAS's own value/revision. Do not adopt a later read's
    // unrelated progress as though this invocation had committed it.
    return { binding, row: { rowId: current.row.rowId, revision: result.revision,
        value: withConversationBindingPolicy({ row: current.row, current: parsed, binding, updatedAt }) } };
}

/** A preparation refusal proves no Session send began; never release accepted or uncertain input custody. */
export async function releaseSessionPullRequestFixPreparation(input: Readonly<{
    bindingId: string; obligationId: string;
}>, context: ProgressContext): Promise<void> {
    const current = await read(input.bindingId, context);
    if (!current || current.binding.target.kind !== 'session') return;
    const progress = current.binding.target.pullRequestWatch?.progress;
    const active = progress?.activeRound;
    if (!progress || !active || active.obligationId !== input.obligationId || active.started || active.localId !== undefined) return;
    const original = await requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION).get(input.obligationId, { signal: context.signal });
    const payload = original?.value.payload;
    if (!original || original.value['binding-id'] !== input.bindingId || !record(payload)
        || payload.sessionInput !== undefined || payload.prRoundPrepared === true) return;
    await write(current, finishActiveRound(progress), context, { row: original });
}
function finishActiveRound(progress: SessionPullRequestFixProgressV1): SessionPullRequestFixProgressV1 {
    const { activeRound: _active, pendingSequenceEnd, ...retained } = progress;
    return pendingSequenceEnd === true ? advanceSessionPullRequestFixProgress(retained, { kind: 'otherWriterPush' }) : retained;
}

/** The source's admitted snapshot proves current-head resolution; input custody remains authoritative here. */
export function resolveSessionPullRequestFixResolutionProgress(progress: SessionPullRequestFixProgressV1,
    resolution: ConversationPullRequestFixResolutionV1 | undefined): SessionPullRequestFixProgressV1 {
    if (!resolution?.resolved || resolution.incomplete || progress.activeRound) return progress;
    return advanceSessionPullRequestFixProgress(progress, { kind: 'outstandingWorkResolved' });
}

/** Reconcile one incumbent input, never transcript/history scans or send-as-start inference. */
export async function reconcileSessionPullRequestFixProgress(bindingId: string, context: ProgressContext): Promise<BindingRead | null> {
    let current = await read(bindingId, context);
    if (!current || current.binding.target.kind !== 'session') return current;
    const target = current.binding.target;
    const progress = target.pullRequestWatch?.progress;
    const active = progress?.activeRound;
    if (!progress || !active) return current;
    const original = await requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION).get(active.obligationId, { signal: context.signal });
    const payload = original?.value.payload;
    if (!original || original.value['binding-id'] !== bindingId || !record(payload)) throw error('channels_pr_round_input_unavailable');
    const configured = SessionPullRequestConfiguredFixCustodySchema.safeParse(payload);
    const parsed = configured.success ? undefined : SessionPullRequestUpdateV1Schema.safeParse(payload.prUpdate);
    const update = configured.success ? configured.data.request : parsed?.success ? parsed.data : undefined;
    if (!update || update.bindingId !== bindingId || update.sessionId !== target.sessionId
        || update.pullRequest.repository !== target.pullRequestLink?.repository
        || update.pullRequest.number !== target.pullRequestLink?.number) throw error('channels_pr_round_input_unavailable');
    const accepted = payload.sessionInput;
    const configuredResult = configured.success ? configured.data.result : undefined;
    const localId = configuredResult && 'localId' in configuredResult && typeof configuredResult.localId === 'string' ? configuredResult.localId
        : record(accepted) && accepted.sessionId === target.sessionId && typeof accepted.localId === 'string'
        ? accepted.localId : active.localId;
    if (!localId) {
        // An unaccepted known-no-effect input can release the pointer; an
        // uncertain attempt remains the one outstanding incumbent obligation.
        if (configuredResult && 'status' in configuredResult && configuredResult.status === 'rejected'
            || !configured.success && original.value.terminal === true && payload.disposition !== 'admitted') {
            return write(current, finishActiveRound(progress), context);
        }
        const lifecycle = payload.lifecycle;
        const sourceAuthority = payload.sourceAuthority;
        const frozenTarget = payload.target;
        if (!active.started && readSessionPullRequestWatchPolicy(current.binding).mode === 'autoFix'
            && payload.prRoundPrepared !== true && accepted === undefined && record(lifecycle) && lifecycle.phase === 'blocked'
            && record(sourceAuthority)
            && record(frozenTarget) && frozenTarget.kind === 'session' && frozenTarget.sessionId === target.sessionId) {
            return { ...current, unstartedPreparation: original };
        }
        return current;
    }
    const result = await context.services.actions.execute('session.input.result.get', { sessionId: target.sessionId, localId }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result) || !result.ok || !('result' in result)
        || result.sessionId !== target.sessionId || result.localId !== localId) return current;
    const started = result.turnStartWitnessId !== undefined && result.turnStartWitnessId === result.acceptedTurnId;
    let next = progress;
    if (started && !active.started) {
        const failed = 'events' in update ? update.events.find(event => event.kind === 'check' && event.state === 'failed') : undefined;
        next = { ...advanceSessionPullRequestFixProgress(progress, { kind: 'fixingRoundStarted', alreadyCounted: false,
            cause: progress.cause ?? (configured.success ? { kind: 'configuredFix' }
                : failed?.kind === 'check' ? { kind: 'check', logicalCheckId: failed.logicalCheckId } : { kind: 'feedback' }),
            sourceHeadSha: 'expectedHeadSha' in update ? update.expectedHeadSha : update.head.sha }), activeRound: { ...active, localId, started: true } };
    }
    else if (active.localId !== localId) next = { ...progress, activeRound: { ...active, localId } };
    if (result.result.kind !== 'pending' && (started || result.result.kind === 'cancelled' || result.result.kind === 'failed')) {
        // Turn completion releases custody only. It never resolves PR feedback
        // or clears the consumed sequence allowance, including diagnosis/asks.
        next = finishActiveRound(next);
    }
    if (next !== progress) current = await write(current, next, context);
    return current;
}

/** Claim this existing frozen obligation, without charging queued/uncertain work. */
export async function admitSessionPullRequestFixRound(input: Readonly<{
    bindingId: string; obligationId: string; update: SessionPullRequestUpdateV1 | SessionPullRequestConfiguredFixInputV1; fixAttemptLimit: number | null;
    /** Atomically retain a configured cause with the same incumbent round reservation. */
    newObligation?: Readonly<Record<string, JsonValue>>;
    expectedRevision?: number;
    /** Auto-fix checks the allowance before preparation, then claims only after preparation succeeds. */
    reserve?: boolean;
}>, context: ProgressContext): Promise<'ready' | 'outstanding' | 'exhausted'> {
    let current = await reconcileSessionPullRequestFixProgress(input.bindingId, context);
    if (!current || current.binding.target.kind !== 'session') throw error('channels_pr_round_binding_unavailable');
    if (input.newObligation !== undefined && current.row.revision !== input.expectedRevision) throw error('channels_pr_round_conflict');
    const target = current.binding.target;
    if (target.sessionId !== input.update.sessionId || input.update.bindingId !== current.binding.id
        || target.pullRequestLink?.repository !== input.update.pullRequest.repository
        || target.pullRequestLink?.number !== input.update.pullRequest.number) throw error('channels_pr_round_input_unavailable');
    const mode = readSessionPullRequestWatchPolicy(current.binding).mode;
    if (mode !== 'address' && mode !== 'autoFix') throw error('channels_pr_round_mode_changed');
    let progress = target.pullRequestWatch?.progress ?? initialProgress();
    if ('events' in input.update && input.update.events.some(event => event.kind === 'push' && event.writer === 'other')) {
        const original = await requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION).get(input.obligationId, { signal: context.signal });
        const payload = original?.value.payload;
        if (!original || original.value['binding-id'] !== input.bindingId || !record(payload)) throw error('channels_pr_round_input_unavailable');
        if (payload.prSequenceEndObserved !== true) {
            // Record the ending once in its original custody, atomically with
            // progress. A queued prior input is accounted before the reset;
            // replaying this same observed push cannot renew a later budget.
            progress = progress.activeRound ? { ...progress, pendingSequenceEnd: true }
                : advanceSessionPullRequestFixProgress(progress, { kind: 'otherWriterPush' });
            current = await write(current, progress, context, { row: original,
                value: { ...original.value, payload: { ...payload, prSequenceEndObserved: true } } });
        }
    }
    if (progress.activeRound) return progress.activeRound.obligationId === input.obligationId ? 'ready' : 'outstanding';
    if (isSessionPullRequestFixSequenceExhausted(progress, input.fixAttemptLimit)) return 'exhausted';
    if (input.reserve === false) return 'ready';
    const failed = 'events' in input.update ? input.update.events.find(event => event.kind === 'check' && event.state === 'failed') : undefined;
    await write(current, { ...progress,
        cause: 'events' in input.update
            ? failed?.kind === 'check' ? { kind: 'check', logicalCheckId: failed.logicalCheckId } : { kind: 'feedback' }
            : { kind: 'configuredFix' },
        sourceHeadSha: 'expectedHeadSha' in input.update ? input.update.expectedHeadSha : input.update.head.sha,
        activeRound: { obligationId: input.obligationId, started: false } }, context, undefined, input.newObligation);
    return 'ready';
}

/** The local id is host-derived; a successful send alone still charges nothing. */
export async function recordSessionPullRequestFixInput(input: Readonly<{
    bindingId: string; obligationId: string; localId: string;
}>, context: ProgressContext): Promise<void> {
    const current = await read(input.bindingId, context);
    if (!current || current.binding.target.kind !== 'session') throw error('channels_pr_round_binding_unavailable');
    const progress = current.binding.target.pullRequestWatch?.progress;
    if (!progress?.activeRound || progress.activeRound.obligationId !== input.obligationId) throw error('channels_pr_round_input_changed');
    if (progress.activeRound.localId !== input.localId) await write(current, { ...progress,
        activeRound: { ...progress.activeRound, localId: input.localId } }, context);
    await reconcileSessionPullRequestFixProgress(input.bindingId, context);
}
