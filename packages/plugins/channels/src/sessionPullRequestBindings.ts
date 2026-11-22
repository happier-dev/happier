import { PluginError } from '@happier-dev/plugin-sdk';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, type PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';
import type { ConversationBindingV1 } from '@happier-dev/channels-protocol/v1';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { isChannelStateJsonRecord, readConversationBindingUpdateRow,
  type ChannelStateRow } from './accountLocalBindingPolicy.js';

/** One selector serves the relation read and its content-free membership observation. */
export function sessionPullRequestBindingSelection(input: Readonly<{ sessionId?: string; sessionIds?: ReadonlySet<string>; connectionId?: string }>) {
  if (input.sessionIds !== undefined) return { index: CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1,
    prefixes: [...input.sessionIds].map(id => [CHANNEL_STATE_RECORD_KIND.binding, true, id]), order: 'asc' as const };
  return input.sessionId !== undefined ? { index: CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1,
    prefix: [CHANNEL_STATE_RECORD_KIND.binding, true, input.sessionId], order: 'asc' as const }
    : input.connectionId !== undefined ? { index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
      prefix: [input.connectionId], order: 'asc' as const }
      : { index: CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1,
        prefix: [CHANNEL_STATE_RECORD_KIND.binding, true], order: 'asc' as const };
}

/** Retained Session PR membership, shared by management and the Account/Session Resources. */
export async function readSessionPullRequestBindingRows(input: Readonly<{
  collection: Pick<PluginAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>, 'query'>;
  sessionId?: string;
  sessionIds?: ReadonlySet<string>;
  connectionId?: string;
  signal?: AbortSignal;
}>): Promise<Array<Readonly<{ row: ChannelStateRow; binding: ConversationBindingV1 }>>> {
  const rows: ChannelStateRow[] = [];
  let cursor: string | undefined;
  do {
    input.signal?.throwIfAborted();
    const page = await input.collection.query({ ...sessionPullRequestBindingSelection(input), limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
      ...(cursor === undefined ? {} : { cursor }) }, { signal: input.signal });
    for (const row of page.rows) {
      if (!isChannelStateJsonRecord(row.value)) {
        throw new PluginError({ code: 'channels_binding_update_row_invalid', message: 'The retained binding selector returned an invalid row.' });
      }
      if (input.connectionId !== undefined && (row.value['record-kind'] !== CHANNEL_STATE_RECORD_KIND.binding || row.value['pr-binding'] !== true)) continue;
      if (row.value['record-kind'] !== CHANNEL_STATE_RECORD_KIND.binding || row.value['pr-binding'] !== true) throw new PluginError({ code: 'channels_binding_update_row_invalid', message: 'The retained binding selector returned an invalid row.' });
      rows.push({ rowId: row.rowId, revision: row.revision, value: row.value });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  input.signal?.throwIfAborted();
  return rows.flatMap(row => {
    const { binding } = readConversationBindingUpdateRow({ row, bindingId: row.rowId });
    const sessionId = binding.target.kind === 'session' ? binding.target.sessionId
      : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.sessionId : undefined;
    const pullRequest = binding.target.kind === 'session' ? binding.target.pullRequestLink
      : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.pullRequest : undefined;
    return sessionId !== undefined && pullRequest !== undefined && binding.deletionState === 'none'
      && (input.sessionId === undefined || input.sessionId === sessionId)
      && (input.sessionIds === undefined || input.sessionIds.has(sessionId))
      && (input.connectionId === undefined || input.connectionId === binding.connectionId) ? [{ row, binding }] : [];
  });
}
