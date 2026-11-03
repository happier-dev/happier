import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import { SessionIdSchema, type ActionSessionAddressV1 } from '@happier-dev/plugin-sdk/sessions';
import { SessionPullRequestWatchInputV1Schema, SessionPullRequestWatchReadResultV1Schema,
    SessionPullRequestWatchListResultV1Schema, resolveSessionPullRequestLinksV1,
    type ConversationBindingV1, type SessionPullRequestWatchReadResultV1, type SessionPullRequestWatchResultV1,
} from '@happier-dev/channels-protocol/v1';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_FIELD, CHANNEL_STATE_INDEX_ID, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { readConversationBindingUpdateRow, readConversationConnectionUpdateRow,
    updateConversationBindingPolicyInAccountCollection, type ChannelStateRow } from './accountLocalBindingPolicy.js';
import { readSessionPullRequestBindingRows } from './sessionPullRequestBindings.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { SESSION_PULL_REQUEST_WATCH_SETTINGS, continueSessionPullRequestFixProgress, isSessionPullRequestFixSequenceExhausted, readSessionPullRequestWatchPolicy,
    resolveSessionPullRequestWatchDefaults, type SessionPullRequestWatchDefaults } from './sessionPullRequestWatchPolicy.js';
import { readSessionPullRequestLatestUpdateForBinding, type SessionPullRequestLatestUpdateV1 } from './sessionPullRequestLatestUpdate.js';
import { observeConversationSessionCollections } from './sessionCollectionObservation.js';
import type { PluginAccountStorageConsumerContext } from '@happier-dev/plugin-sdk/storage';
import { deliverSessionPullRequestConfiguredFix } from './sessionPullRequestWatchConfiguredFix.js';
import { readSessionPullRequestProvider } from './providerContributions.js';
import type { SessionPullRequestProvider } from './sessionPullRequestProvider.js';

/** The authored declaration and its portable entry select one exact activation target. */
export const SESSION_PULL_REQUEST_WATCH_ACCOUNT_EXECUTION_V1 = { target: 'account', account: {
    artifactId: 'channels-account-runtime', exportName: 'activate',
} } as const;

export type SessionPullRequestWatchContext = PluginAccountStorageConsumerContext & Readonly<{
    services: Pick<PluginAccountActionContext['services'], 'actions' | 'settings' | 'targetedContributions'>;
    signal: AbortSignal; invokedAtMs: number;
}>;

export async function readSessionPullRequestWatchDefaults(context: SessionPullRequestWatchContext): Promise<SessionPullRequestWatchDefaults> {
    const snapshot = await context.services.settings.forScope({ kind: 'account' }).snapshot({ signal: context.signal });
    return resolveSessionPullRequestWatchDefaults(snapshot.values);
}

async function resolveSessionAddress(sessionId: string, context: SessionPullRequestWatchContext): Promise<ActionSessionAddressV1 | null> {
    const result = await context.services.actions.execute('session.targets.resolve', {
        target: sessionId, actionId: 'session.status.get',
    }, { signal: context.signal });
    return !isPluginActionApprovalRequestCreated(result) && result.coverage === 'complete'
        && result.addresses.length === 1 && result.addresses[0]?.sessionId === sessionId ? result.addresses[0] : null;
}
function bindingSession(binding: ConversationBindingV1): string | undefined {
    return binding.target.kind === 'session' ? binding.target.sessionId
        : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.sessionId : undefined;
}
/** One assembler for exact Session reads, the paged Inbox index and the shared Resource. */
export function assembleSessionPullRequestWatchMetadata(input: Readonly<{
    sessionId: string; rows: readonly ChannelStateRow[]; defaults: SessionPullRequestWatchDefaults; provider: SessionPullRequestProvider;
    watchingMachines?: ReadonlyMap<string, { serverId: string; machineId: string; label: string }>;
    latestUpdates?: ReadonlyMap<string, SessionPullRequestLatestUpdateV1 | null>;
    connectionReasons?: ReadonlyMap<string, 'credentials' | 'paused'>;
}>): Extract<SessionPullRequestWatchReadResultV1, { kind: 'ready' }> {
    const bindings: Array<Extract<SessionPullRequestWatchReadResultV1, { kind: 'ready' }>['bindings'][number]> = [];
    for (const row of input.rows) {
        const { binding } = readConversationBindingUpdateRow({ row, bindingId: row.rowId });
        if (bindingSession(binding) !== input.sessionId || binding.deletionState !== 'none') continue;
        const link = resolveSessionPullRequestLinksV1([binding], input.provider).find(group => group.sessionId === input.sessionId)?.pullRequestLinks[0];
        if (!link) continue;
        const policy = readSessionPullRequestWatchPolicy(binding);
        const progress = binding.target.kind === 'session' ? binding.target.pullRequestWatch?.progress : undefined;
        const terminal = link.state === 'merged' || link.state === 'closed';
        const reason = terminal ? 'terminal' as const : policy.mode !== 'off' && !binding.enabled ? 'paused' as const
            : input.connectionReasons?.get(binding.connectionId) ?? ((policy.mode === 'address' || policy.mode === 'autoFix') && isSessionPullRequestFixSequenceExhausted(progress, input.defaults.fixAttemptLimit)
                ? 'exhausted' as const : null);
        bindings.push({ bindingId: binding.id, revision: row.revision, link,
            watch: { policy, reason, fixAttemptLimit: input.defaults.fixAttemptLimit,
                roundsStarted: progress?.roundsStarted ?? 0, watchingMachine: input.watchingMachines?.get(binding.connectionId) ?? null, ...(progress ? { progress } : {}) },
            latestUpdate: input.latestUpdates?.get(binding.id) ?? null });
    }
    return { kind: 'ready', sessionId: input.sessionId, bindings };
}

async function readResolvedSessionMetadata(sessionId: string, context: SessionPullRequestWatchContext,
    defaults?: SessionPullRequestWatchDefaults) {
    const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
    const [rows, currentDefaults] = await Promise.all([
        readSessionPullRequestBindingRows({ collection, sessionId, signal: context.signal }).then(rows => rows.map(value => value.row)),
        defaults ?? readSessionPullRequestWatchDefaults(context),
    ]);
    if (rows.length === 0) return { kind: 'ready' as const, sessionId, bindings: [] };
    const { contribution } = await readSessionPullRequestProvider({ targetedContributions: context.services.targetedContributions, signal: context.signal });
    const provider = contribution.descriptor.pullRequests!;
    const connectionIds = new Set(rows.flatMap(row => typeof row.value[CHANNEL_STATE_FIELD.connectionId] === 'string'
        ? [row.value[CHANNEL_STATE_FIELD.connectionId] as string] : []));
    const watchingMachines = new Map<string, { serverId: string; machineId: string; label: string }>();
    const connectionReasons = new Map<string, 'credentials' | 'paused'>();
    await Promise.all([...connectionIds].map(async connectionId => {
        const row = await collection.get(connectionId, { signal: context.signal });
        if (!row) return;
        const connection = readConversationConnectionUpdateRow({ row, connectionId });
        if (connection.lifecycle.deletionState !== 'none') return;
        const readiness = connection.lifecycle.providerReadiness?.code;
        if (readiness === 'providerCredentialInvalid' || readiness === 'providerPermissionMissing') connectionReasons.set(connectionId, 'credentials');
        else if (!connection.lifecycle.enabled || readiness !== undefined) connectionReasons.set(connectionId, 'paused');
        watchingMachines.set(connectionId, { serverId: connection.transportOrigin.serverIdentityId,
            machineId: connection.transportOrigin.machineId, label: connection.transportOrigin.machineId });
    }));
    const metadata = assembleSessionPullRequestWatchMetadata({ sessionId, rows, defaults: currentDefaults, provider, watchingMachines, connectionReasons });
    const latestUpdates = new Map(await Promise.all(metadata.bindings.map(async binding => [binding.bindingId,
        await readSessionPullRequestLatestUpdateForBinding({ sessionId, bindingId: binding.bindingId }, context),
    ] as const)));
    return assembleSessionPullRequestWatchMetadata({ sessionId, rows, defaults: currentDefaults, provider, watchingMachines, latestUpdates, connectionReasons });
}
export async function readSessionPullRequestWatchForSession(sessionId: string, context: SessionPullRequestWatchContext,
    defaults?: SessionPullRequestWatchDefaults): Promise<SessionPullRequestWatchReadResultV1> {
    if (!await resolveSessionAddress(sessionId, context)) return { kind: 'unavailable', sessionId, reason: 'sessionUnavailable' };
    return readResolvedSessionMetadata(sessionId, context, defaults);
}

export async function manageSessionPullRequestWatchForInvocation(input: JsonValue, context: SessionPullRequestWatchContext): Promise<SessionPullRequestWatchResultV1> {
    const request = SessionPullRequestWatchInputV1Schema.parse(input);
    const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
    if (request.kind === 'list') {
        const page = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1, prefix: [CHANNEL_STATE_RECORD_KIND.binding, true],
            order: 'asc', limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, ...(request.cursor ? { cursor: request.cursor } : {}) }, { signal: context.signal });
        const ids = new Set(page.rows.flatMap(row => {
            const { binding } = readConversationBindingUpdateRow({ row, bindingId: row.rowId });
            const id = bindingSession(binding);
            return id && binding.deletionState === 'none' ? [id] : [];
        }));
        const defaults = await readSessionPullRequestWatchDefaults(context);
        const pageIds = new Set(page.rows.map(row => row.rowId));
        const sessions = await Promise.all([...ids].map(async sessionId => {
            const first = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1,
                prefix: [CHANNEL_STATE_RECORD_KIND.binding, true, sessionId], order: 'asc', limit: 1 }, { signal: context.signal });
            // A Session group is emitted only on the physical page containing
            // its first indexed PR binding, before reading its complete body group.
            if (!first.rows[0] || !pageIds.has(first.rows[0].rowId)) return undefined;
            const address = await resolveSessionAddress(sessionId, context);
            if (!address) return null;
            const metadata = await readResolvedSessionMetadata(sessionId, context, defaults);
            return metadata.bindings.length > 0 ? { session: address, bindings: metadata.bindings } : undefined;
        }));
        if (sessions.some(session => session === null)) return { kind: 'unavailable', reason: 'sessionUnavailable' };
        return SessionPullRequestWatchListResultV1Schema.parse({ kind: 'ready', sessions: sessions.filter(session => session != null), nextCursor: page.nextCursor ?? null });
    }
    const sessionId = SessionIdSchema.parse(request.sessionId);
    if (request.kind === 'get') return SessionPullRequestWatchReadResultV1Schema.parse(await readSessionPullRequestWatchForSession(sessionId, context));
    if (!await resolveSessionAddress(sessionId, context)) throw new PluginError({ code: 'channels_pr_watch_session_unavailable', message: 'The selected Session is unavailable.' });
    if (request.kind === 'deliverConfiguredFix') return deliverSessionPullRequestConfiguredFix({ ...request, sessionId }, context);
    const row = await collection.get(request.bindingId, { signal: context.signal });
    if (!row || row.revision !== request.expectedRevision) throw new PluginError({ code: 'channels_pr_watch_conflict', message: 'The PR watch binding changed. Refresh before changing it.', retryable: true });
    const { binding } = readConversationBindingUpdateRow({ row, bindingId: row.rowId });
    if (binding.target.kind !== 'session' || binding.target.sessionId !== sessionId || !binding.target.pullRequestLink || binding.deletionState !== 'none') {
        throw new PluginError({ code: 'channels_pr_watch_scope_mismatch', message: 'The binding does not own this Session pull request.' });
    }
    const terminal = binding.endpoint.kind === 'githubPullRequest' && (binding.endpoint.pullRequestState?.state === 'merged' || binding.endpoint.pullRequestState?.state === 'closed');
    if (request.kind === 'retryFix') {
        const policy = readSessionPullRequestWatchPolicy(binding);
        if (terminal || !binding.enabled || (policy.mode !== 'address' && policy.mode !== 'autoFix')) {
            throw new PluginError({ code: 'channels_pr_watch_not_fixing', message: 'Only an active fixing watch can continue.' });
        }
        const { fixAttemptLimit } = await readSessionPullRequestWatchDefaults(context);
        const previous = binding.target.pullRequestWatch?.progress ?? { roundsStarted: 0, continuationRounds: 0 };
        const progress = continueSessionPullRequestFixProgress(previous, { fixAttemptLimit });
        if (progress === previous) throw new PluginError({ code: 'channels_pr_watch_not_exhausted', message: 'The current fixing allowance is not exhausted.' });
        const result = await updateConversationBindingPolicyInAccountCollection({ collection, bindingId: binding.id,
            expectedRevision: request.expectedRevision, target: { ...binding.target, pullRequestWatch: { policy, progress } },
            signal: context.signal, now: () => context.invokedAtMs });
        return { kind: 'updated', bindingId: binding.id, revision: result.revision };
    }
    const result = await updateConversationBindingPolicyInAccountCollection({ collection, bindingId: binding.id,
        expectedRevision: request.expectedRevision, target: { ...binding.target, pullRequestWatch: {
            ...binding.target.pullRequestWatch, policy: request.policy,
        }, policy: { ...binding.target.policy, permissionCeiling: request.policy.mode === 'analyse' ? 'read-only' : 'safe-yolo', approvals: { kind: 'off' } } },
        enabled: request.policy.mode !== 'off' && !terminal, signal: context.signal, now: () => context.invokedAtMs });
    return { kind: 'updated', bindingId: binding.id, revision: result.revision };
}

export function observeSessionPullRequestWatchAction(input: JsonValue, invalidate: () => void, context: SessionPullRequestWatchContext) {
    const request = SessionPullRequestWatchInputV1Schema.parse(input);
    const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
    if (request.kind !== 'get' && request.kind !== 'list') throw new PluginError({ code: 'channels_pr_watch_read_required', message: 'Only PR watch reads can be observed.' });
    const bindings = request.kind === 'get' ? observeConversationSessionCollections(invalidate, {
        accountStorage: requireChannelsAccountStorage(context), sessionId: SessionIdSchema.parse(request.sessionId),
        signal: context.signal, scope: 'pullRequestWatch',
    }) : collection.watch({ index: CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1,
        prefix: [CHANNEL_STATE_RECORD_KIND.binding, true], order: 'asc' }, invalidate);
    const updates = collection.watch(request.kind === 'get'
        ? { index: CHANNEL_STATE_INDEX_ID.bySessionKindBindingUpdateV1,
            prefix: [SessionIdSchema.parse(request.sessionId), CHANNEL_STATE_RECORD_KIND.ingressObligation], order: 'asc' }
        : { index: CHANNEL_STATE_INDEX_ID.byKind, prefix: [CHANNEL_STATE_RECORD_KIND.ingressObligation], order: 'asc' }, invalidate);
    const connections = request.kind === 'list' ? collection.watch({ index: CHANNEL_STATE_INDEX_ID.byKind,
        prefix: [CHANNEL_STATE_RECORD_KIND.connection], order: 'asc' }, invalidate) : undefined;
    const settings = context.services.settings.forScope({ kind: 'account' }).watch(change => {
        if (change.changedIds.includes(SESSION_PULL_REQUEST_WATCH_SETTINGS.fixAttemptLimit)) invalidate();
    });
    const dispose = () => { bindings.dispose(); updates.dispose(); connections?.dispose(); settings.dispose(); context.signal.removeEventListener('abort', dispose); };
    context.signal.addEventListener('abort', dispose, { once: true });
    if (context.signal.aborted) dispose();
    return { dispose };
}
