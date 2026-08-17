import { describe, expect, it } from 'vitest';

import {
  deriveAutomationOccurrenceEvidenceEqualityTagV1,
  deriveAutomationOccurrenceKeyV1,
} from './automationOccurrenceV1.js';

const conversationEvidence = {
  v: 1,
  kind: 'conversation',
  bindingId: '1',
  occurrenceId: '1',
  occurredAt: 1,
  caller: {
    pluginId: 'happier.channels',
    contributionLocalId: 'provider/observation-ingest-v1',
    machineId: 'machine-1',
  },
  input: { text: 'ok' },
  replyContextIdentity: '1',
} as const;

describe('Automation occurrence V1 privacy scoping', () => {
  it('keeps identical low-entropy Conversation evidence unlinkable across Automations', () => {
    const purposeSeparatedAccountKey = new Uint8Array(32).fill(17);
    const occurrenceKey = deriveAutomationOccurrenceKeyV1(conversationEvidence);
    const deriveForAutomation = (automationId: string) => (
      deriveAutomationOccurrenceEvidenceEqualityTagV1({
        purposeSeparatedAccountKey,
        accountId: 'account-1',
        automationId,
        occurrenceKey,
        evidence: conversationEvidence,
      })
    );

    const first = deriveForAutomation('automation-1');
    expect(deriveForAutomation('automation-1')).toBe(first);
    expect(deriveForAutomation('automation-2')).not.toBe(first);
  });
});
