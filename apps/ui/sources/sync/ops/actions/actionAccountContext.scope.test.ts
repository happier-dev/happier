import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { captureLazyActionAccountContext } from './actionAccountContext';

// Credential storage, HTTP and native styling are the substituted system boundaries.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetch(...args),
    runtimeFetchManualResponse: (...args: unknown[]) => runtimeFetch(...args),
}));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const json = (value: unknown) => new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
});
afterEach(() => { runtimeFetch.mockReset(); vi.restoreAllMocks(); });

describe('captured Account admission', () => {
    it('refuses capture for a different expected Account instead of acquiring the later Account', async () => {
        const home = await upsertServerProfileOnly({ serverUrl: 'https://expected-account-capture.test' });
        const token = (accountId: string) => `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: accountId })), 'base64url')}.signature`;
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: token('account-a') });
        runtimeFetch.mockImplementation(async () => json({ features: {}, capabilities: {} }));
        const first = await captureLazyActionAccountContext(home.id);
        const expectedScope = first.accountLifetime.scope;
        first.dispose();
        credentials.mockResolvedValue({ token: token('account-b') });

        await expect(captureLazyActionAccountContext(home.id, undefined, undefined, expectedScope))
            .rejects.toMatchObject({ code: 'action_account_scope_changed' });
        await expect(captureLazyActionAccountContext(home.id, undefined, undefined, null))
            .rejects.toMatchObject({ code: 'action_account_scope_changed' });
        const current = await captureLazyActionAccountContext(home.id);
        try {
            expect(current.accountId).toBe('account-b');
            const matching = await captureLazyActionAccountContext(home.id, undefined, undefined, current.accountLifetime.scope);
            try { expect(matching.accountId).toBe('account-b'); } finally { matching.dispose(); }
        } finally { current.dispose(); }
    });
});
