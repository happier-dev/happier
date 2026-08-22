import { describe, expect, it } from 'vitest';

import {
  AutomationOccurrenceKeyV1Schema,
  AutomationOccurrenceEvidenceV1Schema,
  deriveAutomationOccurrenceKeyV1,
  serializeAutomationOccurrenceEvidenceEqualityV1,
} from '@happier-dev/protocol';
import {
  AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1,
  deriveAutomationOccurrenceVectorV1,
} from './automationOccurrenceVectors';

describe('Automation occurrence vectors', () => {
  it('pins the canonical key, equality serialization, and opaque E2EE tag', () => {
    expect(deriveAutomationOccurrenceVectorV1()).toEqual({
      occurrenceKey: AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1.occurrenceKey,
      serializedEqualityInput: AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1.serializedEqualityInput,
      equalityTag: AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1.equalityTag,
    });
  });

  it('keeps replay identity independent from payload while equality evidence changes', () => {
    const vector = AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1;
    const changedEvidence = AutomationOccurrenceEvidenceV1Schema.parse({
      ...vector.evidence,
      payload: { action: 'opened', repository: { id: 43 } },
    });
    const key = deriveAutomationOccurrenceKeyV1(vector.evidence);
    const changedKey = deriveAutomationOccurrenceKeyV1(changedEvidence);

    expect(changedKey).toBe(key);
    expect(serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: vector.accountId,
      automationId: vector.automationId,
      occurrenceKey: changedKey,
      evidence: changedEvidence,
    })).not.toBe(vector.serializedEqualityInput);
  });

  it('keeps equal evidence in two Automations cryptographically unrelated', async () => {
    const vector = AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1;
    const { deriveAutomationOccurrenceEvidenceEqualityTagV1 } = await import(
      '@happier-dev/protocol',
    );
    const occurrenceKey = deriveAutomationOccurrenceKeyV1(vector.evidence);
    const tag = deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: vector.purposeSeparatedAccountKey,
      accountId: vector.accountId,
      automationId: 'automation-qa-2',
      occurrenceKey,
      evidence: vector.evidence,
    });

    expect(tag).not.toBe(vector.equalityTag);
  });

  it('rejects an equality input whose occurrence key is not derived from its evidence', () => {
    const vector = AUTOMATION_OCCURRENCE_EVENT_VECTOR_V1;
    const mismatchedKey = AutomationOccurrenceKeyV1Schema.parse(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );

    expect(() => serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: vector.accountId,
      automationId: vector.automationId,
      occurrenceKey: mismatchedKey,
      evidence: vector.evidence,
    })).toThrowError(TypeError);
  });
});
