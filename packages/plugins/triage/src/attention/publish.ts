import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { buildTriageEntryRouteSegmentV1, TriagePublishAttentionInputV1Schema, type TriagePublishAttentionResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { publishTriageAttentionV1 } from '@happier-dev/triage-sources/runtime';
import { resolveTriageCallerSource } from '../actions/callerSource.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION } from '../corpus/collections/definitions.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { configuredSourceInstanceIsOwnedBy, findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';

/** A caller-bound source publishes facts it already read. No provider read is repeated here. */
export async function publishSourceAttention(input: unknown, context: PluginInvocationContext): Promise<ProtocolSchemaOutput<typeof TriagePublishAttentionResultV1Schema>> {
  const parsed = TriagePublishAttentionInputV1Schema.parse(input);
  const options = { signal: context.signal };
  const source = await resolveTriageCallerSource(context, options, parsed.entryRef.source);
  if (source.kind !== 'source') return { v: 1, kind: 'rejected', code: 'invalid-caller' } as const;
  const row = await findConfiguredSourceInstanceRow(requireTriageAccountStorage(context).collection(CORPUS_SOURCE_INSTANCES_COLLECTION), parsed.sourceInstanceId, options);
  if (!row || row.value.lifecycle !== CORPUS_SOURCE_INSTANCE_LIFECYCLE.active
    || !configuredSourceInstanceIsOwnedBy(row.value, source.caller.source)) return { v: 1, kind: 'rejected', code: 'source-unavailable' } as const;
  context.signal.throwIfAborted();
  const result = await publishTriageAttentionV1(context, { entryRef: parsed.entryRef, reason: parsed.reason,
    notice: { clientRequestId: parsed.clientRequestId, categoryId: 'source-attention', title: parsed.title,
      type: parsed.type, resolved: parsed.resolved,
      page: { pageId: 'triage', subPath: buildTriageEntryRouteSegmentV1(parsed.entryRef) },
    },
  });
  return { v: 1, kind: 'published', itemId: result.itemId } as const;
}
