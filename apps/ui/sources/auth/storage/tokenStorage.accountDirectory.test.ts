import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import {
    installLocalStorageMock,
    installWebLockManagerMock,
    type LocalStorageMockHandle,
    type WebLockManagerMockHandle,
} from './tokenStorage.web.testHelpers';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('token_storage_account_directory');

// One module instance serves the file; cross-tab contracts below load further instances explicitly.
const tokenStorageModule = await import('./tokenStorage');
const {
    TokenStorage,
    captureAccountDirectoryCredentialCustody,
    parseAuthCredentials,
    normalizeAccountDirectoryEndpoint,
    subscribeAccountDirectoryCredentialMutations,
    ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY,
    PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY,
} = tokenStorageModule;
const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');

/** Fixed clock for pending-record fixtures built at collection time. */
const PENDING_NOW = 1_000_000;

function bindCanonicalServerUrl<T extends Readonly<{ endpoint: string }>>(
    fixture: T,
): T & Readonly<{ canonicalServerUrl: string; entryIntent: { kind: 'enter', target: { kind: 'automatic' } } }> {
    return { ...fixture, canonicalServerUrl: fixture.endpoint, entryIntent: { kind: 'enter', target: { kind: 'automatic' } } };
}

describe('TokenStorage Account Directory namespaces', () => {
    it('retains exact entry intent separately from authenticated link-source intent', async () => {
        const target = { endpoint: 'https://directory.example.test', serverIdentityId: 'srv_directory' };
        const record = {
            ...target, canonicalServerUrl: target.endpoint,
            credentialTarget: 'account_directory' as const, purpose: 'account_directory' as const,
            provider: 'github', mode: 'keyless' as const, proof: 'proof',
            createdAt: Date.now(), expiresAt: Date.now() + 60_000,
            entryIntent: { kind: 'enter' as const, target: { kind: 'explicit' as const, homeServerIdentityId: 'srv_a' } },
            explicitHomeServerIdentityId: 'srv_a',
        };
        expect(await TokenStorage.setPendingAccountDirectoryAuth(record)).toBe(true);
        expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toMatchObject({
            entryIntent: record.entryIntent, explicitHomeServerIdentityId: 'srv_a',
        });
        expect(await TokenStorage.setPendingAccountDirectoryAuth({ ...record, linkHomeServerIdentityId: 'srv_b' })).toBe(false);
    });
    let restoreLocalStorage: (() => void) | null = null;
    let restoreWebLocks: (() => void) | null = null;
    let webLocks: WebLockManagerMockHandle | null = null;
    let localStorageHandle: LocalStorageMockHandle | null = null;

    beforeEach(() => {
        localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        webLocks = installWebLockManagerMock();
        restoreWebLocks = webLocks.restore;
    });

    afterEach(() => {
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        localStorageHandle = null;
        restoreWebLocks?.();
        restoreWebLocks = null;
        webLocks = null;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(['direct', 'oauth'] as const)('keeps Home windows when only Directory credentials are replaced (%s)', async (entry) => {
        const target = { endpoint: 'https://desktop-directory.example.test', serverIdentityId: 'desktop-directory' };
        const token = (sub: string, signature = 'sig') => `hdr.${Buffer.from(JSON.stringify({ sub })).toString('base64')}.${signature}`;
        const previous = { token: token('outgoing-directory-account') };
        const nativeValues = new Map<string, string>();
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            const key = String(args?.key ?? '');
            if (command === 'desktop_secure_storage_read') return nativeValues.get(key) ?? null;
            if (command === 'desktop_secure_storage_write') { nativeValues.set(key, String(args?.value)); return null; }
            if (command === 'desktop_secure_storage_remove') { nativeValues.delete(key); return null; }
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke, metadata: { currentWindow: { label: 'main' } } });
        await expect(TokenStorage.accountDirectoryAuthCredentials.set(target, previous)).resolves.toBe(true);
        if (entry === 'direct') {
            await expect(TokenStorage.accountDirectoryAuthCredentials.set(target, { token: token('incoming-directory-account') })).resolves.toBe(true);
        } else {
            await expect(TokenStorage.setPendingAccountDirectoryAuth(bindCanonicalServerUrl({
                ...target, credentialTarget: 'account_directory', purpose: 'account_directory', provider: 'github',
                pending: 'desktop-oauth-return', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
            }))).resolves.toBe(true);
            const expectedPending = await TokenStorage.getPendingAccountDirectoryAuth(target);
            expect(expectedPending).not.toBeNull();
            await expect(TokenStorage.commitAccountDirectoryOAuthCredential({
                expectedPending: expectedPending!, credentials: { token: token('incoming-directory-account') },
            })).resolves.toEqual({ kind: 'committed' });
        }
        expect(await TokenStorage.accountDirectoryAuthCredentials.get(target)).toEqual({ token: token('incoming-directory-account') });
        expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toHaveLength(0);
        invoke.mockClear();
        await expect(TokenStorage.accountDirectoryAuthCredentials.set(target, { token: token('incoming-directory-account', 'refresh') })).resolves.toBe(true);
        expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toHaveLength(0);
    });

    it.each(['direct', 'oauth'] as const)('keeps outgoing desktop Account windows when replacement storage fails (%s)', async (entry) => {
        const target = { endpoint: 'https://desktop-failed-directory.example.test', serverIdentityId: 'desktop-failed-directory' };
        const token = (sub: string) => `hdr.${Buffer.from(JSON.stringify({ sub })).toString('base64')}.sig`;
        const previous = { token: token('outgoing-failed-account') };
        const nativeValues = new Map<string, string>();
        let rejectCredentialWrite = false;
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            const key = String(args?.key ?? '');
            if (command === 'desktop_secure_storage_read') return nativeValues.get(key) ?? null;
            if (command === 'desktop_secure_storage_write') {
                if (rejectCredentialWrite && key.includes(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY)) throw new Error('OS storage unavailable');
                nativeValues.set(key, String(args?.value));
            }
            if (command === 'desktop_secure_storage_remove') nativeValues.delete(key);
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke, metadata: { currentWindow: { label: 'main' } } });
        expect(await TokenStorage.accountDirectoryAuthCredentials.set(target, previous)).toBe(true);
        if (entry === 'oauth') expect(await TokenStorage.setPendingAccountDirectoryAuth(bindCanonicalServerUrl({
            ...target, credentialTarget: 'account_directory', purpose: 'account_directory', provider: 'github',
            pending: 'failed-oauth-return', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
        }))).toBe(true);
        const pending = entry === 'oauth' ? await TokenStorage.getPendingAccountDirectoryAuth(target) : null;
        rejectCredentialWrite = true;
        if (entry === 'direct') {
            expect(await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: token('incoming-failed-account') })).toBe(false);
        } else {
            expect(await TokenStorage.commitAccountDirectoryOAuthCredential({ expectedPending: pending!, credentials: { token: token('incoming-failed-account') } }))
                .toEqual({ kind: 'storage_failed', accountCredentialCommitted: false });
        }
        expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toEqual([]);
    });

    it.each(['success', 'cancel'] as const)('closes outgoing windows only after credentialed Home adoption succeeds (%s)', async outcome => {
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        const { adoptHomeProfileWithCredentials } = await import('@/sync/domains/server/adoptHomeProfile');
        const descriptor = { ...createDirectoryHttpFixture().home.connectionDescriptor,
            homeServerIdentityId: 'srv_desktop_adoption_home', canonicalServerUrl: 'https://desktop-adoption-home.test',
            endpoints: [{ kind: 'https' as const, url: 'https://desktop-adoption-home.test' }] };
        const profile = await adoptHomeProfile({ descriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        const token = (sub: string) => `hdr.${Buffer.from(JSON.stringify({ sub })).toString('base64')}.sig`;
        const previous = { token: token('outgoing-adoption-account') };
        const incoming = { token: token('incoming-adoption-account') };
        const values = new Map<string, string>();
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            const key = String(args?.key ?? '');
            if (command === 'desktop_secure_storage_read') return values.get(key) ?? null;
            if (command === 'desktop_secure_storage_write') values.set(key, String(args?.value));
            if (command === 'desktop_secure_storage_remove') values.delete(key);
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke, metadata: { currentWindow: { label: 'main' } } });
        expect(await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id }, previous)).toBe(true);
        let cancellations = 0;
        const adopting = adoptHomeProfileWithCredentials({ descriptor, source: 'account-directory',
            descriptorAuthority: 'current_connection_observation', credentials: incoming,
            shouldCancel: () => outcome === 'cancel' && ++cancellations === 2 });
        if (outcome === 'cancel') {
            await expect(adopting).rejects.toThrow(/cancelled/i);
            expect(await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id })).toEqual(previous);
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toEqual([]);
        } else {
            await expect(adopting).resolves.toMatchObject({ id: profile.id });
            expect(await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id })).toEqual(incoming);
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_windows_teardown')).toEqual([
                ['desktop_app_windows_teardown', { scopes: [{ serverId: profile.serverIdentityId ?? profile.id, accountId: 'outgoing-adoption-account' }] }],
            ]);
        }
    });

    it('serializes disjoint Account Service credential writes across fresh browser module instances', async () => {
        const first = tokenStorageModule;
        vi.resetModules();
        const second = await import('./tokenStorage');
        const firstTarget = { endpoint: 'https://directory-a.example.test', serverIdentityId: 'directory-a' };
        const secondTarget = { endpoint: 'https://directory-b.example.test', serverIdentityId: 'directory-b' };

        await Promise.all([
            first.TokenStorage.accountDirectoryAuthCredentials.set(firstTarget, { token: 'directory-token-a' }),
            second.TokenStorage.accountDirectoryAuthCredentials.set(secondTarget, { token: 'directory-token-b' }),
        ]);

        await expect(first.TokenStorage.accountDirectoryAuthCredentials.get(firstTarget)).resolves.toEqual({ token: 'directory-token-a' });
        await expect(first.TokenStorage.accountDirectoryAuthCredentials.get(secondTarget)).resolves.toEqual({ token: 'directory-token-b' });
    });

    it('serializes disjoint pending Account Service auth writes across fresh browser module instances', async () => {
        const first = tokenStorageModule;
        vi.resetModules();
        const second = await import('./tokenStorage');
        const now = Date.now();
        const makePending = (suffix: string) => ({
            endpoint: `https://directory-${suffix}.example.test`,
            serverIdentityId: `directory-${suffix}`,
            canonicalServerUrl: `https://directory-${suffix}.example.test`,
            credentialTarget: 'account_directory' as const,
            entryIntent: { kind: 'enter' as const, target: { kind: 'automatic' as const } },
            provider: 'github',
            purpose: 'account_directory' as const,
            pending: `pending-${suffix}`,
            createdAt: now,
            expiresAt: now + 60_000,
        });
        const pendingA = makePending('a');
        const pendingB = makePending('b');

        await Promise.all([
            first.TokenStorage.setPendingAccountDirectoryAuth(pendingA),
            second.TokenStorage.setPendingAccountDirectoryAuth(pendingB),
        ]);

        await expect(first.TokenStorage.getPendingAccountDirectoryAuth(pendingA)).resolves.toEqual(pendingA);
        await expect(first.TokenStorage.getPendingAccountDirectoryAuth(pendingB)).resolves.toEqual(pendingB);
    });

    it('does not let captured logout or request admission retire or issue a newer cross-tab credential', async () => {
        const first = tokenStorageModule;
        const target = { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' };
        await first.TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token-old' });
        const captured = first.captureAccountDirectoryCredentialCustody(target);
        await expect(captured.read()).resolves.toEqual({ token: 'directory-token-old' });

        vi.resetModules();
        const second = await import('./tokenStorage');
        await second.TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token-new' });

        let issued = false;
        await expect(captured.issue(async () => {
            issued = true;
            return new Response(null, { status: 200 });
        })).rejects.toThrow(/superseded/i);
        expect(issued).toBe(false);
        await expect(captured.logout()).resolves.toBe(false);
        await expect(second.TokenStorage.accountDirectoryAuthCredentials.get(target)).resolves.toEqual({ token: 'directory-token-new' });

        const replacementCustody = second.captureAccountDirectoryCredentialCustody(target);
        await expect(replacementCustody.read()).resolves.toEqual({ token: 'directory-token-new' });
        vi.resetModules();
        const third = await import('./tokenStorage');
        await expect(third.TokenStorage.accountDirectoryAuthCredentials.remove(target)).resolves.toBe(true);
        await expect(replacementCustody.issue(async () => {
            issued = true;
            return new Response(null, { status: 200 });
        })).rejects.toThrow(/superseded/i);
        expect(issued).toBe(false);
    });

    it('claims OAuth return custody only for its exact committed credential across browser module instances', async () => {
        const first = tokenStorageModule;
        const target = { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' };
        const intent = { kind: 'enter' as const, target: { kind: 'automatic' as const } };
        const expected = { ...target, intent, invokingSurface: '/setup/wizard' };
        await first.TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token-a' });
        await expect(first.TokenStorage.recordAccountDirectoryOAuthReturn({
            ...target,
            canonicalServerUrl: target.endpoint,
            entryIntent: intent,
            returnTo: '/setup/wizard',
        }, { expectedCredentialToken: 'directory-token-a' })).resolves.toBe(true);

        vi.resetModules();
        const second = await import('./tokenStorage');
        await second.TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token-b' });

        await expect(first.TokenStorage.claimAccountDirectoryOAuthReturn(expected)).resolves.toBeNull();
    });

    it('rejects OAuth return custody when a newer same-service start exists', async () => {
        const first = tokenStorageModule;
        const target = { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' };
        const intent = { kind: 'enter' as const, target: { kind: 'automatic' as const } };
        await first.TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token-a' });
        await expect(first.TokenStorage.recordAccountDirectoryOAuthReturn({
            ...target,
            canonicalServerUrl: target.endpoint,
            entryIntent: intent,
            returnTo: '/setup/wizard',
        }, { expectedCredentialToken: 'directory-token-a' })).resolves.toBe(true);

        vi.resetModules();
        const second = await import('./tokenStorage');
        const now = Date.now();
        await second.TokenStorage.setPendingAccountDirectoryAuth({
            ...target,
            canonicalServerUrl: target.endpoint,
            credentialTarget: 'account_directory',
            entryIntent: intent,
            provider: 'github',
            purpose: 'account_directory',
            pending: 'new-provider-pending',
            createdAt: now,
            expiresAt: now + 60_000,
        });

        await expect(first.TokenStorage.claimAccountDirectoryOAuthReturn({
            ...target,
            intent,
            invokingSurface: '/setup/wizard',
        })).resolves.toBeNull();
    });

    it('returns credential custody bound to the claimed OAuth credential', async () => {
        const first = tokenStorageModule;
        const target = { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' };
        const intent = { kind: 'enter' as const, target: { kind: 'automatic' as const } };
        await first.TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token-a' });
        await first.TokenStorage.recordAccountDirectoryOAuthReturn({
            ...target,
            canonicalServerUrl: target.endpoint,
            entryIntent: intent,
            returnTo: '/setup/wizard',
        }, { expectedCredentialToken: 'directory-token-a' });
        const claimed = await first.TokenStorage.claimAccountDirectoryOAuthReturn({
            ...target,
            intent,
            invokingSurface: '/setup/wizard',
        });
        expect(claimed).not.toBeNull();

        vi.resetModules();
        const second = await import('./tokenStorage');
        await second.TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token-b' });
        let issued = false;
        await expect(claimed!.credentialCustody.issue(async () => {
            issued = true;
            return 'issued';
        })).rejects.toThrow(/superseded/i);
        expect(issued).toBe(false);
    });

    it('starts an admitted request under the shared lock and releases the lock before the network settles', async () => {
        const target = { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' };
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token' });
        const custody = captureAccountDirectoryCredentialCustody(target);
        await custody.read();

        let resolveNetwork!: (value: string) => void;
        let signalStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            signalStarted = resolve;
        });
        const network = new Promise<string>((resolve) => {
            resolveNetwork = resolve;
        });
        const issued = custody.issue(() => {
            expect(webLocks?.isHeld()).toBe(true);
            signalStarted();
            return network;
        });

        await started;
        await expect(TokenStorage.accountDirectoryAuthCredentials.set(
            target,
            { token: 'replacement-token' },
        )).resolves.toBe(true);
        expect(webLocks?.isHeld()).toBe(false);

        resolveNetwork('response');
        await expect(issued).resolves.toBe('response');
    });

    it('strictly parses ordinary typed Home credentials at enrollment boundaries', async () => {
        expect(parseAuthCredentials({ token: 'home-token' })).toEqual({ token: 'home-token' });
        expect(parseAuthCredentials({
            token: 'home-token',
            encryption: { publicKey: 'public-key', machineKey: 'machine-key' },
        })).toEqual({
            token: 'home-token',
            encryption: { publicKey: 'public-key', machineKey: 'machine-key' },
        });
        expect(parseAuthCredentials({ token: 'home-token', outcome: 'authorized' })).toBeNull();
        expect(parseAuthCredentials({ token: 'home-token', secret: 'legacy', encryption: { publicKey: 'p', machineKey: 'm' } })).toBeNull();
    });

    it('reads additive stored Home credential fields while keeping enrollment credential inputs strict', async () => {
        const target = { serverId: 'home-a' };
        const url = 'https://home-a.example.test';
        const credentials = { token: 'home-token', encryption: { publicKey: 'public-key', machineKey: 'machine-key' } };
        expect(await TokenStorage.setCredentialsForServerUrl(url, target, credentials)).toBe(true);
        if (!localStorageHandle) throw new Error('Expected storage boundary');
        const key = [...localStorageHandle.store.keys()].find((key) => key.startsWith('auth_credentials'));
        if (!key) throw new Error('Expected persisted Home credential');
        const stored = { ...credentials, futureCredentialField: true,
            encryption: { ...credentials.encryption, futureEncryptionField: true } };
        localStorageHandle.store.set(key, JSON.stringify(stored));
        expect(await TokenStorage.getCredentialsForServerUrl(url, target)).toEqual(credentials);
        expect(parseAuthCredentials(stored)).toBeNull();
    });

    it('reads additive stored Account-service credential fields without granting Home key material', async () => {
        const target = { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' };
        expect(await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token' })).toBe(true);
        if (!localStorageHandle) throw new Error('Expected storage boundary');
        const key = [...localStorageHandle.store.keys()].find((key) => key.includes(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY));
        if (!key) throw new Error('Expected persisted Account-service credential');
        const rows = JSON.parse(localStorageHandle.store.get(key)!) as Array<Record<string, unknown>>;
        rows[0] = { ...rows[0], futureRecordField: true,
            credentials: { token: 'directory-token', futureCredentialField: true } };
        localStorageHandle.store.set(key, JSON.stringify(rows));
        expect(await TokenStorage.accountDirectoryAuthCredentials.get(target)).toEqual({ token: 'directory-token' });
        rows[0] = { ...rows[0], credentials: { token: 'directory-token', secret: 'must-not-be-admitted' } };
        localStorageHandle.store.set(key, JSON.stringify(rows));
        await expect(TokenStorage.accountDirectoryAuthCredentials.get(target)).rejects.toMatchObject({
            name: 'AccountDirectoryStorageReadError', reason: 'corrupt',
        });
    });

    it('reads additive stored Home continuation fields while preserving its exact Home and credential binding', async () => {
        const homeUrl = 'https://home-a.example.test';
        const continuation = {
            endpoint: 'https://directory.example.test', canonicalServerUrl: 'https://directory.example.test',
            serverIdentityId: 'directory-a', homeServerIdentityId: 'home-a',
            entryIntent: { kind: 'enter' as const, target: { kind: 'explicit' as const, homeServerIdentityId: 'home-a' } },
            returnTo: '/', credentialTokenDigest: 'A'.repeat(43),
        };
        const pending = { provider: 'mtls', serverId: 'home-a', serverUrl: homeUrl, returnTo: '/', accountContinuation: continuation };
        expect(await TokenStorage.setPendingExternalAuth(pending, { serverUrl: homeUrl, serverId: 'home-a' })).toBe(true);
        if (!localStorageHandle) throw new Error('Expected storage boundary');
        for (const [key, raw] of localStorageHandle.store) {
            if (!key.includes('pending_external_auth')) continue;
            const row = JSON.parse(raw) as Record<string, unknown>;
            localStorageHandle.store.set(key, JSON.stringify({ ...row, futurePendingField: true,
                accountContinuation: { ...continuation, futureContinuationField: true,
                    entryIntent: { ...continuation.entryIntent, futureIntentField: true,
                        target: { ...continuation.entryIntent.target, futureTargetField: true } } } }));
        }
        const state = await TokenStorage.readPendingExternalAuthStateForServerUrl(homeUrl, { serverId: 'home-a' });
        expect(state).toEqual({ serverMismatch: false, value: pending });
    });

    it('reads additive stored Account-service pending fields while keeping strict custody inputs and exact targets', async () => {
        const now = Date.now();
        const pending = {
            endpoint: 'https://directory.example.test', canonicalServerUrl: 'https://directory.example.test',
            serverIdentityId: 'directory-a', credentialTarget: 'account_directory' as const,
            purpose: 'account_directory' as const, provider: 'github', pending: 'oauth-pending',
            createdAt: now, expiresAt: now + 60_000,
            entryIntent: { kind: 'enter' as const, target: { kind: 'explicit' as const, homeServerIdentityId: 'home-a' } },
            explicitHomeServerIdentityId: 'home-a',
        };
        expect(await TokenStorage.setPendingAccountDirectoryAuth(pending)).toBe(true);
        if (!localStorageHandle) throw new Error('Expected storage boundary');
        const key = [...localStorageHandle.store.keys()].find((key) => key.includes(PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY));
        if (!key) throw new Error('Expected persisted Account-service pending auth');
        const stored = { ...pending, futurePendingField: true,
            entryIntent: { ...pending.entryIntent, futureIntentField: true,
                target: { ...pending.entryIntent.target, futureTargetField: true } } };
        localStorageHandle.store.set(key, JSON.stringify([stored]));
        expect(await TokenStorage.getPendingAccountDirectoryAuth(pending)).toEqual(pending);
        expect(await TokenStorage.getPendingAccountDirectoryAuth({ ...pending, serverIdentityId: 'other-directory' })).toBeNull();
        expect(await TokenStorage.setPendingAccountDirectoryAuth(stored)).toBe(false);
    });

    it('rejects Account Service endpoints that contain credentials, a query, or a fragment', async () => {
        expect(normalizeAccountDirectoryEndpoint('https://user:pass@directory.example.test')).toBeNull();
        expect(normalizeAccountDirectoryEndpoint('https://directory.example.test?tenant=other')).toBeNull();
        expect(normalizeAccountDirectoryEndpoint('https://directory.example.test#other')).toBeNull();
        expect(normalizeAccountDirectoryEndpoint('https://directory.example.test/base///')).toBe(
            'https://directory.example.test/base',
        );
    });

    it('isolates Account Directory credentials by endpoint and identity', async () => {
        const directory = TokenStorage.accountDirectoryAuthCredentials;

        await expect(
            directory.set(
                { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' },
                { token: 'directory-token-a' },
            ),
        ).resolves.toBe(true);
        await expect(
            directory.set(
                { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-b' },
                { token: 'directory-token-b' },
            ),
        ).resolves.toBe(true);

        await expect(
            directory.get({ endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' }),
        ).resolves.toEqual({ token: 'directory-token-a' });
        await expect(
            directory.get({ endpoint: 'https://directory.example.test', serverIdentityId: 'directory-b' }),
        ).resolves.toEqual({ token: 'directory-token-b' });

        await expect(
            directory.remove({ endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' }),
        ).resolves.toBe(true);
        await expect(
            directory.get({ endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' }),
        ).resolves.toBeNull();
        await expect(
            directory.get({ endpoint: 'https://directory.example.test', serverIdentityId: 'directory-b' }),
        ).resolves.toEqual({ token: 'directory-token-b' });
    });

    it('tells observers when the stored Account Service sign-in changes', async () => {
        const directory = TokenStorage.accountDirectoryAuthCredentials;
        const target = { endpoint: 'https://directory.example.test', serverIdentityId: 'directory-a' };
        const observer = vi.fn();
        const unsubscribe = subscribeAccountDirectoryCredentialMutations(observer);

        await directory.set(target, { token: 'directory-token-a' });
        expect(observer).toHaveBeenCalledTimes(1);
        await directory.logout(target);
        expect(observer).toHaveBeenCalledTimes(2);

        unsubscribe();
        await directory.set(target, { token: 'directory-token-b' });
        expect(observer).toHaveBeenCalledTimes(2);
    });

    it('rejects endpoint-only operations without touching identity-bound credentials at the same URL', async () => {
        const directory = TokenStorage.accountDirectoryAuthCredentials;
        const endpoint = 'https://directory.example.test';

        await directory.set(
            { endpoint, serverIdentityId: 'directory-a' },
            { token: 'directory-token-a' },
        );
        await directory.set(
            { endpoint, serverIdentityId: 'directory-b' },
            { token: 'directory-token-b' },
        );

        // @ts-expect-error Account Service credential targets require exact identity.
        await expect(directory.get({ endpoint })).resolves.toBeNull();
        // @ts-expect-error Account Service credential targets require exact identity.
        await expect(directory.logout({ endpoint })).resolves.toBe(false);
        await expect(directory.get({ endpoint, serverIdentityId: 'directory-a' })).resolves.toEqual({
            token: 'directory-token-a',
        });
        await expect(directory.get({ endpoint, serverIdentityId: 'directory-b' })).resolves.toEqual({
            token: 'directory-token-b',
        });

        // @ts-expect-error New endpoint-only Directory credential writes are forbidden.
        await expect(directory.set({ endpoint }, { token: 'endpoint-only-token' })).resolves.toBe(false);
        await expect(directory.set(
            { endpoint, serverIdentityId: '   ' },
            { token: 'malformed-identity-token' },
        )).resolves.toBe(false);
        await expect(directory.get({ endpoint, serverIdentityId: '   ' })).resolves.toBeNull();
        await expect(directory.logout({ endpoint, serverIdentityId: '   ' })).resolves.toBe(false);
        await expect(directory.get({ endpoint, serverIdentityId: 'directory-a' })).resolves.toEqual({
            token: 'directory-token-a',
        });
        await expect(directory.get({ endpoint, serverIdentityId: 'directory-b' })).resolves.toEqual({
            token: 'directory-token-b',
        });
    });

    it('keeps Directory pending OAuth records endpoint/identity scoped and expires them strictly', async () => {
        const now = 1_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const pending = bindCanonicalServerUrl({
            endpoint: 'https://directory.example.test',
            serverIdentityId: 'directory-a',
            credentialTarget: 'account_directory' as const,
            provider: 'github',
            purpose: 'account_directory' as const,
            pending: 'oauth-pending-a',
            createdAt: now - 100,
            expiresAt: now + 10_000,
            returnTo: '/settings/account',
        });

        await expect(TokenStorage.setPendingAccountDirectoryAuth(pending)).resolves.toBe(true);
        await expect(
            TokenStorage.getPendingAccountDirectoryAuth({ endpoint: pending.endpoint, serverIdentityId: pending.serverIdentityId }),
        ).resolves.toEqual(pending);
        await expect(
            TokenStorage.getPendingAccountDirectoryAuth({ endpoint: pending.endpoint, serverIdentityId: 'directory-other' }),
        ).resolves.toBeNull();

        vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
        await expect(
            TokenStorage.getPendingAccountDirectoryAuth({ endpoint: pending.endpoint, serverIdentityId: pending.serverIdentityId }),
        ).resolves.toBeNull();
        await expect(
            TokenStorage.getPendingAccountDirectoryAuth(
                { endpoint: pending.endpoint, serverIdentityId: pending.serverIdentityId },
                { includeExpired: true },
            ),
        ).resolves.toEqual(pending);
    });

    it('resolves callback custody by provider and fails closed when more than one target matches', async () => {
        const now = 1_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const first = bindCanonicalServerUrl({
            endpoint: 'https://directory-a.example.test',
            serverIdentityId: 'directory-a',
            credentialTarget: 'account_directory' as const,
            provider: 'github',
            purpose: 'account_directory' as const,
            pending: 'oauth-pending-a',
            createdAt: now - 100,
            expiresAt: now + 10_000,
        });
        await TokenStorage.setPendingAccountDirectoryAuth(first);
        await expect(TokenStorage.resolvePendingAccountDirectoryAuthCustody('github')).resolves.toEqual({
            kind: 'matched',
            pending: first,
        });

        await TokenStorage.setPendingAccountDirectoryAuth(bindCanonicalServerUrl({
            ...first,
            endpoint: 'https://directory-b.example.test',
            serverIdentityId: 'directory-b',
            pending: 'oauth-pending-b',
            createdAt: now,
        }));
        await expect(TokenStorage.resolvePendingAccountDirectoryAuthCustody('github')).resolves.toEqual({
            kind: 'ambiguous',
        });
        await expect(TokenStorage.resolvePendingAccountDirectoryAuthCustody('google')).resolves.toEqual({
            kind: 'absent',
        });
    });

    it('persists only the canonical pre-redirect Directory target fields without inventing a server pending handle', async () => {
        const now = 1_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const continuation = bindCanonicalServerUrl({
            endpoint: 'https://directory.example.test',
            serverIdentityId: 'directory-a',
            credentialTarget: 'account_directory' as const,
            provider: 'github',
            purpose: 'account_directory' as const,
            createdAt: now,
            expiresAt: now + 10_000,
            mode: 'keyless' as const,
            proof: 'proof-bound-before-redirect',
        });

        await expect(TokenStorage.setPendingAccountDirectoryAuth(continuation)).resolves.toBe(true);
        await expect(TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: continuation.endpoint,
            serverIdentityId: continuation.serverIdentityId,
        })).resolves.toEqual(expect.objectContaining({
            endpoint: continuation.endpoint,
            serverIdentityId: continuation.serverIdentityId,
            provider: 'github',
            purpose: 'account_directory',
            proof: 'proof-bound-before-redirect',
        }));
        const stored = await TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: continuation.endpoint,
            serverIdentityId: continuation.serverIdentityId,
        });
        expect(stored).not.toHaveProperty('endpointUrl');
        expect(stored).not.toHaveProperty('endpointServerIdentityId');
        expect(stored).not.toHaveProperty('pending');

        const setUntrustedPending = TokenStorage.setPendingAccountDirectoryAuth as (
            value: unknown,
        ) => Promise<boolean>;
        await expect(setUntrustedPending({
            ...continuation,
            endpointUrl: continuation.endpoint,
        })).resolves.toBe(false);
        await expect(setUntrustedPending({
            ...continuation,
            endpointServerIdentityId: continuation.serverIdentityId,
        })).resolves.toBe(false);
        await expect(setUntrustedPending({
            ...continuation,
            secret: 'unused-keyless-secret',
        })).resolves.toBe(false);
    });

    const keyedContinuation = bindCanonicalServerUrl({
        endpoint: 'https://directory.example.test',
        serverIdentityId: 'directory-a',
        credentialTarget: 'account_directory' as const,
        provider: 'github',
        purpose: 'account_directory' as const,
        createdAt: PENDING_NOW,
        expiresAt: PENDING_NOW + 10_000,
        mode: 'keyed' as const,
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const refreshContinuation = {
        endpoint: 'https://directory.example.test',
        serverIdentityId: 'directory-a',
        canonicalServerUrl: 'https://directory.example.test',
        credentialTarget: 'account_directory' as const,
        entryIntent: { kind: 'refresh' as const },
        provider: 'github',
        purpose: 'account_directory' as const,
        createdAt: PENDING_NOW,
        expiresAt: PENDING_NOW + 10_000,
        mode: 'keyless' as const,
        proof: 'proof-bound-before-redirect',
        returnTo: '/setup/wizard',
    };
    it.each([
        ['canonical keyed', keyedContinuation],
        ['strict account-only refresh (no Home identity marker)', refreshContinuation],
    ])('round-trips the %s pre-redirect continuation through the real storage owner', async (_variant, continuation) => {
        vi.spyOn(Date, 'now').mockReturnValue(PENDING_NOW);

        await expect(TokenStorage.setPendingAccountDirectoryAuth(continuation)).resolves.toBe(true);
        await expect(TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: continuation.endpoint,
            serverIdentityId: continuation.serverIdentityId,
        })).resolves.toEqual(continuation);
    });

    it('persists a captured Home identity intent on the Directory continuation and stays strict about credentials/descriptors', async () => {
        const now = 1_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const base = bindCanonicalServerUrl({
            endpoint: 'https://directory.example.test',
            serverIdentityId: 'directory-a',
            credentialTarget: 'account_directory' as const,
            entryIntent: { kind: 'enter' as const, target: { kind: 'automatic' as const } },
            provider: 'github',
            purpose: 'account_directory' as const,
            createdAt: now,
            expiresAt: now + 10_000,
            mode: 'keyless' as const,
            proof: 'proof-bound-before-redirect',
        });

        await expect(TokenStorage.setPendingAccountDirectoryAuth({
            ...base,
            entryIntent: { kind: 'link', homeServerIdentityId: 'srv_home_a' },
            linkHomeServerIdentityId: 'srv_home_a',
        })).resolves.toBe(true);
        const stored = await TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: base.endpoint,
            serverIdentityId: base.serverIdentityId,
        });
        expect(stored).toEqual(expect.objectContaining({
            endpoint: base.endpoint,
            serverIdentityId: base.serverIdentityId,
            entryIntent: { kind: 'link', homeServerIdentityId: 'srv_home_a' },
            linkHomeServerIdentityId: 'srv_home_a',
        }));
        // The continuation carries only the stable identity intent — never Home credential
        // or descriptor material.
        expect(stored).not.toHaveProperty('connectionDescriptor');
        expect(stored).not.toHaveProperty('credentials');
        expect(stored).not.toHaveProperty('secret');

        // The strict allowed-key validator stays strict: Home credential or descriptor
        // material is rejected rather than silently stored beside the identity intent.
        const extra = { connectionDescriptor: { v: 1 } };
        await expect(TokenStorage.setPendingAccountDirectoryAuth({
            ...base,
            entryIntent: { kind: 'link', homeServerIdentityId: 'srv_home_a' },
            linkHomeServerIdentityId: 'srv_home_a',
            ...extra,
        })).resolves.toBe(false);
    });

    it.each([undefined, 'open_home', '', true])(
        'rejects a Directory continuation whose semantic entry intent is %j',
        async (entryIntent) => {
                const now = 1_000_000;
            vi.spyOn(Date, 'now').mockReturnValue(now);
            const setUntrustedPending = TokenStorage.setPendingAccountDirectoryAuth as (
                value: unknown,
            ) => Promise<boolean>;

            await expect(setUntrustedPending({
                endpoint: 'https://directory.example.test',
                serverIdentityId: 'directory-a',
                canonicalServerUrl: 'https://directory.example.test',
                credentialTarget: 'account_directory',
                entryIntent,
                provider: 'github',
                purpose: 'account_directory',
                createdAt: now,
                expiresAt: now + 10_000,
                mode: 'keyless',
                proof: 'proof-bound-before-redirect',
            })).resolves.toBe(false);
        },
    );

    it.each([
        ['the explicit target marker', 'credentialTarget'],
        ['a canonical server URL', 'canonicalServerUrl'],
    ] as const)('rejects Directory pending records without %s and persists nothing', async (_missing, field) => {
        vi.spyOn(Date, 'now').mockReturnValue(PENDING_NOW);
        const complete = bindCanonicalServerUrl({
            endpoint: 'https://directory.example.test',
            serverIdentityId: 'directory-a',
            credentialTarget: 'account_directory' as const,
            provider: 'github',
            purpose: 'account_directory' as const,
            pending: 'oauth-pending-a',
            createdAt: PENDING_NOW - 100,
            expiresAt: PENDING_NOW + 10_000,
        });
        const { [field]: _omitted, ...incomplete } = complete;
        const target = { endpoint: complete.endpoint, serverIdentityId: complete.serverIdentityId };

        const setUntrustedPending = TokenStorage.setPendingAccountDirectoryAuth as (
            value: unknown,
        ) => Promise<boolean>;
        await expect(setUntrustedPending(incomplete)).resolves.toBe(false);
        await expect(TokenStorage.getPendingAccountDirectoryAuth(target)).resolves.toBeNull();
        // Positive control: the same record with the field present is accepted.
        await expect(TokenStorage.setPendingAccountDirectoryAuth(complete)).resolves.toBe(true);
        await expect(TokenStorage.getPendingAccountDirectoryAuth(target)).resolves.toEqual(complete);
    });

    it('continues to parse the legacy Home pending shape without a target discriminator', async () => {
        // Bytes an older client left at the web pending-auth key: no target discriminator, purpose or server context.
        const legacyRaw = JSON.stringify({ provider: 'github', proof: 'home-proof' });
        if (!localStorageHandle) throw new Error('Expected storage boundary');
        localStorageHandle.store.set('pending_external_auth__global', legacyRaw);

        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({
            value: { provider: 'github', proof: 'home-proof' },
            serverMismatch: true,
        });
        expect(localStorageHandle.store.get('pending_external_auth__global')).toBe(legacyRaw);
    });

    it('logs out the Directory namespace without removing Home credentials or pending state', async () => {
        const directory = TokenStorage.accountDirectoryAuthCredentials;
        const endpoint = 'https://directory.example.test';
        const pending = bindCanonicalServerUrl({
            credentialTarget: 'account_directory' as const,
            endpoint,
            serverIdentityId: 'directory-a',
            provider: 'github',
            purpose: 'account_directory' as const,
            pending: 'oauth-pending-a',
            createdAt: Date.now() - 100,
            expiresAt: Date.now() + 10_000,
        });

        await TokenStorage.setCredentialsForServerUrl(
            'https://home.example.test',
            {},
            { token: 'home-token', secret: 'home-secret' },
        );
        await TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'home-proof' });
        await directory.set({ endpoint, serverIdentityId: 'directory-a' }, { token: 'directory-token' });
        await TokenStorage.setPendingAccountDirectoryAuth(pending);

        await expect(directory.logout({ endpoint, serverIdentityId: 'directory-a' })).resolves.toBe(true);
        await expect(directory.get({ endpoint, serverIdentityId: 'directory-a' })).resolves.toBeNull();
        await expect(TokenStorage.getPendingAccountDirectoryAuth({ endpoint, serverIdentityId: 'directory-a' })).resolves.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl('https://home.example.test')).resolves.toEqual({
            token: 'home-token',
            secret: 'home-secret',
        });
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({
            value: { provider: 'github', proof: 'home-proof' },
            serverMismatch: true,
        });
    });

    it('removes every Home credential without clearing dedicated Account Service state', async () => {
        const directory = TokenStorage.accountDirectoryAuthCredentials;
        const homeA = await upsertServerProfile({
            serverUrl: 'https://home-a.example.test',
            name: 'Home A',
            source: 'manual',
        });
        const homeB = await upsertServerProfile({
            serverUrl: 'https://home-b.example.test',
            name: 'Home B',
            source: 'manual',
        });
        const pending = bindCanonicalServerUrl({
            endpoint: 'https://directory.example.test',
            serverIdentityId: 'directory-a',
            credentialTarget: 'account_directory' as const,
            provider: 'github',
            purpose: 'account_directory' as const,
            pending: 'oauth-pending-a',
            createdAt: Date.now() - 100,
            expiresAt: Date.now() + 10_000,
        });

        await TokenStorage.setCredentialsForServerUrl(
            homeA.serverUrl,
            { serverId: homeA.id },
            { token: 'home-token-a' },
        );
        await TokenStorage.setCredentialsForServerUrl(
            homeB.serverUrl,
            { serverId: homeB.id },
            { token: 'home-token-b' },
        );
        await directory.set(
            { endpoint: pending.endpoint, serverIdentityId: pending.serverIdentityId },
            { token: 'directory-token' },
        );
        await TokenStorage.setPendingAccountDirectoryAuth(pending);

        await expect(TokenStorage.removeCredentials()).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(
            homeA.serverUrl,
            { serverId: homeA.id },
        )).resolves.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl(
            homeB.serverUrl,
            { serverId: homeB.id },
        )).resolves.toBeNull();
        await expect(directory.get({
            endpoint: pending.endpoint,
            serverIdentityId: pending.serverIdentityId,
        })).resolves.toEqual({ token: 'directory-token' });
        await expect(TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: pending.endpoint,
            serverIdentityId: pending.serverIdentityId,
        })).resolves.toEqual(pending);
    });
});
