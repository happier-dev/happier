import { describe, expect, it } from 'vitest';

import {
  AutomationAccountCurrentnessWitnessV1Schema,
  projectAutomationAccountCurrentnessWitnessV1,
  sameAutomationAccountContentIdentityV1,
  sameAutomationAccountCurrentnessWitnessV1,
} from './automationAccountCurrentnessV1.js';

const E2EE_FINGERPRINT = 'aemk1_content_key_fingerprint';

describe('automations/automationAccountCurrentnessV1', () => {
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

  it('separates exact witness equality from Account content identity', () => {
    const atAdoption = {
      mode: 'e2ee',
      version: 7,
      contentKeyFingerprint: E2EE_FINGERPRINT,
    } as const;
    const afterUnrelatedAccountChange = { ...atAdoption, version: 8 };
    const afterRekey = { ...atAdoption, contentKeyFingerprint: 'aemk1_other' };

    expect(sameAutomationAccountCurrentnessWitnessV1(atAdoption, atAdoption)).toBe(true);
    expect(sameAutomationAccountCurrentnessWitnessV1(atAdoption, afterUnrelatedAccountChange)).toBe(false);
    expect(sameAutomationAccountContentIdentityV1(atAdoption, afterUnrelatedAccountChange)).toBe(true);
    expect(sameAutomationAccountContentIdentityV1(atAdoption, afterRekey)).toBe(false);
    expect(sameAutomationAccountContentIdentityV1(atAdoption, {
      mode: 'plain',
      version: 7,
      contentKeyFingerprint: null,
    })).toBe(false);
  });
});
