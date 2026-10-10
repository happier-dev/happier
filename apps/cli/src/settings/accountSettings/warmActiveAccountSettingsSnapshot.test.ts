import { accountSettingsParse } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from './accountSettingsScopeKey';

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
  it('warms the real notification catalog despite an unchanged preference version', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'notification-warm-account' })).toString('base64url')}.signature`,
      encryption: null };
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 7, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const channel = NotificationChannelRecordV1Schema.parse({ v: 1, id: 'retained-warm-channel', kind: 'webhook', topics: {},
      url: 'http://127.0.0.1/notification', signingSecretRef: null });
    // HTTP is the only substituted boundary: warm/refresh/publication and row opening remain real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/notification-channels') return { status: 200, data: {
        status: 'present', revision: 8, content: { t: 'plain', v: { v: 1, channels: [channel] } } } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected notification warm boundary: ${path}`);
    });
    try {
      await expect(warmActiveAccountSettingsSnapshotBestEffort({ credentials })).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 7,
        notificationChannelCatalog: { status: 'ready', revision: 8, channels: [channel] } });
    } finally { get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });
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

  it('forces a network retry when the active snapshot is only an empty fallback', async () => {
    const bootstrapAccountSettingsContext = vi.fn(async () => createContext(7));

    await expect(warmActiveAccountSettingsSnapshotBestEffort({
      credentials: createCredentialsStub(),
      deps: {
        getActiveSnapshot: () => ({
          ...createContext(0),
          source: 'none',
          scopeKey: 'token-scope',
        }),
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'token-scope',
      },
    })).resolves.toBe(true);

    expect(bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
      refresh: 'force',
    }));
  });

  it('does not report an empty fallback snapshot as successfully warmed', async () => {
    const diagnostics: unknown[] = [];

    await expect(warmActiveAccountSettingsSnapshotBestEffort({
      credentials: createCredentialsStub(),
      logger: { debug: (message, error) => { diagnostics.push([message, error]); } },
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext: vi.fn(async () => ({
          ...createContext(0),
          source: 'none' as const,
        })),
        resolveScopeKey: () => 'token-scope',
      },
    })).resolves.toBe(false);

    expect(diagnostics).toHaveLength(1);
  });

  it('fails open and keeps the non-fatal diagnostic out of the user console', async () => {
    const diagnostics: unknown[] = [];

    await expect(warmActiveAccountSettingsSnapshotBestEffort({
      credentials: createCredentialsStub(),
      logger: { debug: (message, error) => { diagnostics.push([message, error]); } },
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext: vi.fn(async () => {
          throw new Error('network down');
        }),
        resolveScopeKey: () => 'token-scope',
      },
    })).resolves.toBe(false);

    expect(diagnostics).toHaveLength(1);
  });
});
