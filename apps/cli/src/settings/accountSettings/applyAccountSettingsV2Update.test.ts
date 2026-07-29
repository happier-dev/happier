import { accountSettingsParse } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const { applyProcessEnv } = vi.hoisted(() => ({
  applyProcessEnv: vi.fn(),
}));

vi.mock('@/settings/applyAccountSettingsToProcessEnv', () => ({
  applyAccountSettingsToProcessEnv: applyProcessEnv,
}));

import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';
import { applyAccountSettingsV2Update } from './bootstrapAccountSettingsContext';
import { resolveAccountSettingsScopeKey } from './accountSettingsScopeKey';

function credentials(token: string): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
  };
}

function snapshot(params: Readonly<{
  credentials: Credentials;
  version: number;
  timing: 'after_foreground_ready' | 'after_runtime_idle';
}>) {
  return {
    source: 'network' as const,
    settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: params.timing }),
    settingsVersion: params.version,
    loadedAtMs: params.version,
    settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKey(params.credentials),
  };
}

describe('applyAccountSettingsV2Update', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    applyProcessEnv.mockReset();
  });

  it('does not replace or apply side effects for an equal or older same-scope update', async () => {
    const accountCredentials = credentials('account-a');
    const winner = snapshot({ credentials: accountCredentials, version: 3, timing: 'after_runtime_idle' });
    setActiveAccountSettingsSnapshot(winner);

    await expect(applyAccountSettingsV2Update({
      credentials: accountCredentials,
      update: {
        content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
        version: 3,
      },
    })).resolves.toMatchObject({ settingsVersion: 3 });
    await expect(applyAccountSettingsV2Update({
      credentials: accountCredentials,
      update: {
        content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
        version: 2,
      },
    })).resolves.toMatchObject({ settingsVersion: 3 });

    expect(getActiveAccountSettingsSnapshot()).toBe(winner);
    expect(applyProcessEnv).not.toHaveBeenCalled();
  });

  it('rejects a delayed update when the active account scope changes during decryption', async () => {
    const accountA = credentials('account-a');
    const accountB = credentials('account-b');
    setActiveAccountSettingsSnapshot(snapshot({ credentials: accountA, version: 1, timing: 'after_foreground_ready' }));
    let finishDecrypt: (value: Record<string, unknown>) => void = () => {};
    const applying = applyAccountSettingsV2Update({
      credentials: accountA,
      update: { content: { t: 'encrypted', c: 'ciphertext' }, version: 2 },
      deps: {
        decryptCiphertext: () => new Promise((resolve) => {
          finishDecrypt = resolve;
        }),
      },
    });
    const accountBWinner = snapshot({ credentials: accountB, version: 1, timing: 'after_runtime_idle' });
    setActiveAccountSettingsSnapshot(accountBWinner);
    finishDecrypt({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' });

    await expect(applying).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_SCOPE_CHANGED' });
    expect(getActiveAccountSettingsSnapshot()).toBe(accountBWinner);
    expect(applyProcessEnv).not.toHaveBeenCalled();
  });

  it('rejects a live source that closes while decryption is in flight', async () => {
    const accountCredentials = credentials('account-a');
    const winner = snapshot({ credentials: accountCredentials, version: 1, timing: 'after_foreground_ready' });
    setActiveAccountSettingsSnapshot(winner);
    let finishDecrypt: (value: Record<string, unknown>) => void = () => {};
    let sourceCurrent = true;
    const applying = applyAccountSettingsV2Update({
      credentials: accountCredentials,
      update: { content: { t: 'encrypted', c: 'ciphertext' }, version: 2 },
      shouldCommit: () => sourceCurrent,
      deps: {
        decryptCiphertext: () => new Promise((resolve) => {
          finishDecrypt = resolve;
        }),
      },
    });
    sourceCurrent = false;
    finishDecrypt({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' });

    await expect(applying).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_SOURCE_STALE' });
    expect(getActiveAccountSettingsSnapshot()).toBe(winner);
    expect(applyProcessEnv).not.toHaveBeenCalled();
  });

  it('keeps the newer accepted winner when an older decryption finishes last', async () => {
    const accountCredentials = credentials('account-a');
    setActiveAccountSettingsSnapshot(snapshot({ credentials: accountCredentials, version: 1, timing: 'after_foreground_ready' }));
    let finishOlder: (value: Record<string, unknown>) => void = () => {};
    const older = applyAccountSettingsV2Update({
      credentials: accountCredentials,
      update: { content: { t: 'encrypted', c: 'older' }, version: 2 },
      deps: {
        decryptCiphertext: () => new Promise((resolve) => {
          finishOlder = resolve;
        }),
      },
    });
    const newer = await applyAccountSettingsV2Update({
      credentials: accountCredentials,
      update: {
        content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
        version: 3,
      },
    });
    finishOlder({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' });

    await expect(older).resolves.toMatchObject({ settingsVersion: 3 });
    expect(newer.settingsVersion).toBe(3);
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(3);
    expect(getActiveAccountSettingsSnapshot()?.settings.sessionPendingQueueDeliveryTiming).toBe('after_runtime_idle');
    expect(applyProcessEnv).toHaveBeenCalledTimes(1);
  });
});
