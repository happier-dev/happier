import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';

installApprovalCommonModuleMocks();
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
import { signOutEverywhere } from './signOutEverywhere';

const path = '/v1/auth/sessions/sign-out-everywhere';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => { await connection?.dispose(); connection = null; });

async function loadClient(params?: Readonly<{ retireBeforeRequest?: boolean; retireDuringRequest?: boolean }>) {
    const requests: Readonly<{ path: string; init?: RequestInit }>[] = [];
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://account-signout.test', accountId: 'account-a',
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
        request: async (url, init) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname !== path) return null;
            requests.push({ path: pathname, init });
            if (params?.retireDuringRequest) retire();
            return Response.json({ status: 'signed_out' });
        },
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(connection.serverId);
    storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
    function retire() { storage.getState().clearProfileScope(); }
    if (params?.retireBeforeRequest) retire();
    return { requests };
}

describe('signOutEverywhere', () => {
    it('uses the real captured Account authority without accepting an Account target', async () => {
        const client = await loadClient();
        await expect(signOutEverywhere({})).resolves.toEqual({ status: 'signed_out' });
        expect(client.requests).toHaveLength(1);
        const request = client.requests[0]!;
        expect(request.path).toBe(path);
        expect(JSON.parse(String(request.init?.body))).toEqual({});
        expect(new Headers(request.init?.headers).get('Content-Type')).toBe('application/json');
    });

    it('does not issue a request after the captured Account scope retires', async () => {
        const client = await loadClient({ retireBeforeRequest: true });
        await expect(signOutEverywhere({})).rejects.toThrow('account_sessions_sign_out_unavailable');
        expect(client.requests).toHaveLength(0);
    });

    it('aborts and drops a response after an Account switch', async () => {
        const client = await loadClient({ retireDuringRequest: true });
        await expect(signOutEverywhere({})).rejects.toThrow('account_sessions_sign_out_unavailable');
        expect(client.requests).toHaveLength(1);
        expect(client.requests[0]?.init?.signal?.aborted).toBe(true);
    });

    it('does not start a request after host cancellation', async () => {
        const client = await loadClient();
        const controller = new AbortController(); controller.abort();
        await expect(signOutEverywhere({}, { signal: controller.signal })).rejects.toThrow('account_sessions_sign_out_unavailable');
        expect(client.requests).toHaveLength(0);
    });
});
