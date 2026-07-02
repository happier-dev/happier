import { accountSettingsParse } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { AccountSettingsContext } from './bootstrapAccountSettingsContext';
import { warmActiveAccountSettingsSnapshotBestEffort } from './warmActiveAccountSettingsSnapshot';

function createCredentialsStub(token = 'token'): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

function createContext(settingsVersion: number): AccountSettingsContext {
  return {
    source: 'network',
    settings: accountSettingsParse({ schemaVersion: 6 }),
    settingsVersion,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    whenRefreshed: null,
  };
}

describe('warmActiveAccountSettingsSnapshotBestEffort', () => {
  // Incident Jun-11 H-A / FIX-1a: the daemon's in-memory account-settings snapshot used to stay
  // NULL until the first spawn hint / settings-changed hint, so every policy decision after a
  // daemon restart (continuity, resume prompts, materializers) silently degraded. Startup and
  // reconnect must populate it best-effort through the canonical refresh owner.

  it('bootstraps the snapshot through the canonical refresh owner when none is active', async () => {
    const bootstrapAccountSettingsContext = vi.fn(async () => createContext(7));

    await expect(warmActiveAccountSettingsSnapshotBestEffort({
      credentials: createCredentialsStub(),
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'token-scope',
      },
    })).resolves.toBe(true);

    expect(bootstrapAccountSettingsContext).toHaveBeenCalledTimes(1);
  });

  it('is a cheap no-op when an active snapshot already exists for the credentials scope', async () => {
    const bootstrapAccountSettingsContext = vi.fn(async () => createContext(7));

    await expect(warmActiveAccountSettingsSnapshotBestEffort({
      credentials: createCredentialsStub(),
      deps: {
        getActiveSnapshot: () => ({ ...createContext(3), scopeKey: 'token-scope' }),
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'token-scope',
      },
    })).resolves.toBe(true);

    expect(bootstrapAccountSettingsContext).not.toHaveBeenCalled();
  });

  it('fails open (returns false, never throws) when the refresh fails', async () => {
    const warnings: unknown[] = [];

    await expect(warmActiveAccountSettingsSnapshotBestEffort({
      credentials: createCredentialsStub(),
      logger: { warn: (message, error) => { warnings.push([message, error]); } },
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext: vi.fn(async () => {
          throw new Error('network down');
        }),
        resolveScopeKey: () => 'token-scope',
      },
    })).resolves.toBe(false);

    expect(warnings).toHaveLength(1);
  });
});
