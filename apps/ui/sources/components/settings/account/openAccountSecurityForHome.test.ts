import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

installApprovalCommonModuleMocks();
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();

import { openAccountSecurityForHome } from './openAccountSecurityForHome';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
    connection = await restoreServerAccountForTest({ serverUrl: 'https://account-security.test', accountId: 'account-a',
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) } });
});
afterEach(async () => { await connection?.dispose(); connection = null; });

it('refreshes the authenticated Account before opening Security when the exact Home is already active', async () => {
    const serverId = connection!.serverId;
    const replace = vi.fn();
    const refreshAuth = vi.fn(async () => {
        expect(getActiveServerSnapshot().serverId).toBe(serverId);
        expect(replace).not.toHaveBeenCalled();
    });

    await expect(openAccountSecurityForHome({ serverId, router: { replace }, refreshAuth,
        intent: 'email_password_connect', verificationToken: 'verify-home-a' })).resolves.toBe(true);

    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith({ pathname: '/settings/account/security', params: {
        serverId, intent: 'email_password_connect', verificationToken: 'verify-home-a',
    } });
});

it('keeps the current Home and does not navigate when the requested Home is unknown', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const refreshAuth = vi.fn(async () => {});
    const replace = vi.fn();
    await expect(openAccountSecurityForHome({ serverId: 'unknown-home', router: { replace }, refreshAuth })).resolves.toBe(false);
    expect(refreshAuth).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(getActiveServerSnapshot().serverId).toBe(serverId);
});
