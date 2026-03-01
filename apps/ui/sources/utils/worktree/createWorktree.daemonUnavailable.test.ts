import { describe, expect, it, vi } from 'vitest';

const machineBashSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops', () => ({
  machineBash: (...args: unknown[]) => machineBashSpy(...args),
}));

describe('createWorktree (daemon unavailable)', () => {
  it('surfaces daemon unavailable errors instead of mislabeling as not a git repository', async () => {
    machineBashSpy.mockResolvedValueOnce({
      success: false,
      stdout: '',
      stderr: 'Daemon RPC is not available',
      exitCode: -1,
    });

    const { createWorktree } = await import('./createWorktree');
    const result = await createWorktree('machine-1', '/repo');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Daemon');
    expect(result.error).not.toBe('Not a Git repository');
  });
});
