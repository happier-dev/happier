import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol';
import * as accountSettingsSchema from '@happier-dev/protocol/account/settings/accountSettings';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { readSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { runAddedHostedSession, sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { __resetApplyAccountSettingsToProcessEnvStateForTests } from '@/settings/applyAccountSettingsToProcessEnv';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import {
  bootstrapAccountSettingsContext,
  applyAccountSettingsV2Update,
  resetInMemoryAccountSettingsContextForTests,
} from './bootstrapAccountSettingsContext';
import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  beginActivePromptLibraryCatalogRefresh,
  beginActiveProfileCatalogRefresh,
  beginActiveSavedSecretCatalogRefresh,
  clearActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';
import type { AccountSettingsCache } from './accountSettingsCache';
import { createAccountSettingsScopeKey, resolveAccountSettingsScopeKey } from './accountSettingsScopeKey';
import { refreshAccountSettingsForMinimumVersion } from './refreshAccountSettingsForMinimumVersion';

function createCredentials(token: string, secretByte = 1): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(secretByte) },
  };
}

function accountToken(account: string, issuance: number): string {
  return `test.${Buffer.from(JSON.stringify({ sub: account, iat: issuance })).toString('base64url')}.test`;
}

describe('bootstrapAccountSettingsContext active Account scope fence', () => {
  let envScope: ReturnType<typeof createEnvKeyScope>;
  let serverDir: string;
  const originalServerDir = configuration.activeServerDir;
  beforeEach(async () => {
    serverDir = await mkdtemp(join(tmpdir(), 'account-settings-scope-fence-'));
    Object.assign(configuration, { activeServerDir: serverDir });
    resetInMemoryAccountSettingsContextForTests();
    __resetApplyAccountSettingsToProcessEnvStateForTests();
    envScope = createEnvKeyScope(['HAPPIER_ACCOUNT_SETTINGS_MODE', 'HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY',
      'HAPPIER_ACTIONS_SETTINGS_V1', 'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON']);
    envScope.patch({ HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY: undefined,
      HAPPIER_ACTIONS_SETTINGS_V1: undefined, HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: undefined });
  });

  afterEach(async () => {
    resetInMemoryAccountSettingsContextForTests();
    __resetApplyAccountSettingsToProcessEnvStateForTests();
    envScope.restore();
    vi.restoreAllMocks();
    Object.assign(configuration, { activeServerDir: originalServerDir });
    await rm(serverDir, { recursive: true, force: true });
  });

  it('publishes both fast refreshes when two Sessions share the same Account lifetime', async () => {
    let enterFirstRead!: () => void;
    let releaseFirstRead!: () => void;
    const firstReadStarted = new Promise<void>(resolve => { enterFirstRead = resolve; });
    const firstReadHeld = new Promise<void>(resolve => { releaseFirstRead = resolve; });
    const start = (settingsVersion: number, workingDirectory: string, beforeFetch: () => Promise<void>, env: NodeJS.ProcessEnv) => runAddedHostedSession({
      environment: { HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', ...env },
      workingDirectory, end() {},
    }, async () => {
      const base = await bootstrapAccountSettingsContext({
        credentials: { token: accountToken('hosted-account', settingsVersion), encryption: null },
        mode: 'fast', refresh: 'force',
        deps: { readCache: async () => null, fetchFromServer: async () => {
          await beforeFetch();
          return { settingsContent: { t: 'plain', v: { scmIncludeCoAuthoredBy: true } }, settingsVersion };
        } },
      });
      const refreshed = await base.whenRefreshed;
      return { refreshed, active: getActiveAccountSettingsSnapshot(), includeCoAuthors: sessionProcessEnvironment().HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY };
    });
    // A different Account can already be present in the same process.
    await bootstrapAccountSettingsContext({
      credentials: { token: accountToken('other-account', 1), encryption: null },
      refresh: 'force',
      deps: { fetchFromServer: async () => ({ settingsContent: { t: 'plain', v: {} }, settingsVersion: 1 }) },
    });
    const first = start(2, join(serverDir, 'first'), () => {
      enterFirstRead();
      return firstReadHeld;
    }, {});
    await firstReadStarted;
    try {
      const second = await start(3, join(serverDir, 'second'), async () => {}, { HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY: '0' });
      expect(second).toMatchObject({ refreshed: { settingsVersion: 3 }, active: { settingsVersion: 3 }, includeCoAuthors: '0' });
    } finally {
      releaseFirstRead();
      await expect(first).resolves.toMatchObject({
        refreshed: { settingsVersion: 3 }, active: { settingsVersion: 3 }, includeCoAuthors: '1',
      });
    }
  });

  it('reuses the admitted Settings projection on a later hosted Open with equal content', async () => {
    const parse = vi.spyOn(accountSettingsSchema, 'accountSettingsParse');
    const open = (account: string, settingsVersion: number, themePreference: 'light' | 'dark' | null) => (
      runAddedHostedSession({ environment: {}, workingDirectory: serverDir, end() {} }, () =>
        bootstrapAccountSettingsContext({
          credentials: { token: accountToken(account, settingsVersion), encryption: null },
          mode: 'blocking', refresh: 'force', expectedAccountEncryptionMode: 'plain',
          deps: { readCache: async () => null, fetchFromServer: async () => ({
            settingsContent: themePreference === null ? null : { t: 'plain', v: { themePreference } },
            settingsVersion,
          }) },
        }))
    );
    const first = await open('same-settings', 1, 'dark');
    expect(parse).toHaveBeenCalled();
    parse.mockClear();
    const same = await open('same-settings', 2, 'dark');
    expect(same.settingsVersion).toBe(2);
    expect(same.settings).toBe(first.settings);
    expect(parse).not.toHaveBeenCalled();

    const changed = await open('same-settings', 3, 'light');
    expect(changed.settings.themePreference).toBe('light');
    expect(changed.settings).not.toBe(first.settings);
    expect(parse).toHaveBeenCalled();
    parse.mockClear();
    const other = await open('different-account', 1, 'dark');
    expect(other.settings).not.toBe(first.settings);
    expect(parse).toHaveBeenCalled();

    const defaultSettings = await open('no-settings', 1, null);
    parse.mockClear();
    const sameDefaults = await open('no-settings', 2, null);
    expect(sameDefaults.settings).toBe(defaultSettings.settings);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(['same canonical key', 'rotated canonical key'] as const)(
    'keeps an admitted Session Account current across credential forms only with the %s', async material => {
      const secret = new Uint8Array(32).fill(7);
      const token = accountToken('hosted-credential-forms', 1);
      const firstCredentials: Credentials = { token, encryption: { type: 'legacy', secret } };
      const nextSecret = material === 'same canonical key' ? secret : new Uint8Array(32).fill(8);
      const machineKey = deriveAccountMachineKeyFromRecoverySecret(nextSecret);
      const nextCredentials: Credentials = { token, encryption: { type: 'dataKey',
        machineKey, publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey } };
      const bootstrap = (credentials: Credentials, recoverySecret: Uint8Array, settingsVersion: number) => bootstrapAccountSettingsContext({
        credentials, mode: 'blocking', refresh: 'force', expectedAccountEncryptionMode: 'e2ee',
        // Substitute only Home HTTP/cache I/O; opening, publication and custody stay real.
        deps: { readCache: async () => null, writeCache: async () => {}, fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
            material: { type: 'legacy', secret: recoverySecret }, payload: { themePreference: 'dark' },
            randomBytes: length => new Uint8Array(length).fill(1) }) }, settingsVersion,
        }) },
      });
      await runAddedHostedSession({ environment: {}, workingDirectory: join(serverDir, 'first-form'), end() {} }, async () => {
        await bootstrap(firstCredentials, secret, 1);
        const snapshot = getActiveAccountSettingsSnapshot()!;
        const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
        const isCurrent = () => getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
        const operation = createInvocationSavedSecretOperationContextV1({ credentials: firstCredentials, snapshot,
          serverHttpBaseUrl: 'https://credential-forms.test',
          readSourceSnapshot: () => isCurrent() ? getActiveAccountSettingsSnapshot() : null,
          isCurrent: async () => isCurrent() });
        expect(snapshot.settingsSecretsReadKeys).toHaveLength(2);
        await runAddedHostedSession({ environment: {}, workingDirectory: join(serverDir, 'second-form'), end() {} }, async () => {
          const next = await bootstrap(nextCredentials, nextSecret, 2);
          expect(next.settingsSecretsReadKeys).toHaveLength(1);
          if (material === 'same canonical key') expect(next.settingsSecretsReadKeys[0]).toEqual(snapshot.settingsSecretsReadKeys[0]);
          else expect(next.settingsSecretsReadKeys[0]).not.toEqual(snapshot.settingsSecretsReadKeys[0]);
        });
        if (material === 'same canonical key') {
          expect(operation.readSnapshot()).toMatchObject({ settingsVersion: 2, source: 'network' });
          expect(await operation.isCurrent()).toBe(true);
          expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(lifetimeToken);
        } else {
          expect(operation.readSnapshot()).toBeNull();
          expect(await operation.isCurrent()).toBe(false);
          expect(getActiveAccountSettingsSnapshotLifetimeToken()).not.toBe(lifetimeToken);
        }
      });
    },
  );

  it('re-reads Settings for a later hosted Session with new material for the same Account', async () => {
    const start = (secretByte: number, settingsVersion: number) => runAddedHostedSession({
      environment: { HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto' },
      workingDirectory: join(serverDir, String(settingsVersion)), end() {},
    }, async () => {
      const credentials = createCredentials(accountToken('hosted-encrypted-account', settingsVersion), secretByte);
      const base = await bootstrapAccountSettingsContext({
        credentials, mode: 'fast', refresh: 'force', expectedAccountEncryptionMode: 'e2ee',
        deps: { readCache: async () => null, writeCache: async () => {}, fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
            material: { type: 'legacy', secret: new Uint8Array(32).fill(secretByte) },
            payload: { themePreference: secretByte === 1 ? 'light' : 'dark' },
            randomBytes: length => new Uint8Array(length).fill(1) }) }, settingsVersion,
        }) },
      });
      const refreshed = base.whenRefreshed ? await base.whenRefreshed : base;
      return { base, refreshed, active: getActiveAccountSettingsSnapshot() };
    });
    const first = await start(1, 1);
    const second = await start(2, 2);
    expect(first.refreshed).toMatchObject({ settingsVersion: 1, settings: { themePreference: 'light' } });
    expect(second).toMatchObject({ base: { settingsVersion: 2 }, refreshed: { settingsVersion: 2 }, active: { settingsVersion: 2 } });
    expect(second.base.settingsSecretsReadKeys).not.toEqual(first.refreshed.settingsSecretsReadKeys);
  });

  it.each([
    { pendingVersion: 2, publication: 'bootstrap', warm: false, encrypted: false },
    { pendingVersion: 4, publication: 'bootstrap', warm: false, encrypted: false },
    { pendingVersion: 2, publication: 'bootstrap', warm: true, encrypted: false },
    { pendingVersion: 4, publication: 'bootstrap', warm: true, encrypted: false },
    { pendingVersion: 4, publication: 'live', warm: true, encrypted: false },
    { pendingVersion: 4, publication: 'bootstrap', warm: true, encrypted: true },
  ] as const)('accepts concurrent same-Account bearer publications and retains the version winner ($publication, $pendingVersion, warm=$warm, encrypted=$encrypted)', async ({ pendingVersion, publication, warm, encrypted }) => {
    const credentialsA = encrypted ? createCredentials(accountToken('same-account', 1))
      : { token: accountToken('same-account', 1), encryption: null };
    const credentialsB = encrypted ? createCredentials(accountToken('same-account', 2))
      : { token: accountToken('same-account', 2), encryption: null };
    const content = (themePreference: 'light' | 'dark') => encrypted
      ? { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(1) }, payload: { themePreference },
        randomBytes: length => new Uint8Array(length).fill(1) }) }
      : { t: 'plain' as const, v: { themePreference } };
    const scopeKey = resolveAccountSettingsScopeKey(credentialsA);
    if (warm) await bootstrapAccountSettingsContext({ credentials: credentialsA, refresh: 'force',
      deps: { fetchFromServer: async () => ({ settingsContent: content('light'), settingsVersion: 1 }) } });
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = bootstrapAccountSettingsContext({ credentials: credentialsA, refresh: 'force',
      minSettingsVersion: pendingVersion,
      deps: { fetchFromServer: async () => {
        entered();
        await held;
        return { settingsContent: content('dark'), settingsVersion: pendingVersion };
      } } });
    // Attach the rejection observer before releasing the network boundary.
    const outcome = pending.then(context => ({ context }), (error: unknown) => ({ error,
      branch: error && typeof error === 'object' && 'branch' in error ? error.branch : undefined }));
    await started;
    let incumbent: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>;
    try {
      incumbent = publication === 'bootstrap'
        ? await bootstrapAccountSettingsContext({ credentials: credentialsB, refresh: 'force',
          deps: { fetchFromServer: async () => ({ settingsContent: content('light'), settingsVersion: 3 }) } })
        : await applyAccountSettingsV2Update({ credentials: credentialsB,
          update: { content: content('light'), version: 3 } });
    } finally { release(); }
    expect(await outcome).toMatchObject({ context: { settingsVersion: Math.max(3, pendingVersion), scopeKey } });
    expect(incumbent.scopeKey).toBe(scopeKey);
    if (warm) {
      expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(lifetime);
    } else {
      expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBeGreaterThan(lifetime);
    }
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: Math.max(3, pendingVersion),
      settings: { themePreference: pendingVersion > 3 ? 'dark' : 'light' } });
  });

  it.each(['account', 'home', 'retirement', 'keys'] as const)('refuses a pending read after a real %s change', async change => {
    const credentialsA = createCredentials(accountToken('account-a', 1));
    const credentialsB = createCredentials(accountToken(change === 'account' ? 'account-b' : 'account-a', 2), change === 'keys' ? 2 : 1);
    const response = (credentials: Credentials, version: number) => ({ settingsVersion: version,
      settingsContent: { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'legacy', secret: credentials.encryption.type === 'legacy' ? credentials.encryption.secret : credentials.encryption.machineKey },
        payload: { themePreference: 'dark' }, randomBytes: length => new Uint8Array(length).fill(version) }) } });
    await bootstrapAccountSettingsContext({ credentials: credentialsA, refresh: 'force',
      deps: { fetchFromServer: async () => response(credentialsA, 1) } });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = bootstrapAccountSettingsContext({ credentials: credentialsA, refresh: 'force',
      deps: { fetchFromServer: async () => { entered(); await held; return response(credentialsA, 4); } } });
    const outcome = pending.then(context => ({ context }), error => ({ error }));
    await started;
    if (change === 'home') Object.assign(configuration, { activeServerDir: join(serverDir, 'other-home') });
    if (change === 'retirement') clearActiveAccountSettingsSnapshot();
    const incumbent = change === 'retirement' ? null : await bootstrapAccountSettingsContext({ credentials: credentialsB, refresh: 'force',
      deps: { fetchFromServer: async () => response(credentialsB, 3) } });
    release();
    const result = await outcome;
    expect(result).toMatchObject({ error: { code: 'ACCOUNT_SETTINGS_SCOPE_CHANGED' } });
    if ('error' in result) {
      expect(readSessionRuntimeFailureCause(result.error)).toMatchObject({
        code: 'ACCOUNT_SETTINGS_SCOPE_CHANGED', phase: 'client_start', failureReason: 'account_changed',
      });
    }
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion ?? null).toBe(incumbent?.settingsVersion ?? null);
    expect(getActiveAccountSettingsSnapshot()?.settingsSecretsReadKeys ?? null).toEqual(incumbent?.settingsSecretsReadKeys ?? null);
  });

  it.each([2, 3])('accepts concurrent first encrypted live publications for the same Account and retains the version winner (pending=%i)', async pendingVersion => {
    const update = (version: number) => ({ version, content: { t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        payload: { themePreference: version === 2 ? 'light' : 'dark' },
        randomBytes: length => new Uint8Array(length).fill(version) }) } });
    const first = applyAccountSettingsV2Update({ credentials: createCredentials(accountToken('cold-live-account', 1)),
      update: update(2) });
    const second = applyAccountSettingsV2Update({ credentials: createCredentials(accountToken('cold-live-account', 2)),
      update: update(pendingVersion) });
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: pendingVersion,
      settings: { themePreference: pendingVersion === 2 ? 'light' : 'dark' } });
  });

  it.each([1, 2])('keeps an in-flight bootstrap current when the channel binding store publishes a same-Account source read (issuance %i)', async issuance => {
    const credentials = { token: accountToken('channel-account', 1), encryption: null };
    await bootstrapAccountSettingsContext({ credentials, refresh: 'force',
      deps: { fetchFromServer: async () => ({ settingsContent: { t: 'plain', v: {} }, settingsVersion: 1 }) } });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = bootstrapAccountSettingsContext({ credentials, refresh: 'force',
      deps: { fetchFromServer: async () => { entered(); await held;
        return { settingsContent: { t: 'plain', v: {} }, settingsVersion: 4 }; } } });
    const outcome = pending.then(context => ({ context }), error => ({ error }));
    await started;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 3, content: { t: 'plain', v: {} } } };
      return { status: 404, data: { error: 'unsupported' } };
    });
    try {
      const bindingCredentials = { ...credentials, token: accountToken('channel-account', issuance) };
      await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials: bindingCredentials }).read()).resolves.toEqual({ v: 1, bindings: [] });
      // An admitted catalog read observes the row only; it repeats no source transfer, so the settings version stays the incumbent's.
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(1);
    } finally { release(); }
    expect(await outcome).toMatchObject({ context: { settingsVersion: 4 } });
    expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject({ status: 'ready', revision: 1 });
  });

  it('does not mistake an independent catalog refresh for a competing key-material publication', async () => {
    const credentials = createCredentials(accountToken('material-refresh', 1));
    const nextCredentials = createCredentials(accountToken('material-refresh', 2), 2);
    const ciphertext = (secretByte: number) => sealAccountScopedBlobCiphertext({ kind: 'account_settings',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(secretByte) }, payload: {},
      randomBytes: length => new Uint8Array(length).fill(secretByte) });
    const initial = await bootstrapAccountSettingsContext({ credentials, refresh: 'force',
      deps: { fetchFromServer: async () => ({ settingsContent: { t: 'encrypted', c: ciphertext(1) }, settingsVersion: 1 }) } });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = bootstrapAccountSettingsContext({ credentials: nextCredentials, refresh: 'force',
      deps: { fetchFromServer: async () => { entered(); await held;
        return { settingsContent: { t: 'encrypted', c: ciphertext(2) }, settingsVersion: 2 }; } } });
    const outcome = pending.then(context => ({ context }), error => ({ error }));
    await started;
    beginActivePromptLibraryCatalogRefresh({ scopeKey: initial.scopeKey!,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    release();
    expect(await outcome).toMatchObject({ context: { settingsVersion: 2,
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(nextCredentials) } });
  });

  it('does not share a forced refresh across different key material in the same Account', async () => {
    const credentialsA = createCredentials(accountToken('refresh-material', 1));
    const credentialsB = createCredentials(accountToken('refresh-material', 2), 2);
    const response = (secretByte: number, version: number) => ({ status: 200, data: { version,
      content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(secretByte) }, payload: {},
        randomBytes: length => new Uint8Array(length).fill(version) }) } } });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(axios, 'get').mockResolvedValueOnce(response(1, 1)).mockImplementation(async (_url, options) => {
      if (options?.headers?.Authorization === `Bearer ${credentialsA.token}`) {
        entered();
        await held;
        return response(1, 6);
      }
      return response(2, 7);
    });
    await bootstrapAccountSettingsContext({ credentials: credentialsA, refresh: 'force' });
    const pending = refreshAccountSettingsForMinimumVersion({ credentials: credentialsA, minSettingsVersion: 5, forceRefresh: true });
    const settled = pending.catch(() => null);
    await started;
    const next = refreshAccountSettingsForMinimumVersion({ credentials: credentialsB, minSettingsVersion: 5, forceRefresh: true });
    release();
    await expect(next).resolves.toMatchObject({ settingsVersion: 7,
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentialsB) });
    await settled;
    expect(getActiveAccountSettingsSnapshot()?.settingsSecretsReadKeys).toEqual(deriveSettingsSecretsReadKeysForCredentials(credentialsB));
  });

  it.each(['bootstrap', 'refresh', 'live'] as const)('does not reuse warm E2EE content with incompatible key material through %s', async reader => {
    const credentials = createCredentials(accountToken('warm-material', 1));
    const nextCredentials = createCredentials(accountToken('warm-material', 2), 2);
    const ciphertext = sealAccountScopedBlobCiphertext({ kind: 'account_settings',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(1) }, payload: {},
      randomBytes: length => new Uint8Array(length).fill(1) });
    await bootstrapAccountSettingsContext({ credentials, refresh: 'force',
      deps: { fetchFromServer: async () => ({ settingsContent: { t: 'encrypted', c: ciphertext }, settingsVersion: 1 }) } });
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Network unavailable'));
    const pending = reader === 'live'
      ? applyAccountSettingsV2Update({ credentials: nextCredentials, update: { content: { t: 'encrypted', c: ciphertext }, version: 1 } })
      : reader === 'bootstrap' ? bootstrapAccountSettingsContext({ credentials: nextCredentials, minSettingsVersion: 1 })
        : refreshAccountSettingsForMinimumVersion({ credentials: nextCredentials, minSettingsVersion: 1 });
    await expect(pending).rejects.toMatchObject({ code: reader === 'live' ? 'ACCOUNT_SETTINGS_SCOPE_CHANGED' : 'ACCOUNT_SETTINGS_DECRYPT_FAILED' });
  });

  it('allows an explicit Account bootstrap when the different incumbent only refreshes its own preferences', async () => {
    const credentialsA = { token: accountToken('requested-account', 1), encryption: null };
    const credentialsB = { token: accountToken('incumbent-account', 1), encryption: null };
    const publishB = (settingsVersion: number) => bootstrapAccountSettingsContext({ credentials: credentialsB, refresh: 'force',
      deps: { fetchFromServer: async () => ({ settingsContent: { t: 'plain', v: { themePreference: 'light' } }, settingsVersion }) } });
    await publishB(1);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = bootstrapAccountSettingsContext({ credentials: credentialsA, refresh: 'force', minSettingsVersion: 2,
      deps: { fetchFromServer: async () => { entered(); await held;
        return { settingsContent: { t: 'plain', v: { themePreference: 'dark' } }, settingsVersion: 2 }; } } });
    const outcome = pending.then(context => ({ context }), (error: unknown) => ({ error,
      branch: error && typeof error === 'object' && 'branch' in error ? error.branch : undefined }));
    await started;
    try { await publishB(3); } finally { release(); }
    expect(await outcome).toMatchObject({ context: { scopeKey: resolveAccountSettingsScopeKey(credentialsA),
      settingsVersion: 2, settings: { themePreference: 'dark' } } });
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({ scopeKey: resolveAccountSettingsScopeKey(credentialsA), settingsVersion: 2 });
  });

  it('does not confuse first publication with retirement and re-entry of the same Account', async () => {
    const credentials = { token: accountToken('cold-retirement', 1), encryption: null };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = bootstrapAccountSettingsContext({ credentials, refresh: 'force', minSettingsVersion: 4,
      deps: { fetchFromServer: async () => { entered(); await held;
        return { settingsContent: { t: 'plain', v: { themePreference: 'dark' } }, settingsVersion: 4 }; } } });
    const outcome = pending.then(context => ({ context }), error => ({ error }));
    await started;
    const publish = (settingsVersion: number) => bootstrapAccountSettingsContext({ credentials, refresh: 'force',
      deps: { fetchFromServer: async () => ({ settingsContent: { t: 'plain', v: { themePreference: 'light' } }, settingsVersion }) } });
    try {
      await publish(1);
      clearActiveAccountSettingsSnapshot();
      await publish(3);
    } finally { release(); }
    expect(await outcome).toMatchObject({ error: { code: 'ACCOUNT_SETTINGS_STALE' } });
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 3, settings: { themePreference: 'light' } });
  });

  it.each([
    beginActivePromptLibraryCatalogRefresh,
    beginActiveProfileCatalogRefresh,
    beginActiveSavedSecretCatalogRefresh,
  ])('does not retire a Settings publication when a subscriber refreshes an independent catalog in the same Account (%#)', async beginRefresh => {
    const unsubscribe = subscribeActiveAccountSettingsSnapshot((_previous, next) => {
      if (next?.scopeKey) beginRefresh({ scopeKey: next.scopeKey,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    });
    try {
      const context = await bootstrapAccountSettingsContext({ credentials: { token: 'same-account', encryption: null },
        mode: 'blocking', refresh: 'force', deps: {
          fetchFromServer: async () => ({ settingsContent: { t: 'plain', v: {} }, settingsVersion: 1 }),
        } });
      expect(context).toMatchObject({ source: 'network', settingsVersion: 1 });
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({ scopeKey: context.scopeKey,
        settingsVersion: 1 });
      if (beginRefresh === beginActivePromptLibraryCatalogRefresh) {
        expect(getActiveAccountSettingsSnapshot()?.promptLibraryCatalog).toEqual({ status: 'loading' });
      }
    } finally { unsubscribe(); }
  });

  it('applies live Settings process defaults when a synchronous subscriber refreshes an independent catalog', async () => {
    const credentials = { token: accountToken('live-catalog-account', 1), encryption: null };
    await applyAccountSettingsV2Update({ credentials,
      update: { version: 1, content: { t: 'plain', v: { scmIncludeCoAuthoredBy: true } } } });
    expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBe('1');
    const unsubscribe = subscribeActiveAccountSettingsSnapshot((_previous, next) => {
      if (next?.scopeKey) beginActivePromptLibraryCatalogRefresh({ scopeKey: next.scopeKey,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    });
    try {
      await expect(applyAccountSettingsV2Update({ credentials,
        update: { version: 2, content: { t: 'plain', v: { scmIncludeCoAuthoredBy: false } } } }))
        .resolves.toMatchObject({ settingsVersion: 2, settings: { scmIncludeCoAuthoredBy: false },
          promptLibraryCatalog: { status: 'loading' } });
      expect(process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY).toBe('0');
    } finally { unsubscribe(); }
  });

  it('attributes a publication refusal when a subscriber retires the Account lifetime before side effects', async () => {
    const unsubscribe = subscribeActiveAccountSettingsSnapshot((_previous, next) => {
      if (next) clearActiveAccountSettingsSnapshot();
    });
    try {
      await expect(bootstrapAccountSettingsContext({
        credentials: { token: 'retired-account', encryption: null },
        mode: 'blocking', refresh: 'force',
        deps: {
          fetchFromServer: async () => ({ settingsContent: { t: 'plain', v: {} }, settingsVersion: 1 }),
        },
      })).rejects.toMatchObject({
        code: 'ACCOUNT_SETTINGS_SCOPE_CHANGED',
        branch: 'bootstrap_side_effects_before',
      });
      expect(getActiveAccountSettingsSnapshot()).toBeNull();
    } finally { unsubscribe(); }
  });

  it('does not let a late Account A bootstrap replace the active Account B snapshot', async () => {
    const credentialsA = createCredentials('account-a-token');
    const credentialsB = createCredentials('account-b-token');
    const cachePathA = '/tmp/server/account-a/settings.cache.json';
    const cachePathB = '/tmp/server/account-b/settings.cache.json';
    let releaseAccountA!: (raw: Record<string, unknown>) => void;
    const decryptAccountA = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      releaseAccountA = resolve;
    }));
    const writeAccountACache = vi.fn(async () => {});
    const applyAccountASideEffects = vi.fn();

    const pendingAccountA = bootstrapAccountSettingsContext({
      credentials: credentialsA,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 100,
      deps: {
        resolveCachePath: () => cachePathA,
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'account-a-ciphertext' },
          settingsVersion: 3,
        }),
        decryptCiphertext: decryptAccountA,
        writeCache: writeAccountACache,
        applySideEffects: applyAccountASideEffects,
      },
    });
    await vi.waitFor(() => expect(decryptAccountA).toHaveBeenCalledTimes(1));

    const accountB = await bootstrapAccountSettingsContext({
      credentials: credentialsB,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 200,
      deps: {
        resolveCachePath: () => cachePathB,
        readCache: async () => null,
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 5 }),
        decryptCiphertext: async () => ({}),
        writeCache: async () => {},
        applySideEffects: vi.fn(),
      },
    });
    expect(accountB.scopeKey).toBe(createAccountSettingsScopeKey({
      cachePath: cachePathB,
      token: credentialsB.token,
    }));

    releaseAccountA({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' });

    await expect(pendingAccountA).rejects.toMatchObject({
      code: 'ACCOUNT_SETTINGS_SCOPE_CHANGED',
      branch: 'bootstrap_lifetime_before_commit',
    });
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey: accountB.scopeKey,
      settingsVersion: 5,
    });
    expect(writeAccountACache).not.toHaveBeenCalled();
    expect(applyAccountASideEffects).not.toHaveBeenCalled();
  });

  it('does not reuse or durably publish retired A settings after A -> B -> A with new encryption material', async () => {
    const accountAOld = createCredentials('account-a-token', 1);
    const accountANew = createCredentials('account-a-token', 2);
    const accountB = createCredentials('account-b-token', 3);
    const accountACachePath = '/tmp/server/account-a/settings.cache.json';
    const accountBCachePath = '/tmp/server/account-b/settings.cache.json';
    const appliedSettings: AccountSettings[] = [];
    const persistedCiphertexts: string[] = [];
    let releaseOldCacheWrite!: () => void;
    const writeCache = vi.fn(async (
      _path: string,
      cache: AccountSettingsCache,
      options?: Readonly<{ shouldCommit?: () => boolean }>,
    ) => {
      const ciphertext = cache.version === 2 && cache.settingsContent?.t === 'encrypted'
        ? cache.settingsContent.c
        : null;
      if (ciphertext === 'old-a') {
        await new Promise<void>((resolve) => {
          releaseOldCacheWrite = resolve;
        });
      }
      if (options?.shouldCommit?.() === false) return;
      if (ciphertext) persistedCiphertexts.push(ciphertext);
    });

    const oldBootstrap = bootstrapAccountSettingsContext({
      credentials: accountAOld,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 100,
      deps: {
        resolveCachePath: () => accountACachePath,
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'old-a' },
          settingsVersion: 3,
        }),
        decryptCiphertext: async () => ({
          sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
        }),
        writeCache,
        applySideEffects: ({ settings }) => {
          appliedSettings.push(settings);
        },
      },
    });
    await vi.waitFor(() => expect(writeCache).toHaveBeenCalledTimes(1));

    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
      settingsVersion: 7,
      loadedAtMs: 101,
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(accountB),
      scopeKey: createAccountSettingsScopeKey({
        cachePath: accountBCachePath,
        token: accountB.token,
      }),
    });

    const newContext = await bootstrapAccountSettingsContext({
      credentials: accountANew,
      mode: 'blocking',
      refresh: 'auto',
      nowMs: 102,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => accountACachePath,
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'new-a' },
          settingsVersion: 8,
        }),
        decryptCiphertext: async () => ({
          sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
        }),
        writeCache,
        applySideEffects: ({ settings }) => {
          appliedSettings.push(settings);
        },
      },
    });

    expect(newContext).toMatchObject({
      source: 'network',
      settingsVersion: 8,
      settings: expect.objectContaining({
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      }),
    });
    expect(newContext.settingsSecretsReadKeys).toEqual(
      deriveSettingsSecretsReadKeysForCredentials(accountANew),
    );
    expect(newContext.settingsSecretsReadKeys).not.toEqual(
      deriveSettingsSecretsReadKeysForCredentials(accountAOld),
    );
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey: createAccountSettingsScopeKey({
        cachePath: accountACachePath,
        token: accountANew.token,
      }),
      settingsVersion: 8,
      settings: expect.objectContaining({
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      }),
    });
    expect(appliedSettings.at(-1)).toMatchObject({
      sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    releaseOldCacheWrite();
    await expect(oldBootstrap).resolves.toMatchObject({
      settingsVersion: 8,
      settings: expect.objectContaining({
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      }),
    });
    expect(persistedCiphertexts).toEqual(['new-a']);
    expect(appliedSettings.at(-1)).toMatchObject({
      sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
    });
  });
});
