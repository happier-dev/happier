import {
  deriveAutomationOccurrenceEvidenceEqualityTagV1,
  deriveAutomationOccurrenceKeyV1,
  serializeAutomationOccurrenceEvidenceEqualityV1,
  AutomationOccurrenceEvidenceV1Schema,
  type AutomationOccurrenceEvidenceV1,
} from '@happier-dev/protocol';

/**
 * Stable vectors shared by Automation admission/equality tests. The expected
 * values are deliberately fixed so a delimiter, field-order, Unicode, or
 * domain-label drift cannot hide behind a self-consistent test helper.
 */
export const AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1 = {
  evidence: AutomationOccurrenceEvidenceV1Schema.parse({
    v: 1,
    kind: 'pluginEvent',
    eventRef: { pluginId: 'com.example.github', localId: 'repository-event' },
    sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
    occurrenceId: 'github-event-42',
    occurredAt: 1_714_000_000_000,
    payload: { action: 'opened', repository: { id: 42 } },
  }) satisfies AutomationOccurrenceEvidenceV1,
  accountId: 'account-qa-1',
  automationId: 'automation-qa-1',
  purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
  occurrenceKey: 'HdCoky0kYzUn2hf0aTgKtv8kMZ68aW5JU8yBSgZ6jyU',
  serializedEqualityInput:
    'AAAAKWhhcHBpZXIuYXV0b21hdGlvbi1vY2N1cnJlbmNlLWVxdWFsaXR5LnYxAAAAATEAAAAMYWNjb3VudC1xYS0xAAAAD2F1dG9tYXRpb24tcWEtMQAAACtIZENva3kwa1l6VW4yaGYwYVRnS3R2OGtNWjY4YVc1SlU4eUJTZ1o2anlVAAABEXsiZXZlbnRSZWYiOnsibG9jYWxJZCI6InJlcG9zaXRvcnktZXZlbnQiLCJwbHVnaW5JZCI6ImNvbS5leGFtcGxlLmdpdGh1YiJ9LCJraW5kIjoicGx1Z2luRXZlbnQiLCJvY2N1cnJlZEF0IjoxNzE0MDAwMDAwMDAwLCJvY2N1cnJlbmNlSWQiOiJnaXRodWItZXZlbnQtNDIiLCJwYXlsb2FkIjp7ImFjdGlvbiI6Im9wZW5lZCIsInJlcG9zaXRvcnkiOnsiaWQiOjQyfX0sInNvdXJjZVNlbGVjdG9ySWQiOiI5ZDVhZjU1OS0yYzgyLTRjMjItYjZhMC1lY2FiY2UzOGE2MzEiLCJ2IjoxfQ',
  equalityTag: 'xALhhXXdYokfVQHbDwDaf-SDFhbQDUbqdUFS3s0n6E8',
} as const;

export function deriveAutomationOccurrenceVectorV1() {
  const vector = AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1;
  const occurrenceKey = deriveAutomationOccurrenceKeyV1(vector.evidence);
  const serializedEqualityInput = serializeAutomationOccurrenceEvidenceEqualityV1({
    accountId: vector.accountId,
    automationId: vector.automationId,
    occurrenceKey,
    evidence: vector.evidence,
  });
  const equalityTag = deriveAutomationOccurrenceEvidenceEqualityTagV1({
    purposeSeparatedAccountKey: vector.purposeSeparatedAccountKey,
    accountId: vector.accountId,
    automationId: vector.automationId,
    occurrenceKey,
    evidence: vector.evidence,
  });

  return { occurrenceKey, serializedEqualityInput, equalityTag } as const;
}
