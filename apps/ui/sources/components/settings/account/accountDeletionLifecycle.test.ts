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
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();

import * as deviceLocalStorage from '@/auth/storage/deviceLocalStorage';
import { createRunnerActivationKeyCustody, type RunnerActivationKeyCustody } from '@/sync/domains/ephemeralRunner/runnerActivationKeyCustody';
import { listRunnerCreatorCustodyActivationIds } from '@/sync/domains/ephemeralRunner/runnerCreatorLaunchCustody';

import { AccountDeletedLocalCleanupError, completeAccountDeletion } from './accountDeletionLifecycle';
describe('completeAccountDeletion', () => {
  let target: ServerAccountScopeLifetime;
  let custody: RunnerActivationKeyCustody;
  let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
  beforeEach(async () => {
    vi.restoreAllMocks();
    connection = await restoreServerAccountForTest({ serverUrl: 'https://account-cleanup.test', accountId: 'account-a',
      credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().activateProfileScope({ serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: 'account-a' });
    const captured = captureActiveServerAccountScopeLifetime();
    if (!captured) throw new Error('Expected real Account cleanup lifetime');
    target = captured;
    custody = await createRunnerActivationKeyCustody(target.scope);
  });
  afterEach(async () => { vi.restoreAllMocks(); await connection?.dispose(); connection = null; });
  it('deletes remotely, erases exact Runner custody, then removes local credentials', async () => {
    const remote = vi.fn(async () => {
      expect(await deviceLocalStorage.readDeviceLocalStorageString(custody.keyHandle)).not.toBeNull();
      return { status: 'deleted' as const };
    });
    const local = vi.fn(async () => {
      expect(await deviceLocalStorage.readDeviceLocalStorageString(custody.keyHandle)).toBeNull();
      expect(await listRunnerCreatorCustodyActivationIds(target.scope)).toEqual([]);
    });
    await completeAccountDeletion({ target, deleteCurrentAccount: remote, replace: vi.fn(), logout: async (o) => { await o?.beforeMutation?.(); await local(); return { kind: 'completed' }; } });
    expect(remote).toHaveBeenCalledOnce();
    expect(local).toHaveBeenCalledOnce();
  });
  it('retains local state when remote deletion fails', async () => { const replace = vi.fn(); await expect(completeAccountDeletion({ target, deleteCurrentAccount: async () => { throw new Error('failed'); }, replace, logout: async (o) => { await o?.beforeMutation?.(); return { kind: 'completed' }; } })).rejects.toThrow('failed'); expect(replace).not.toHaveBeenCalled(); expect(await deviceLocalStorage.readDeviceLocalStorageString(custody.keyHandle)).not.toBeNull(); });
  it('distinguishes Runner cleanup failure after confirmed deletion and never removes credentials', async () => {
    let credentialsRemoved = false;
    const logout = vi.fn(async (o?: Readonly<{ beforeMutation?: () => void | Promise<void> }>) => {
      await o?.beforeMutation?.();
      credentialsRemoved = true;
      return { kind: 'completed' as const };
    });
    // Device-local storage is the persistence boundary; the custody owners remain real.
    const actualRemove = deviceLocalStorage.removeDeviceLocalStorageString;
    const remove = vi.spyOn(deviceLocalStorage, 'removeDeviceLocalStorageString');
    remove.mockImplementationOnce(async () => { throw new Error('staged file busy'); });
    const remote = vi.fn(async () => ({ status: 'deleted' as const }));
    const failure = await completeAccountDeletion({ target, deleteCurrentAccount: remote, replace: vi.fn(), logout })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountDeletedLocalCleanupError);
    expect(logout).toHaveBeenCalledOnce();
    expect(credentialsRemoved).toBe(false);

    remove.mockImplementation(actualRemove);
    await expect((failure as AccountDeletedLocalCleanupError).retryLocalCleanup()).resolves.toEqual({ kind: 'completed', erasure: { status: 'deleted' } });
    expect(remote).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledTimes(2);
    expect(credentialsRemoved).toBe(true);
  });
  it('distinguishes credential cleanup failure after confirmed deletion', async () => { await expect(completeAccountDeletion({ target, deleteCurrentAccount: async () => ({ status: 'deleted' }), replace: vi.fn(), logout: async (o) => { await o?.beforeMutation?.(); throw new Error('cleanup'); } })).rejects.toBeInstanceOf(AccountDeletedLocalCleanupError); });
});
