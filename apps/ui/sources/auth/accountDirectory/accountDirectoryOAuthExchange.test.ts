import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY,
    PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY,
    TokenStorage,
} from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { IrohError } from '@happier-dev/iroh-native';
installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn<(endpoint: string, path: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return boundary.request(url.origin, `${url.pathname}${url.search}`, init);
    },
}));
import { accountDirectoryAuthClient, acquireAccountServiceAuthTransport } from './accountDirectoryAuthClient';

describe('Account Directory OAuth exchange custody', () => {
    let restore: () => void;
    let restoreLocks: () => void;
    let storage: LocalStorageMockHandle;
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    beforeEach(() => {
        storage = installLocalStorageMock();
        restore = storage.restore;
        restoreLocks = installWebLockManagerMock().restore;
        fixture = createDirectoryHttpFixture();
        boundary.request.mockReset();
        boundary.request.mockImplementation(fixture.request);
    });
    afterEach(() => { vi.unstubAllGlobals(); restoreLocks(); restore(); });
    it('stops after native self transport rejects the exact descriptor instead of offering retry', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => { throw new IrohError('invalid_descriptor', 'Rejected descriptor'); } });
        await adoptHomeProfile({
            descriptor: { v: 1, homeServerIdentityId: fixture.service.serverIdentityId,
                canonicalServerUrl: fixture.service.canonicalServerUrl, revision: 1,
                endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
            source: 'account-directory', descriptorAuthority: 'current_connection_observation',
        });
        await expect(acquireAccountServiceAuthTransport(fixture.service))
            .rejects.toMatchObject({ canTryAgain: false, code: 'iroh_transport_failed_closed' });
        expect(boundary.request).not.toHaveBeenCalled();
    });
    it('uses the invoking self transport for OAuth initiation without persisting its runtime origin', async () => {
        boundary.request.mockImplementation(async () => new Response(JSON.stringify({
            url: 'https://github.com/login/oauth/authorize', purpose: 'account_directory', credentialTarget: 'account_directory',
            endpointUrl: fixture.service.endpointUrl, endpointServerIdentityId: fixture.service.serverIdentityId,
            canonicalServerUrl: fixture.service.canonicalServerUrl, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }), { headers: { 'Content-Type': 'application/json' } }));
        const input = { endpointUrl: fixture.service.endpointUrl, endpointServerIdentityId: fixture.service.serverIdentityId,
            canonicalServerUrl: fixture.service.canonicalServerUrl, providerId: 'github', mode: 'keyless' as const,
            entryIntent: { kind: 'enter' as const, target: { kind: 'automatic' as const } }, returnTo: '/setup/wizard',
            transport: { runtimeOrigin: 'http://127.0.0.1:43210' },
        };
        const started = await accountDirectoryAuthClient.startOAuth(input);
        expect(boundary.request.mock.calls.map(([endpoint]) => endpoint)).toEqual([input.transport.runtimeOrigin]);
        const stored = await TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: input.endpointUrl,
            serverIdentityId: input.endpointServerIdentityId,
        });
        expect(stored).toEqual(started.pending);
        expect(JSON.stringify(stored)).not.toContain('127.0.0.1');
    });
    it('cannot replay cleared custody from an old callback record', async () => {
        const pending = {
            endpoint: 'https://directory.test', serverIdentityId: 'srv_directory', canonicalServerUrl: 'https://directory.test',
            provider: 'github', purpose: 'account_directory' as const, credentialTarget: 'account_directory' as const,
            entryIntent: { kind: 'enter' as const, target: { kind: 'automatic' as const } },
            mode: 'keyless' as const, proof: 'proof', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
            returnTo: '/setup/wizard', accountEntryReturnTo: '/settings/account',
        };
        const result = await accountDirectoryAuthClient.exchangeOAuth({
            providerId: 'github', purpose: 'account_directory', credentialTarget: 'account_directory',
            endpointUrl: pending.endpoint, serverIdentityId: pending.serverIdentityId, canonicalServerUrl: pending.canonicalServerUrl,
            pendingKey: 'callback-handle', mode: 'keyless', pending,
        });
        expect(result).toMatchObject({ kind: 'failed', code: 'invalid-pending', retryable: false });
        expect(boundary.request).not.toHaveBeenCalled();
    });

    async function storedInput() {
        const record = {
            endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId,
            canonicalServerUrl: fixture.service.canonicalServerUrl,
            provider: 'github', purpose: 'account_directory' as const, credentialTarget: 'account_directory' as const,
            entryIntent: { kind: 'enter' as const, target: { kind: 'explicit' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } },
            mode: 'keyless' as const, proof: 'bound-proof', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
            returnTo: '/setup/wizard',
        };
        expect(await TokenStorage.setPendingAccountDirectoryAuth(record)).toBe(true);
        return {
            providerId: 'github', purpose: 'account_directory', credentialTarget: 'account_directory',
            endpointUrl: record.endpoint, serverIdentityId: record.serverIdentityId, canonicalServerUrl: record.canonicalServerUrl,
            pendingKey: 'server-pending', mode: 'keyless', pending: await TokenStorage.getPendingAccountDirectoryAuth(record),
        };
    }

    it('does not offer a retry for an invalid request TypeError', async () => {
        const input = await storedInput();
        boundary.request.mockRejectedValueOnce(new TypeError('Invalid URL'));
        const result = await accountDirectoryAuthClient.exchangeOAuth(input);
        expect(result).toMatchObject({ kind: 'failed', retryable: false });
    });

    it('commits only restricted credentials and returns to the recorded surface without Directory or Home work', async () => {
        const input = await storedInput();
        const result = await accountDirectoryAuthClient.exchangeOAuth(input);
        expect(result).toMatchObject({ kind: 'authenticated', destination: { pathname: '/setup/wizard', params: { mode: 'account-entry', accountServiceReturn: '1' } } });
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })).toEqual({ token: 'directory-token' });
        expect(await TokenStorage.getPendingAccountDirectoryAuth({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })).toBeNull();
        expect(fixture.state.calls.map(({ path }) => path)).toEqual(['/v1/features', '/v1/auth/external/github/finalize-keyless']);
        expect(JSON.stringify(result)).not.toContain('bound-proof');
        expect(await accountDirectoryAuthClient.exchangeOAuth(input)).toMatchObject({ kind: 'failed', code: 'invalid-pending' });
    });

    it('announces credential commit after the final cancellation check and before persistence', async () => {
        const input = await storedInput();
        const controller = new AbortController();
        const persistCredential = vi.spyOn(TokenStorage.accountDirectoryAuthCredentials, 'set');
        const onCredentialCommitStarted = vi.fn(() => {
            expect(controller.signal.aborted).toBe(false);
            expect(persistCredential).not.toHaveBeenCalled();
        });

        await expect(accountDirectoryAuthClient.exchangeOAuth({
            ...input,
            signal: controller.signal,
            onCredentialCommitStarted,
        })).resolves.toMatchObject({ kind: 'authenticated' });
        expect(onCredentialCommitStarted).toHaveBeenCalledOnce();
    });

    it('retains the recorded continuation when cancellation arrives after credential commit starts', async () => {
        const input = await storedInput();
        const controller = new AbortController();
        const result = await accountDirectoryAuthClient.exchangeOAuth({
            ...input,
            signal: controller.signal,
            onCredentialCommitStarted: () => controller.abort('late route teardown'),
        });

        expect(result).toEqual({ kind: 'cancelled', accountCredentialCommitted: true });
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        })).toEqual({ token: 'directory-token' });
        expect(TokenStorage.readAccountDirectoryOAuthReturn({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
            intent: input.pending!.entryIntent,
            invokingSurface: '/setup/wizard',
        })).toMatchObject({ entryIntent: input.pending!.entryIntent });
    });

    it('does not let a redeemed callback overwrite credentials after a newer OAuth start replaces custody', async () => {
        const input = await storedInput();
        if (!input.pending) throw new Error('Missing custody');
        const replacement = { ...input.pending, pending: 'replacement-provider-pending' };
        let replacementWrite: Promise<boolean> | null = null;

        expect(await accountDirectoryAuthClient.exchangeOAuth({
            ...input,
            onCredentialCommitStarted: () => {
                replacementWrite = TokenStorage.setPendingAccountDirectoryAuth(replacement);
            },
        })).toMatchObject({
            kind: 'failed',
            code: 'invalid-pending',
            accountCredentialCommitted: false,
        });
        await expect(replacementWrite).resolves.toBe(true);
        expect(await TokenStorage.getPendingAccountDirectoryAuth(replacement)).toEqual(replacement);
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        })).toBeNull();
        expect(TokenStorage.readAccountDirectoryOAuthReturn({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
            intent: input.pending.entryIntent,
            invokingSurface: '/setup/wizard',
        })).toBeNull();
    });

    it('does not let stale callback cleanup remove newer pending custody for the same service', async () => {
        const input = await storedInput();
        if (!input.pending) throw new Error('Missing custody');
        const replacement = { ...input.pending, pending: 'replacement-provider-pending' };
        const target = {
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        };
        expect(await TokenStorage.setPendingAccountDirectoryAuth(replacement)).toBe(true);

        expect(await TokenStorage.clearPendingAccountDirectoryAuth(target, {
            expected: input.pending,
        })).toBe(true);
        expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toEqual(replacement);
    });

    it('restores the prior credential and retains exact pending custody when pending removal fails', async () => {
        const input = await storedInput();
        if (!input.pending) throw new Error('Missing custody');
        const target = {
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        };
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'previous-directory-token' });
        storage.removeItemMock.mockImplementation((key) => {
            if (key.includes(PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY)) {
                throw new Error('pending storage unavailable');
            }
            storage.store.delete(key);
        });

        await expect(accountDirectoryAuthClient.exchangeOAuth(input)).resolves.toMatchObject({
            kind: 'failed',
            code: 'credential-storage-failed',
            accountCredentialCommitted: false,
        });
        await expect(TokenStorage.accountDirectoryAuthCredentials.get(target)).resolves.toEqual({
            token: 'previous-directory-token',
        });
        await expect(TokenStorage.getPendingAccountDirectoryAuth(target)).resolves.toEqual(input.pending);
        expect(TokenStorage.readAccountDirectoryOAuthReturn({
            ...target,
            intent: input.pending.entryIntent,
            invokingSurface: '/setup/wizard',
        })).toBeNull();
    });

    it('reports a committed partial result when pending removal and credential rollback both fail', async () => {
        const input = await storedInput();
        if (!input.pending) throw new Error('Missing custody');
        const target = {
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        };
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'previous-directory-token' });
        let credentialWrites = 0;
        storage.setItemMock.mockImplementation((key, value) => {
            if (key.includes(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY)) {
                credentialWrites += 1;
                if (credentialWrites === 2) throw new Error('credential rollback unavailable');
            }
            storage.store.set(key, value);
        });
        storage.removeItemMock.mockImplementation((key) => {
            if (key.includes(PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY)) {
                throw new Error('pending storage unavailable');
            }
            storage.store.delete(key);
        });

        await expect(accountDirectoryAuthClient.exchangeOAuth(input)).resolves.toMatchObject({
            kind: 'failed',
            code: 'credential-storage-failed',
            accountCredentialCommitted: true,
        });
        await expect(TokenStorage.accountDirectoryAuthCredentials.get(target)).resolves.toEqual({
            token: 'directory-token',
        });
        await expect(TokenStorage.getPendingAccountDirectoryAuth(target)).resolves.toEqual(input.pending);
        expect(TokenStorage.readAccountDirectoryOAuthReturn({
            ...target,
            intent: input.pending.entryIntent,
            invokingSurface: '/setup/wizard',
        })).toBeNull();
    });

    it('returns only the original sanitized account-entry exit destination from custody', async () => {
        const input = await storedInput();
        if (!input.pending) throw new Error('Missing custody');
        await TokenStorage.setPendingAccountDirectoryAuth({ ...input.pending, accountEntryReturnTo: '/settings/account' });
        const pending = await TokenStorage.getPendingAccountDirectoryAuth(input.pending);
        const result = await accountDirectoryAuthClient.exchangeOAuth({ ...input, pending });
        expect(result).toMatchObject({ kind: 'authenticated', destination: { params: { accountEntryReturnTo: '/settings/account' } } });
        expect(await TokenStorage.setPendingAccountDirectoryAuth({ ...input.pending, accountEntryReturnTo: 'https://attacker.test' })).toBe(false);
    });

    it('releases recorded return custody once, only to its invoking surface', async () => {
        const input = await storedInput();
        const exchanged = await accountDirectoryAuthClient.exchangeOAuth(input);
        if (exchanged.kind !== 'authenticated') throw new Error('Exchange failed');
        const { consumeAccountServiceOAuthReturn } = await import('@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn');
        const options = { invokingSurface: '/setup/wizard', signal: new AbortController().signal };
        expect(await consumeAccountServiceOAuthReturn(exchanged.destination.params, { ...options, invokingSurface: '/settings/account' })).toEqual({ kind: 'invalid' });
        const consumed = await consumeAccountServiceOAuthReturn(exchanged.destination.params, options);
        expect(consumed).toMatchObject({ kind: 'consumed', input: { intent: input.pending!.entryIntent }, result: { kind: 'approval_required' } });
        const calls = fixture.state.calls.length;
        expect(await consumeAccountServiceOAuthReturn(exchanged.destination.params, options)).toEqual({ kind: 'invalid' });
        expect(fixture.state.calls).toHaveLength(calls);
    });

    it('retries return discovery without repeating authentication or losing invoking custody', async () => {
        const input = await storedInput();
        const exchanged = await accountDirectoryAuthClient.exchangeOAuth(input);
        if (exchanged.kind !== 'authenticated') throw new Error('Exchange failed');
        const { consumeAccountServiceOAuthReturn } = await import('@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn');
        const options = { invokingSurface: '/setup/wizard', signal: new AbortController().signal };
        boundary.request.mockImplementationOnce(async () => { throw new TypeError('Network request failed'); });
        expect(await consumeAccountServiceOAuthReturn(exchanged.destination.params, options)).toEqual({ kind: 'retryable' });
        expect(await consumeAccountServiceOAuthReturn(exchanged.destination.params, options)).toMatchObject({ kind: 'consumed', result: { kind: 'approval_required' } });
        expect(fixture.state.calls.filter(({ path }) => path.includes('/finalize'))).toHaveLength(1);
        expect(await consumeAccountServiceOAuthReturn(exchanged.destination.params, options)).toEqual({ kind: 'invalid' });
    });

    it.each([403, 429, 503])('preserves discovery HTTP %s instead of treating every response failure as retryable', async (status) => {
        const input = await storedInput();
        const exchanged = await accountDirectoryAuthClient.exchangeOAuth(input);
        if (exchanged.kind !== 'authenticated') throw new Error('Exchange failed');
        boundary.request.mockImplementationOnce(async () => new Response('{}', { status }));
        const { consumeAccountServiceOAuthReturn } = await import('@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn');
        const result = await consumeAccountServiceOAuthReturn(exchanged.destination.params, { invokingSurface: '/setup/wizard', signal: new AbortController().signal });
        expect(result).toEqual({ kind: status === 403 ? 'invalid' : 'retryable' });
    });

    it('transfers keyed OAuth material into the exact session without exposing it in return navigation', async () => {
        const input = await storedInput();
        const secret = new Uint8Array(32).fill(23);
        const record = { ...input.pending!, mode: 'keyed' as const, proof: undefined, secret: encodeBase64(secret, 'base64url') };
        expect(await TokenStorage.setPendingAccountDirectoryAuth(record)).toBe(true);
        const exchanged = await accountDirectoryAuthClient.exchangeOAuth({ ...input, mode: 'keyed', pending: await TokenStorage.getPendingAccountDirectoryAuth(record) });
        if (exchanged.kind !== 'authenticated') throw new Error('Exchange failed');
        expect(JSON.stringify(exchanged)).not.toContain(record.secret);
        const { consumeAccountServiceOAuthReturn } = await import('@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn');
        const consumed = await consumeAccountServiceOAuthReturn(exchanged.destination.params, { invokingSurface: '/setup/wizard', signal: new AbortController().signal });
        if (consumed.kind !== 'consumed') throw new Error('Return failed');
        expect(consumed.input.session.takeKeyAuthSecret()).toEqual(secret);
        expect(consumed.input.session.takeKeyAuthSecret()).toBeNull();
    });

    it('does not resume recorded intent against a subsequently replaced Account credential', async () => {
        const input = await storedInput();
        const exchanged = await accountDirectoryAuthClient.exchangeOAuth(input);
        if (exchanged.kind !== 'authenticated') throw new Error('Exchange failed');
        await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { token: 'another-account' });
        const calls = fixture.state.calls.length;
        const { consumeAccountServiceOAuthReturn } = await import('@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn');
        expect(await consumeAccountServiceOAuthReturn(exchanged.destination.params, { invokingSurface: '/setup/wizard', signal: new AbortController().signal })).toEqual({ kind: 'invalid' });
        expect(fixture.state.calls).toHaveLength(calls);
    });

    it('preserves exact relink-conflict provenance instead of offering a transient retry', async () => {
        const input = await storedInput();
        fixture.state.exchangeStatus = 409;
        expect(await accountDirectoryAuthClient.exchangeOAuth(input)).toMatchObject({ kind: 'relink_required', error: { status: 409, code: 'invalid_request' } });
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })).toBeNull();
    });

    it('rejects callback endpoint and mode tampering before any exchange', async () => {
        const input = await storedInput();
        expect(await accountDirectoryAuthClient.exchangeOAuth({ ...input, endpointUrl: 'https://other.test' })).toMatchObject({ kind: 'failed', code: 'invalid-pending' });
        expect(await accountDirectoryAuthClient.exchangeOAuth({ ...input, mode: 'keyed' })).toMatchObject({ kind: 'failed', code: 'invalid-pending' });
        expect(boundary.request).not.toHaveBeenCalled();
    });
});
