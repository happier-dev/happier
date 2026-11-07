import { SessionPullRequestLatestUpdateV1Schema, SessionPullRequestUpdateV1Schema, type SessionPullRequestUpdateV1 } from '@happier-dev/channels-protocol/v1';
import { isRecord } from '@happier-dev/plugin-sdk';
import type { PluginAccountStorageConsumerContext } from '@happier-dev/plugin-sdk/storage';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';

export type SessionPullRequestLatestUpdateV1 = ReturnType<typeof SessionPullRequestLatestUpdateV1Schema.parse>;

/** Complete semantic aggregate shared by retained metadata and push presentation. */
export function summarizeSessionPullRequestUpdateV1(update: SessionPullRequestUpdateV1): string {
  const counts = new Map<string, number>();
  for (const event of update.events) {
    const label = event.kind === 'check' ? `${event.state} check`
      : event.kind === 'inlineComment' ? 'inline comment'
      : event.kind === 'conflict' ? 'merge conflict'
      : event.kind === 'merged' ? 'merged PR'
      : event.kind === 'closed' ? 'closed PR' : event.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${count === 1 ? label : label === 'push' ? 'pushes' : `${label}s`}`).join(', ');
}

/** Selected retained batch only: independent of connection history and unrelated Sessions. */
export async function readSessionPullRequestLatestUpdateForBinding(
  input: Readonly<{ sessionId: string; bindingId: string }>,
  context: PluginAccountStorageConsumerContext & Readonly<{ signal: AbortSignal }>,
): Promise<SessionPullRequestLatestUpdateV1 | null> {
  const page = await requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION).query({
    index: CHANNEL_STATE_INDEX_ID.bySessionKindBindingUpdateV1,
    prefix: [input.sessionId, CHANNEL_STATE_RECORD_KIND.ingressObligation, input.bindingId],
    range: { lower: 0 }, order: 'asc', limit: 1,
  }, { signal: context.signal });
  const row = page.rows[0];
  if (row === undefined || row.value['session-id'] !== input.sessionId || row.value['binding-id'] !== input.bindingId) return null;
  const payload = row.value.payload;
  if (!isRecord(payload)) return null;
  const parsed = SessionPullRequestUpdateV1Schema.safeParse(payload.prUpdate);
  if (!parsed.success || parsed.data.sessionId !== input.sessionId || parsed.data.bindingId !== input.bindingId) return null;
  const update = parsed.data;
  const accepted = payload.sessionInput;
  const location = isRecord(accepted)
    && accepted.sessionId === input.sessionId && typeof accepted.localId === 'string' && accepted.localId.length > 0
    ? { kind: 'sessionInput' as const, localId: accepted.localId }
    : [...update.events].reverse().flatMap(event => event.url === undefined ? [] : [{ kind: 'provider' as const,
        url: event.url, ...(event.resource === undefined ? {} : { resource: event.resource }) }])[0];
  const occurrenceId = Array.isArray(payload.occurrenceIds) ? payload.occurrenceIds[0] : undefined;
  if (location === undefined || typeof occurrenceId !== 'string') return null;
  // A complete semantic aggregate, not a clipped body excerpt. Full provider
  // evidence belongs to the native Session after acceptance; retained metadata
  // supplies identities and summary state, not a duplicate message archive.
  const summary = summarizeSessionPullRequestUpdateV1(update);
  return SessionPullRequestLatestUpdateV1Schema.parse({
    occurrenceId,
    occurredAtMs: Math.max(...update.events.map(event => event.occurredAt)),
    kinds: [...new Set(update.events.map(event => event.kind))],
    summary, summaryTruncated: false, location,
  });
}
