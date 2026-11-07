import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ConversationIngressAutomationEventCandidateV1, ConversationNormalizedIngressV1 } from '@happier-dev/channels-protocol/v1';

/** Historical persisted shape only: new ingress writes self-contained obligations. */
export function createIngressCensusValue(input: Readonly<{
  censusId: string;
  connectionId: string;
  ingress: ConversationNormalizedIngressV1;
  eventCandidate?: ConversationIngressAutomationEventCandidateV1 | null;
  matchedBindings: readonly Readonly<{ bindingId: string; bindingRevision?: number; bindingAuthorityEpoch?: number }>[];
  now: number;
}>): Record<string, JsonValue> {
  return {
    id: input.censusId,
    'record-kind': 'ingress-census',
    v: 1,
    'connection-id': input.connectionId,
    attention: false,
    'created-at': input.now,
    'updated-at': input.now,
    payload: {
      normalizedIngress: input.ingress,
      compacted: null,
      conflict: null,
      eventCandidate: input.eventCandidate ?? null,
      matchedBindings: input.matchedBindings.map(({ bindingId }) => ({ bindingId }))
        .sort((a, b) => a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0),
    },
  };
}
