import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

installApprovalCommonModuleMocks();
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const runnerCustody = vi.hoisted(() => ({
  removeAccount: vi.fn(async () => undefined),
}));
vi.mock('@/sync/domains/ephemeralRunner/runnerCreatorDraftRemoval', () => ({
  removeRunnerCreatorCustodyForAccount: runnerCustody.removeAccount,
}));

import { AccountDeletedLocalCleanupError, completeAccountDeletion } from './accountDeletionLifecycle';
describe('completeAccountDeletion', () => {
  let target: ServerAccountScopeLifetime;
  let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
  beforeEach(async () => {
    runnerCustody.removeAccount.mockReset().mockResolvedValue(undefined);
    connection = await restoreServerAccountForTest({ serverUrl: 'https://account-cleanup.test', accountId: 'account-a',
      credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().activateProfileScope({ serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: 'account-a' });
    const captured = captureActiveServerAccountScopeLifetime();
    if (!captured) throw new Error('Expected real Account cleanup lifetime');
    target = captured;
  });
  afterEach(async () => { await connection?.dispose(); connection = null; });
  it('deletes remotely, erases exact Runner custody, then removes local credentials', async () => {
    const remote = vi.fn(async () => ({ status: 'deleted' as const }));
    const local = vi.fn();
    await completeAccountDeletion({ target, deleteCurrentAccount: remote, replace: vi.fn(), logout: async (o) => { await o?.beforeMutation?.(); local(); return { kind: 'completed' }; } });
    expect(remote.mock.invocationCallOrder[0]).toBeLessThan(runnerCustody.removeAccount.mock.invocationCallOrder[0]!);
    expect(runnerCustody.removeAccount.mock.invocationCallOrder[0]).toBeLessThan(local.mock.invocationCallOrder[0]!);
    expect(runnerCustody.removeAccount).toHaveBeenCalledWith(target.scope);
  });
  it('retains local state when remote deletion fails', async () => { const replace = vi.fn(); await expect(completeAccountDeletion({ target, deleteCurrentAccount: async () => { throw new Error('failed'); }, replace, logout: async (o) => { await o?.beforeMutation?.(); return { kind: 'completed' }; } })).rejects.toThrow('failed'); expect(replace).not.toHaveBeenCalled(); expect(runnerCustody.removeAccount).not.toHaveBeenCalled(); });
  it('distinguishes Runner cleanup failure after confirmed deletion and never removes credentials', async () => {
    let credentialsRemoved = false;
    const logout = vi.fn(async (o?: Readonly<{ beforeMutation?: () => void | Promise<void> }>) => {
      await o?.beforeMutation?.();
      credentialsRemoved = true;
      return { kind: 'completed' as const };
    });
    runnerCustody.removeAccount.mockRejectedValueOnce(new Error('staged file busy'));
    const remote = vi.fn(async () => ({ status: 'deleted' as const }));
    const failure = await completeAccountDeletion({ target, deleteCurrentAccount: remote, replace: vi.fn(), logout })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountDeletedLocalCleanupError);
    expect(logout).toHaveBeenCalledOnce();
    expect(credentialsRemoved).toBe(false);

    runnerCustody.removeAccount.mockResolvedValueOnce(undefined);
    await expect((failure as AccountDeletedLocalCleanupError).retryLocalCleanup()).resolves.toEqual({ kind: 'completed' });
    expect(remote).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledTimes(2);
    expect(credentialsRemoved).toBe(true);
  });
  it('distinguishes credential cleanup failure after confirmed deletion', async () => { await expect(completeAccountDeletion({ target, deleteCurrentAccount: async () => ({ status: 'deleted' }), replace: vi.fn(), logout: async (o) => { await o?.beforeMutation?.(); throw new Error('cleanup'); } })).rejects.toBeInstanceOf(AccountDeletedLocalCleanupError); });
});
