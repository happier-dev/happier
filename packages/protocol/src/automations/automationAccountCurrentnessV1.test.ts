import { describe, expect, it } from 'vitest';

import {
  AutomationAccountCurrentnessWitnessV1Schema,
  projectAutomationAccountCurrentnessWitnessV1,
  resolveValidatedAutomationAccountEncryptionV1,
  sameAutomationAccountContentIdentityV1,
} from './automationAccountCurrentnessV1.js';

const E2EE_FINGERPRINT = 'aemk1_content_key_fingerprint';

describe('automations/automationAccountCurrentnessV1', () => {
  it('retains a currentness transport failure separately from unavailable encryption content', async () => {
    const failure = Object.assign(new Error('request timed out'), { code: 'ECONNABORTED' });
    await expect(resolveValidatedAutomationAccountEncryptionV1({ signal: new AbortController().signal,
      resolveAccountEncryptionCurrentness: async () => { throw failure; },
      resolveAccountEncryptionMaterial: async () => { throw new Error('material_must_not_be_read'); },
    })).resolves.toEqual({ kind: 'unavailable', cause: failure });
  });
  it('projects a keyless plain witness from an Account that retains a superseded content key', () => {
    // A supported Account migrated e2ee -> plain keeps `contentPublicKey`, so
    // its canonical currentness reading still carries a content-key
    // fingerprint. That Account is plain and current, not unavailable.
    expect(projectAutomationAccountCurrentnessWitnessV1({
      mode: 'plain',
      version: 12,
      contentKeyFingerprint: E2EE_FINGERPRINT,
    })).toEqual({ mode: 'plain', version: 12, contentKeyFingerprint: null });
    expect(AutomationAccountCurrentnessWitnessV1Schema.safeParse({
      mode: 'plain',
      version: 12,
      contentKeyFingerprint: E2EE_FINGERPRINT,
    }).success).toBe(false);
  });

  it('keeps the exact content-key fingerprint for an e2ee Account', () => {
    expect(projectAutomationAccountCurrentnessWitnessV1({
      mode: 'e2ee',
      version: 3,
      contentKeyFingerprint: E2EE_FINGERPRINT,
    })).toEqual({ mode: 'e2ee', version: 3, contentKeyFingerprint: E2EE_FINGERPRINT });
  });

  it('rejects a reading that cannot form a witness', () => {
    expect(projectAutomationAccountCurrentnessWitnessV1({
      mode: 'e2ee',
      version: 3,
      contentKeyFingerprint: null,
    })).toBeNull();
    expect(projectAutomationAccountCurrentnessWitnessV1({
      mode: 'plaintext',
      version: 3,
      contentKeyFingerprint: null,
    })).toBeNull();
    expect(projectAutomationAccountCurrentnessWitnessV1({
      mode: 'plain',
      version: -1,
      contentKeyFingerprint: null,
    })).toBeNull();
  });

  it('ignores unrelated Account sequence changes but refuses changed mode or content key', () => {
    const atAdoption = {
      mode: 'e2ee',
      version: 7,
      contentKeyFingerprint: E2EE_FINGERPRINT,
    } as const;
    const afterUnrelatedAccountChange = { ...atAdoption, version: 8 };
    const afterRekey = { ...atAdoption, contentKeyFingerprint: 'aemk1_other' };

    expect(sameAutomationAccountContentIdentityV1(atAdoption, atAdoption)).toBe(true);
    expect(sameAutomationAccountContentIdentityV1(atAdoption, afterUnrelatedAccountChange)).toBe(true);
    expect(sameAutomationAccountContentIdentityV1(atAdoption, afterRekey)).toBe(false);
    expect(sameAutomationAccountContentIdentityV1(atAdoption, {
      mode: 'plain',
      version: 7,
      contentKeyFingerprint: null,
    })).toBe(false);
  });
});
