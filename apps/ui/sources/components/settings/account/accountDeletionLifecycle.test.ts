import { describe, expect, it, vi } from 'vitest';
import { AccountDeletedLocalCleanupError, completeAccountDeletion } from './accountDeletionLifecycle';
describe('completeAccountDeletion', () => {
  it('deletes remotely before local cleanup', async () => { const remote = vi.fn(async () => ({ status: 'deleted' as const })); const local = vi.fn(); await completeAccountDeletion({ deleteCurrentAccount: remote, replace: vi.fn(), logout: async (o) => { await o?.beforeMutation?.(); local(); return { kind: 'completed' }; } }); expect(remote.mock.invocationCallOrder[0]).toBeLessThan(local.mock.invocationCallOrder[0]!); });
  it('retains local state when remote deletion fails', async () => { const replace = vi.fn(); await expect(completeAccountDeletion({ deleteCurrentAccount: async () => { throw new Error('failed'); }, replace, logout: async (o) => { await o?.beforeMutation?.(); return { kind: 'completed' }; } })).rejects.toThrow('failed'); expect(replace).not.toHaveBeenCalled(); });
  it('distinguishes cleanup failure after confirmed deletion', async () => { await expect(completeAccountDeletion({ deleteCurrentAccount: async () => ({ status: 'deleted' }), replace: vi.fn(), logout: async (o) => { await o?.beforeMutation?.(); throw new Error('cleanup'); } })).rejects.toBeInstanceOf(AccountDeletedLocalCleanupError); });
});
