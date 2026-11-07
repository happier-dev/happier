import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { NotificationBatchResult } from '@happier-dev/plugin-sdk/notifications';
import { buildTriageEntryRouteSegmentV1, type TriageEntryRefV1 } from '@happier-dev/triage-protocol';

type AttentionNotice = Omit<Parameters<PluginInvocationContext['services']['notifications']['send']>[0], 'itemId'>;

/** One identity/envelope owner for feed arrivals and the existing Event observer. */
export async function publishTriageAttentionV1(
  context: Readonly<{ services: Pick<PluginInvocationContext['services'], 'notifications'>; signal: AbortSignal }>,
  input: Readonly<{ entryRef: TriageEntryRefV1; reason: string; notice: AttentionNotice }>,
): Promise<NotificationBatchResult & Readonly<{ itemId: string }>> {
  const itemId = computeCanonicalDomainSeparatedDigest('happier.triage.attention.v1', [
    buildTriageEntryRouteSegmentV1(input.entryRef), input.reason,
  ]);
  const result = await context.services.notifications.send({ ...input.notice, itemId }, { signal: context.signal });
  return { ...result, itemId };
}
