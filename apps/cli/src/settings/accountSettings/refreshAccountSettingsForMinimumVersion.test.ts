import { accountSettingsParse } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { AccountSettingsContext } from './bootstrapAccountSettingsContext';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';
import { refreshAccountSettingsForMinimumVersion } from './refreshAccountSettingsForMinimumVersion';

function createCredentialsStub(token = 'token'): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

function createContext(settingsVersion: number, scopeKey = 'scope:token'): AccountSettingsContext & { scopeKey: string } {
  return {
    source: 'network',
    settings: accountSettingsParse({ schemaVersion: 6 }),
    settingsVersion,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    whenRefreshed: null,
    scopeKey,
  };
}

describe('refreshAccountSettingsForMinimumVersion', () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('returns the active snapshot when it already satisfies the minimum version', async () => {
    const bootstrapAccountSettingsContext = vi.fn(async () => createContext(3));
    const result = await refreshAccountSettingsForMinimumVersion({
      credentials: createCredentialsStub(),
      minSettingsVersion: 2,
      deps: {
        getActiveSnapshot: () => createContext(2),
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'scope:token',
      },
    });

    expect(result.settingsVersion).toBe(2);
    expect(bootstrapAccountSettingsContext).not.toHaveBeenCalled();
  });

  it('forces a refresh when requested even if the active snapshot satisfies the minimum version', async () => {
    const bootstrapAccountSettingsContext = vi.fn(async () => createContext(4));
    const result = await refreshAccountSettingsForMinimumVersion({
      credentials: createCredentialsStub(),
      minSettingsVersion: 2,
      forceRefresh: true,
      deps: {
        getActiveSnapshot: () => createContext(3),
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'scope:token',
      },
    });

    expect(result.settingsVersion).toBe(4);
    expect(bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
      refresh: 'force',
      minSettingsVersion: 2,
    }));
  });

  it('dedupes concurrent refreshes for the same scope and minimum version', async () => {
    let resolveRefresh: (ctx: AccountSettingsContext) => void = () => {};
    const bootstrapAccountSettingsContext = vi.fn(() => new Promise<AccountSettingsContext>((resolve) => {
      resolveRefresh = resolve;
    }));

    const first = refreshAccountSettingsForMinimumVersion({
      credentials: createCredentialsStub(),
      minSettingsVersion: 5,
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'scope:token',
      },
    });
    const second = refreshAccountSettingsForMinimumVersion({
      credentials: createCredentialsStub(),
      minSettingsVersion: 5,
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'scope:token',
      },
    });

    resolveRefresh(createContext(5));

    await expect(Promise.all([first, second])).resolves.toEqual([createContext(5), createContext(5)]);
    expect(bootstrapAccountSettingsContext).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent forced refreshes for the same scope', async () => {
    const resolveRefreshes: Array<(ctx: AccountSettingsContext) => void> = [];
    const bootstrapAccountSettingsContext = vi.fn(() => new Promise<AccountSettingsContext>((resolve) => {
      resolveRefreshes.push(resolve);
    }));
    const params = {
      credentials: createCredentialsStub(),
      minSettingsVersion: null,
      forceRefresh: true,
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'scope:token',
      },
    } as const;

    const first = refreshAccountSettingsForMinimumVersion(params);
    const second = refreshAccountSettingsForMinimumVersion(params);
    // This assertion is the RED discriminator: the previous forced-refresh
    // bypass started two bootstrap calls before either could settle.
    expect(bootstrapAccountSettingsContext).toHaveBeenCalledTimes(1);
    for (const resolveRefresh of resolveRefreshes) {
      resolveRefresh(createContext(5));
    }

    await expect(Promise.all([first, second])).resolves.toEqual([createContext(5), createContext(5)]);
  });

  it('does not coalesce a re-entered Account A scope with a refresh from its retired lifetime', async () => {
    const accountA = createCredentialsStub('account-a');
    const accountB = createCredentialsStub('account-b');
    const scopeA = 'scope:account-a';
    const scopeB = 'scope:account-b';
    const resolveRefreshes: Array<(ctx: AccountSettingsContext) => void> = [];
    const bootstrapAccountSettingsContext = vi.fn(() => new Promise<AccountSettingsContext>((resolve) => {
      resolveRefreshes.push(resolve);
    }));

    setActiveAccountSettingsSnapshot(createContext(1, scopeA));
    const oldLifetime = refreshAccountSettingsForMinimumVersion({
      credentials: accountA,
      forceRefresh: true,
      deps: {
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => scopeA,
      },
    });
    await vi.waitFor(() => expect(bootstrapAccountSettingsContext).toHaveBeenCalledTimes(1));

    setActiveAccountSettingsSnapshot(createContext(2, scopeB));
    setActiveAccountSettingsSnapshot(createContext(3, scopeA));
    const newLifetime = refreshAccountSettingsForMinimumVersion({
      credentials: accountA,
      forceRefresh: true,
      deps: {
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => scopeA,
      },
    });

    try {
      expect(bootstrapAccountSettingsContext).toHaveBeenCalledTimes(2);
    } finally {
      resolveRefreshes.forEach((resolve, index) => {
        resolve(createContext(index + 4, scopeA));
      });
      await Promise.allSettled([oldLifetime, newLifetime]);
    }
  });

  it('dedupes concurrent refreshes for the same credentials scope across agents and backends', async () => {
    const resolveRefreshes: Array<(ctx: AccountSettingsContext) => void> = [];
    const bootstrapAccountSettingsContext = vi.fn(() => new Promise<AccountSettingsContext>((resolve) => {
      resolveRefreshes.push(resolve);
    }));

    const first = refreshAccountSettingsForMinimumVersion({
      credentials: createCredentialsStub(),
      minSettingsVersion: 5,
      agentId: 'claude',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'scope:token',
      },
    });
    const second = refreshAccountSettingsForMinimumVersion({
      credentials: createCredentialsStub(),
      minSettingsVersion: 5,
      agentId: 'codex',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'scope:token',
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    for (const resolveRefresh of resolveRefreshes) {
      resolveRefresh(createContext(5));
    }

    await expect(Promise.all([first, second])).resolves.toEqual([createContext(5), createContext(5)]);
    expect(bootstrapAccountSettingsContext).toHaveBeenCalledTimes(1);
  });

  it('throws a stale account settings error when refresh returns below the required version', async () => {
    await expect(refreshAccountSettingsForMinimumVersion({
      credentials: createCredentialsStub(),
      minSettingsVersion: 5,
      deps: {
        getActiveSnapshot: () => null,
        bootstrapAccountSettingsContext: vi.fn(async () => createContext(4)),
        resolveScopeKey: () => 'scope:token',
      },
    })).rejects.toMatchObject({
      code: 'ACCOUNT_SETTINGS_STALE',
    });
  });

  it('ignores the active snapshot when it belongs to a different credential scope', async () => {
    const bootstrapAccountSettingsContext = vi.fn(async () => createContext(6, 'scope:current'));
    const result = await refreshAccountSettingsForMinimumVersion({
      credentials: createCredentialsStub(),
      minSettingsVersion: 2,
      deps: {
        getActiveSnapshot: () => createContext(5, 'scope:other'),
        bootstrapAccountSettingsContext,
        resolveScopeKey: () => 'scope:current',
      },
    });

    expect(result.settingsVersion).toBe(6);
    expect(bootstrapAccountSettingsContext).toHaveBeenCalledTimes(1);
  });
});
