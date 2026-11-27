import { isPluginError, PluginError, readPluginErrorRequestIdV1, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import type { PluginAccountStorageConsumerContext } from '@happier-dev/plugin-sdk/storage';
import { formatConversationPullRequestUrlV1, SessionPullRequestBindingInputV1Schema, type SessionPullRequestBindingInputV1,
  SessionPullRequestRelationsInputV1Schema, type SessionPullRequestRelationsInputV1,
  type SessionPullRequestBindingResultV1 } from '@happier-dev/channels-protocol/v1';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { readConversationConnectionUpdateRow, type ChannelStateRow as StateRow } from './accountLocalBindingPolicy.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { readSessionPullRequestBindingRows, sessionPullRequestBindingSelection } from './sessionPullRequestBindings.js';
import { readSessionPullRequestProvider } from './providerContributions.js';

export { SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
export const SESSION_PULL_REQUEST_RELATIONS_ACCOUNT_EXECUTION_V1 = { target: 'account', account: {
  artifactId: 'channels-account-runtime', exportName: 'activate',
} } as const;

function pluginError(code: string, message: string, retryable = false): PluginError {
  return new PluginError({ code, message, retryable });
}

/** Account custody needs no Machine; the daemon binding transport uses this same reader. */
export async function readSessionPullRequestRelationsForInvocation(input: JsonValue, context: SessionPullRequestRelationContext): Promise<SessionPullRequestBindingResultV1> {
  const request = SessionPullRequestRelationsInputV1Schema.parse(input);
  return (await selectSessionPullRequestRelations(request, context)).result;
}

/** Exact source relationship reads use only the canonical retained connection/binding rows. */
type SessionPullRequestRelationContext = PluginAccountStorageConsumerContext & Pick<PluginInvocationContext, 'signal' | 'requestId'>
  & { services: Pick<PluginInvocationContext['services'], 'targetedContributions'> };
type RelationRequest = Extract<SessionPullRequestBindingInputV1, { kind: 'readRelations' }> | SessionPullRequestRelationsInputV1;

function relationSelection(input: RelationRequest | Extract<SessionPullRequestBindingInputV1, { kind: 'list' }>) {
  return 'sessionIds' in input ? { sessionIds: new Set<string>(input.sessionIds) }
    : 'sessionId' in input && input.sessionId !== undefined ? { sessionId: SessionIdSchema.parse(input.sessionId) } : {};
}

export async function selectSessionPullRequestRelations(
  input: RelationRequest, context: SessionPullRequestRelationContext,
) {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const { contribution } = await readSessionPullRequestProvider({ targetedContributions: context.services.targetedContributions, signal: context.signal });
  const native = contribution.descriptor.pullRequests!;
  const repositoryIds = new Map<string, string>();
  const connectionIds = new Set<string>();
  const selection = relationSelection(input);
  const pullRequestFilter = 'pullRequest' in input ? input.pullRequest : undefined;
  const matches = (row: StateRow) => {
    const current = readConversationConnectionUpdateRow({ row, connectionId: row.rowId });
    // Credentials select connection execution, not a PR's identity. These rows
    // already belong to the invoking Account; another profile or Machine must
    // see the same exact repository/PR relationship.
    const matching = current.providerPluginId === contribution.contributor.pluginId
      && (pullRequestFilter === undefined || current.payload.providerConnectionKey === `${native.repositoryConnectionKeyPrefix}${pullRequestFilter.repositoryId}`);
    if (matching) {
      const key = current.payload.providerConnectionKey;
      const suffix = typeof key === 'string' && key.startsWith(native.repositoryConnectionKeyPrefix) ? key.slice(native.repositoryConnectionKeyPrefix.length) : undefined;
      const repositoryId = suffix !== undefined && /^[1-9][0-9]*$/u.test(suffix) ? suffix : undefined;
      if (repositoryId === undefined) throw pluginError('channels_pr_link_identity_unavailable', 'The native connection has no exact repository identity.');
      repositoryIds.set(row.rowId, repositoryId);
    }
    return matching;
  };
  const connections = new Map<string, boolean | PluginError>();
  type RelationFailure = NonNullable<Extract<SessionPullRequestBindingResultV1, { kind: 'relations' }>['failures']>[number];
  const failures = new Map<string, RelationFailure>();
  const recordFailure = (sessionId: string, code: string, requestId = context.requestId) => {
    failures.set(sessionId, { sessionId, code, ...(requestId === undefined ? {} : { requestId }) });
  };
  const links: Array<Extract<SessionPullRequestBindingResultV1, { kind: 'relations' }>['links'][number]> = [];
  // The exact membership selector shares Collection paging across the admitted set.
  for (const { row, binding } of await readSessionPullRequestBindingRows({ collection, ...selection, signal: context.signal })) {
    connectionIds.add(binding.connectionId);
    const sessionId = binding.target.kind === 'session' ? binding.target.sessionId : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.sessionId : undefined;
    const pullRequest = binding.target.kind === 'session' ? binding.target.pullRequestLink : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.pullRequest : undefined;
    let matching = connections.get(binding.connectionId);
    if (matching === undefined) {
      try {
        const witness = await collection.get(binding.connectionId, { signal: context.signal });
        if (witness === null) throw pluginError('channels_pr_link_connection_missing', 'A retained PR link has no verifiable connection.', true);
        matching = matches(witness);
      } catch (error) {
        context.signal.throwIfAborted();
        if (!selection.sessionIds || !isPluginError(error)) throw error;
        matching = error;
      }
      connections.set(binding.connectionId, matching);
    }
    if (matching === false) continue;
    if (matching !== true) {
      if (sessionId === undefined) throw matching;
      recordFailure(sessionId, matching.code, readPluginErrorRequestIdV1(matching));
      continue;
    }
    if (binding.endpoint.kind !== 'githubPullRequest' || sessionId === undefined || pullRequest === undefined
      || binding.endpoint.parentId === undefined || !/^[1-9][0-9]*$/u.test(binding.endpoint.parentId)
      || repositoryIds.get(binding.connectionId) !== binding.endpoint.parentId
      || binding.endpoint.pullRequest?.number !== pullRequest.number
      || binding.endpoint.pullRequest.repository.toLowerCase() !== pullRequest.repository.toLowerCase()) {
      if (!selection.sessionIds || sessionId === undefined) {
        throw pluginError('channels_pr_link_identity_unavailable', 'The retained PR relationship has no exact authenticated identity.');
      }
      recordFailure(sessionId, 'channels_pr_link_identity_unavailable');
      continue;
    }
    if (pullRequestFilter !== undefined && (pullRequestFilter.repositoryId !== binding.endpoint.parentId || pullRequestFilter.number !== pullRequest.number)) continue;
    links.push({ sessionId, bindingId: binding.id, revision: row.revision, pullRequest,
      repositoryId: binding.endpoint.parentId, linkedAtMs: binding.createdAt, url: formatConversationPullRequestUrlV1(native, pullRequest) });
  }
  context.signal.throwIfAborted();
  return { result: { kind: 'relations' as const, links,
    ...(failures.size === 0 ? {} : { failures: [...failures.values()] }),
  }, connectionIds };
}

/** Observe the same selected native rows as the read; no provider read or repair. */
export async function observeSessionPullRequestBindingAction(input: JsonValue, invalidate: () => void, context: SessionPullRequestRelationContext) {
  const request = SessionPullRequestBindingInputV1Schema.parse(input);
  if (request.kind !== 'list' && request.kind !== 'readRelations') {
    throw pluginError('plugin_action_read_observation_read_only_required', 'Only relationship reads can be observed.');
  }
  return observeSessionPullRequestSelection(request, invalidate, context);
}

export function observeSessionPullRequestRelationsAction(input: JsonValue, invalidate: () => void, context: SessionPullRequestRelationContext) {
  return observeSessionPullRequestSelection(SessionPullRequestRelationsInputV1Schema.parse(input), invalidate, context);
}

async function observeSessionPullRequestSelection(
  request: RelationRequest | Extract<SessionPullRequestBindingInputV1, { kind: 'list' }>,
  invalidate: () => void, context: SessionPullRequestRelationContext,
) {
  context.signal.throwIfAborted();
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const dependencies = new Map<string, { dispose(): void }>();
  let disposed = false;
  let pending = false;
  let refreshing: Promise<void> | undefined;
  const notify = () => { if (!disposed && !context.signal.aborted) invalidate(); };
  function refresh(): Promise<void> {
    pending = true;
    return refreshing ??= (async () => {
      try {
        while (pending && !disposed && !context.signal.aborted && request.kind === 'readRelations') {
          pending = false;
          const selected = await selectSessionPullRequestRelations(request, context);
          if (disposed || context.signal.aborted) return;
          for (const [id, observation] of dependencies) if (!selected.connectionIds.has(id)) {
            observation.dispose(); dependencies.delete(id);
          }
          let added = false;
          for (const id of selected.connectionIds) if (!dependencies.has(id)) {
            dependencies.set(id, collection.watch({ index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
              prefix: [id, null, CHANNEL_STATE_RECORD_KIND.connection], order: 'asc' }, notify));
            added = true;
          }
          // Cover the asynchronous dependency acquisition gap with one read invalidation.
          if (added) notify();
        }
      } finally { refreshing = undefined; }
    })();
  }
  const membership = collection.watch(sessionPullRequestBindingSelection(relationSelection(request)), () => {
      notify();
      if (request.kind === 'readRelations') void refresh().catch(() => {
        // The next read reports the typed storage/identity failure, not stale membership.
        for (const observation of dependencies.values()) observation.dispose();
        dependencies.clear();
        notify();
      });
    });
  function dispose() {
    if (disposed) return;
    disposed = true;
    membership.dispose();
    for (const observation of dependencies.values()) observation.dispose();
    dependencies.clear();
    context.signal.removeEventListener('abort', dispose);
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  try {
    if (request.kind === 'readRelations') await refresh();
    if (context.signal.aborted) { dispose(); context.signal.throwIfAborted(); }
    return { dispose };
  } catch (error) { dispose(); throw error; }
}
