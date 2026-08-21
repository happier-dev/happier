import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareMachineHomeDirs } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

const { resolveMachineControlLocalityProof } = await import('./machineControlLocality');

const credentials = { token: 'token' };

describe('machineControlLocality', () => {
  beforeEach(() => {
    mocks.fetchAccountMachineReplacements.mockReset();
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-local' },
      { id: 'machine-unrelated' },
    ]);
  });

  it('returns exact proof when machine ids match without requiring host, home or the Account chain', async () => {
    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-local',
      currentMachineId: 'machine-local',
      credentials,
    })).toBe('exact_machine_id');
    // Cost discipline: the common path must never reach the server.
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('returns same-host-home proof for stale ids with normalized host and Windows home paths', async () => {
    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-before-restart',
      currentMachineId: 'machine-after-restart',
      sessionHost: 'LEEROY-MBP.local',
      currentMachineHost: 'leeroy-mbp',
      sessionHomeDir: 'C:\\Users\\Leeroy\\',
      currentMachineHomeDir: 'c:/users/leeroy',
      credentials,
    })).toBe('same_host_home');
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('rejects stale ids when host or home proof is missing or mismatched', async () => {
    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-before-restart',
      currentMachineId: 'machine-after-restart',
      sessionHost: 'old-host',
      currentMachineHost: 'new-host',
      sessionHomeDir: '/Users/leeroy',
      currentMachineHomeDir: '/Users/leeroy',
      credentials,
    })).toBeNull();
    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-before-restart',
      currentMachineId: 'machine-after-restart',
      sessionHost: 'leeroy-mbp',
      currentMachineHost: 'leeroy-mbp',
      sessionHomeDir: '/Users/leeroy',
      currentMachineHomeDir: '/Users/other',
      credentials,
    })).toBeNull();
    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-before-restart',
      currentMachineId: 'machine-after-restart',
      sessionHost: 'leeroy-mbp',
      currentMachineHost: 'leeroy-mbp',
      sessionHomeDir: null,
      currentMachineHomeDir: '/Users/leeroy',
      credentials,
    })).toBeNull();
  });

  it('normalizes tilde home forms when the opposite side supplies the home base', () => {
    expect(compareMachineHomeDirs('~\\', 'C:\\Users\\Leeroy', { homeDir: 'C:\\Users\\Leeroy' })).toBe(true);
    expect(compareMachineHomeDirs('~\\', '/Users/leeroy', { homeDir: '/Users/leeroy' })).toBe(true);
    expect(compareMachineHomeDirs('~/', '/Users/leeroy', { homeDir: '/Users/leeroy' })).toBe(true);
  });

  it('does not collapse sibling home directories', () => {
    expect(compareMachineHomeDirs('C:\\Users\\Leeroy', 'C:\\Users\\Leeroy2')).toBe(false);
    expect(compareMachineHomeDirs('/Users/leeroy', '/Users/leeroy2')).toBe(false);
  });
  /**
   * The user's ruling: replacing a machine must not strand the Sessions the
   * previous one hosted. A replaced machine keeps its row and gains a forward
   * pointer, and nothing re-homes the Session, so its recorded host stays the
   * PREDECESSOR forever. A replacement is a genuinely new host, so it shares
   * neither hostname nor home directory with its predecessor and cannot earn
   * `same_host_home`.
   */
  it('returns replacement proof when this machine replaced the session machine', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-new' },
      { id: 'machine-new' },
    ]);

    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-old',
      currentMachineId: 'machine-new',
      sessionHost: 'old-laptop',
      sessionHomeDir: '/Users/leeroy',
      currentMachineHost: 'new-laptop',
      currentMachineHomeDir: '/Users/leeroy',
      credentials,
    })).toBe('canonical_replacement');
  });

  it('follows a multi-hop replacement chain', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-mid' },
      { id: 'machine-mid', replacedByMachineId: 'machine-new' },
      { id: 'machine-new' },
    ]);

    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-old',
      currentMachineId: 'machine-new',
      credentials,
    })).toBe('canonical_replacement');
  });

  it('refuses an unrelated machine that replaced nothing', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-new' },
      { id: 'machine-new' },
      { id: 'machine-unrelated' },
    ]);

    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-old',
      currentMachineId: 'machine-unrelated',
      credentials,
    })).toBeNull();
  });

  it('refuses when the replacement chain is unreadable', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue(null);

    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-old',
      currentMachineId: 'machine-new',
      credentials,
    })).toBeNull();
  });

  /**
   * `resolveCanonicalMachineId` stops at the last reachable id when the
   * successor row is absent, so an unresolvable forward pointer must not be
   * read as inheritance by whoever happens to be asking.
   */
  it('refuses when the recorded successor row is absent from the Account', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-gone' },
      { id: 'machine-new' },
    ]);

    expect(await resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-old',
      currentMachineId: 'machine-new',
      credentials,
    })).toBeNull();
  });
});
