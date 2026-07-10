import { describe, expect, it } from 'vitest';

async function loadPolicyModule() {
  return import('./v1.js').catch(() => null);
}

describe('browser policy v1 protocol', () => {
  it('serializes fail-closed target policy decisions with typed disabled reasons', async () => {
    const mod = await loadPolicyModule();

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserTargetPolicyDecisionV1Schema.safeParse({
      targetKind: 'externalUrl',
      state: 'unavailable',
      reasonCode: 'external_url_disabled',
      profileId: 'profile_1',
      profileMode: 'session',
      origin: 'https://example.com',
      permissions: {
        downloads: 'deny',
        uploads: 'deny',
        popups: 'deny',
      },
    });

    expect(result.success).toBe(true);
  });

  it('requires a reason when browser target policy is not allowed', async () => {
    const mod = await loadPolicyModule();

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserTargetPolicyDecisionV1Schema.safeParse({
      targetKind: 'externalUrl',
      state: 'denied',
      profileId: 'profile_1',
      profileMode: 'session',
    });

    expect(result.success).toBe(false);
  });
});
