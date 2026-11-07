import { PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import type { PluginAccountStorageConsumerContext } from '@happier-dev/plugin-sdk/storage';
import { SessionPullRequestBindingInputV1Schema, type SessionPullRequestBindingInputV1,
  type SessionPullRequestBindingResultV1 } from '@happier-dev/channels-protocol/v1';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { readConversationConnectionUpdateRow, type ChannelStateRow as StateRow } from './accountLocalBindingPolicy.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { readSessionPullRequestBindingRows, sessionPullRequestBindingSelection } from './sessionPullRequestBindings.js';
import { readSessionPullRequestProvider } from './providerContributions.js';

export const SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 = 'session-pull-request-relations-v1';
export const SESSION_PULL_REQUEST_RELATIONS_ACCOUNT_EXECUTION_V1 = { target: 'account', account: {
  artifactId: 'channels-account-runtime', exportName: 'activate',
} } as const;

function pluginError(code: string, message: string, retryable = false): PluginError {
  return new PluginError({ code, message, retryable });
}

/** Account custody needs no Machine; the daemon binding transport uses this same reader. */
export async function readSessionPullRequestRelationsForInvocation(input: JsonValue, context: SessionPullRequestRelationContext): Promise<SessionPullRequestBindingResultV1> {
  const request = SessionPullRequestBindingInputV1Schema.parse(input);
  if (request.kind !== 'readRelations') {
    throw pluginError('plugin_action_read_observation_read_only_required', 'This Action only reads pull request relationships.');
  }
  return (await selectSessionPullRequestRelations(request, context)).result;
}

/** Exact source relationship reads use only the canonical retained connection/binding rows. */
type SessionPullRequestRelationContext = PluginAccountStorageConsumerContext & Pick<PluginInvocationContext, 'signal'>
  & { services: Pick<PluginInvocationContext['services'], 'targetedContributions'> };
export async function selectSessionPullRequestRelations(
  input: Extract<SessionPullRequestBindingInputV1, { kind: 'readRelations' }>, context: SessionPullRequestRelationContext,
) {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const { contribution } = await readSessionPullRequestProvider({ targetedContributions: context.services.targetedContributions, signal: context.signal });
  const native = contribution.descriptor.pullRequests!;
  const repositoryIds = new Map<string, string>();
  const connectionIds = new Set<string>();
  const matches = (row: StateRow) => {
    const current = readConversationConnectionUpdateRow({ row, connectionId: row.rowId });
    // Credentials select connection execution, not a PR's identity. These rows
    // already belong to the invoking Account; another profile or Machine must
    // see the same exact repository/PR relationship.
    const matching = current.providerPluginId === contribution.contributor.pluginId
      && (input.pullRequest === undefined || current.payload.providerConnectionKey === `${native.repositoryConnectionKeyPrefix}${input.pullRequest.repositoryId}`);
    if (matching) {
      const key = current.payload.providerConnectionKey;
      const suffix = typeof key === 'string' && key.startsWith(native.repositoryConnectionKeyPrefix) ? key.slice(native.repositoryConnectionKeyPrefix.length) : undefined;
      const repositoryId = suffix !== undefined && /^[1-9][0-9]*$/u.test(suffix) ? suffix : undefined;
      if (repositoryId === undefined) throw pluginError('channels_pr_link_identity_unavailable', 'The native connection has no exact repository identity.');
      repositoryIds.set(row.rowId, repositoryId);
    }
    return matching;
  };
  const entries: Awaited<ReturnType<typeof readSessionPullRequestBindingRows>> = [];
  if (input.sessionId !== undefined) {
    const sessionId = SessionIdSchema.parse(input.sessionId);
    const connections = new Map<string, boolean>();
    for (const entry of await readSessionPullRequestBindingRows({ collection, sessionId, signal: context.signal })) {
      connectionIds.add(entry.binding.connectionId);
      let matching = connections.get(entry.binding.connectionId);
      if (matching === undefined) {
        const row = await collection.get(entry.binding.connectionId, { signal: context.signal });
        if (row === null) throw pluginError('channels_pr_link_connection_missing', 'A retained PR link has no verifiable connection.', true);
        matching = matches(row);
        connections.set(entry.binding.connectionId, matching);
      }
      if (matching) entries.push(entry);
    }
  } else {
    let cursor: string | undefined;
    do {
      const page = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byKind,
        prefix: [CHANNEL_STATE_RECORD_KIND.connection], order: 'asc', limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
        ...(cursor === undefined ? {} : { cursor }) }, { signal: context.signal });
      for (const row of page.rows) if (matches(row)) {
        connectionIds.add(row.rowId);
        entries.push(...await readSessionPullRequestBindingRows({ collection, connectionId: row.rowId, signal: context.signal }));
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  const links: Array<Extract<SessionPullRequestBindingResultV1, { kind: 'relations' }>['links'][number]> = [];
  for (const { row, binding } of entries) {
    const sessionId = binding.target.kind === 'session' ? binding.target.sessionId : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.sessionId : undefined;
    const pullRequest = binding.target.kind === 'session' ? binding.target.pullRequestLink : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.pullRequest : undefined;
    if (binding.endpoint.kind !== 'githubPullRequest' || sessionId === undefined || pullRequest === undefined
      || binding.endpoint.parentId === undefined || !/^[1-9][0-9]*$/u.test(binding.endpoint.parentId)
      || repositoryIds.get(binding.connectionId) !== binding.endpoint.parentId
      || binding.endpoint.pullRequest?.number !== pullRequest.number
      || binding.endpoint.pullRequest.repository.toLowerCase() !== pullRequest.repository.toLowerCase()) {
      throw pluginError('channels_pr_link_identity_unavailable', 'The retained PR relationship has no exact authenticated identity.');
    }
    if (input.pullRequest !== undefined && (input.pullRequest.repositoryId !== binding.endpoint.parentId || input.pullRequest.number !== pullRequest.number)) continue;
    links.push({ sessionId, bindingId: binding.id, revision: row.revision, pullRequest,
      repositoryId: binding.endpoint.parentId, linkedAtMs: binding.createdAt });
  }
  return { result: { kind: 'relations' as const, links }, connectionIds };
}

/** Observe the same selected native rows as the read; no provider read or repair. */
export async function observeSessionPullRequestBindingAction(input: JsonValue, invalidate: () => void, context: SessionPullRequestRelationContext) {
  const request = SessionPullRequestBindingInputV1Schema.parse(input);
  if (request.kind !== 'list' && request.kind !== 'readRelations') {
    throw pluginError('plugin_action_read_observation_read_only_required', 'Only relationship reads can be observed.');
  }
  context.signal.throwIfAborted();
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const sessionId = request.sessionId === undefined ? undefined : SessionIdSchema.parse(request.sessionId);
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
            dependencies.set(id, collection.watch(sessionId === undefined
              ? sessionPullRequestBindingSelection({ connectionId: id })
              : { index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
                prefix: [id, null, CHANNEL_STATE_RECORD_KIND.connection], order: 'asc' }, notify));
            added = true;
          }
          // Cover the asynchronous dependency acquisition gap with one read invalidation.
          if (added) notify();
        }
      } finally { refreshing = undefined; }
    })();
  }
  const membership = collection.watch(request.kind === 'readRelations' && sessionId === undefined
    ? { index: CHANNEL_STATE_INDEX_ID.byKind, prefix: [CHANNEL_STATE_RECORD_KIND.connection], order: 'asc' }
    : sessionPullRequestBindingSelection({ sessionId }), () => {
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
