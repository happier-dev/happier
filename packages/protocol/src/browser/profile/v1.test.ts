import { describe, expect, it } from 'vitest';

async function loadProfileModule() {
  return import('./v1.js').catch(() => null);
}

describe('browser profile v1 protocol', () => {
  it('serializes lifecycle and purge-failure state for fail-closed profiles', async () => {
    const mod = await loadProfileModule();

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserProfileV1Schema.safeParse({
      profileId: 'profile_session_1',
      storageMode: 'session',
      owner: { kind: 'session', id: 'session_1' },
      displayName: 'Session browser',
      createdAt: 1_000,
      updatedAt: 1_100,
      lifecycleState: 'unusable',
      disabledReasons: ['purge_failed'],
      purgeFailure: {
        reasonCode: 'disk_purge_failed',
        message: 'profile partition could not be removed',
        occurredAt: 1_200,
      },
    });

    expect(result.success).toBe(true);
  });

  it('requires plugin storage profiles to be plugin-owned', async () => {
    const mod = await loadProfileModule();

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserProfileV1Schema.safeParse({
      profileId: 'profile_plugin_1',
      storageMode: 'plugin',
      owner: { kind: 'session', id: 'session_1' },
      createdAt: 1_000,
      updatedAt: 1_100,
    });

    expect(result.success).toBe(false);
  });
});
