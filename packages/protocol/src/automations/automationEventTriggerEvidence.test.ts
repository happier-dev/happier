import { describe, expect, it } from 'vitest';

import {
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import {
  deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1,
  isAutomationTriggerEvidenceCiphertextV1,
  sealAutomationOccurrenceTriggerEvidenceEnvelopeV1,
} from './automationEventTriggerEvidence.js';

const material: AccountScopedCryptoMaterial = {
  type: 'dataKey',
  machineKey: new Uint8Array(32).fill(7),
};
const evidence = {
  v: 1,
  kind: 'pluginEvent',
  eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
  sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
  occurrenceId: 'delivery-1',
  occurredAt: 1,
  payload: { action: 'opened' },
} as const;

describe('Automation Event trigger evidence', () => {
  it('uses the dedicated byte-19 Account cipher domain and a purpose-separated equality tag', () => {
    const triggerEvidence = sealAutomationOccurrenceTriggerEvidenceEnvelopeV1({
      material,
      evidence,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    expect(triggerEvidence.t).toBe('encrypted');
    expect(readAccountScopedCiphertextKindByte(triggerEvidence.c)).toBe(19);
    expect(isAutomationTriggerEvidenceCiphertextV1(triggerEvidence.c)).toBe(true);

    const wrongDomain = sealAccountScopedBlobCiphertext({
      kind: 'automation_run_result',
      material,
      payload: evidence,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    expect(isAutomationTriggerEvidenceCiphertextV1(wrongDomain)).toBe(false);

    const first = deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1({
      material,
      accountId: 'account-1',
      automationId: 'automation-1',
      evidence,
    });
    expect(deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1({
      material,
      accountId: 'account-1',
      automationId: 'automation-1',
      evidence,
    })).toBe(first);
    expect(deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1({
      material,
      accountId: 'account-1',
      automationId: 'automation-2',
      evidence,
    })).not.toBe(first);
  });
});
