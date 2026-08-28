import {
  deriveAutomationOccurrenceEvidenceEqualityTagV1,
  deriveAutomationOccurrenceKeyV1,
  serializeAutomationOccurrenceEvidenceEqualityV1,
  AutomationPluginEventOccurrenceEvidenceV1Schema,
  type AutomationPluginEventOccurrenceEvidenceV1,
} from '@happier-dev/protocol';

/**
 * Stable vectors shared by Automation admission/equality tests. The expected
 * values are deliberately fixed so a delimiter, field-order, Unicode, or
 * domain-label drift cannot hide behind a self-consistent test helper.
 */
export const AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1 = {
  triggerId: 'trigger-qa-1',
  evidence: AutomationPluginEventOccurrenceEvidenceV1Schema.parse({
    v: 1,
    kind: 'pluginEvent',
    eventRef: { pluginId: 'com.example.github', localId: 'repository-event' },
    sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
    occurrenceId: 'github-event-42',
    occurredAt: 1_714_000_000_000,
    payload: { action: 'opened', repository: { id: 42 } },
  }) satisfies AutomationPluginEventOccurrenceEvidenceV1,
  accountId: 'account-qa-1',
  automationId: 'automation-qa-1',
  purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
  occurrenceKey: '8UxEBh2GEdslQgHAC13B3X5x27RoPFzWkuFgNU43G4g',
  serializedEqualityInput:
    'AAAAKWhhcHBpZXIuYXV0b21hdGlvbi1vY2N1cnJlbmNlLWVxdWFsaXR5LnYxAAAAATEAAAAMYWNjb3VudC1xYS0xAAAAD2F1dG9tYXRpb24tcWEtMQAAAAx0cmlnZ2VyLXFhLTEAAAArOFV4RUJoMkdFZHNsUWdIQUMxM0IzWDV4MjdSb1BGeldrdUZnTlU0M0c0ZwAAARF7ImV2ZW50UmVmIjp7ImxvY2FsSWQiOiJyZXBvc2l0b3J5LWV2ZW50IiwicGx1Z2luSWQiOiJjb20uZXhhbXBsZS5naXRodWIifSwia2luZCI6InBsdWdpbkV2ZW50Iiwib2NjdXJyZWRBdCI6MTcxNDAwMDAwMDAwMCwib2NjdXJyZW5jZUlkIjoiZ2l0aHViLWV2ZW50LTQyIiwicGF5bG9hZCI6eyJhY3Rpb24iOiJvcGVuZWQiLCJyZXBvc2l0b3J5Ijp7ImlkIjo0Mn19LCJzb3VyY2VTZWxlY3RvcklkIjoiOWQ1YWY1NTktMmM4Mi00YzIyLWI2YTAtZWNhYmNlMzhhNjMxIiwidiI6MX0',
  equalityTag: 'sY6tTJVPAxNyvswIjj0lQIRpTdbVGBxKw6puB6rMUkc',
} as const;

export function deriveAutomationOccurrenceVectorV1() {
  const vector = AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1;
  const occurrenceKey = deriveAutomationOccurrenceKeyV1({
    triggerId: vector.triggerId,
    evidence: vector.evidence,
  });
  const serializedEqualityInput = serializeAutomationOccurrenceEvidenceEqualityV1({
    accountId: vector.accountId,
    automationId: vector.automationId,
    triggerId: vector.triggerId,
    occurrenceKey,
    evidence: vector.evidence,
  });
  const equalityTag = deriveAutomationOccurrenceEvidenceEqualityTagV1({
    purposeSeparatedAccountKey: vector.purposeSeparatedAccountKey,
    accountId: vector.accountId,
    automationId: vector.automationId,
    triggerId: vector.triggerId,
    occurrenceKey,
    evidence: vector.evidence,
  });

  return { occurrenceKey, serializedEqualityInput, equalityTag } as const;
}
