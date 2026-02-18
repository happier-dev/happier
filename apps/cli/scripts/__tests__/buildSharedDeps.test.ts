import { describe, expect, it, vi } from 'vitest';
import { sep } from 'node:path';

import { resolveTscBin, runTsc } from '../buildSharedDeps.mjs';

describe('buildSharedDeps', () => {
  it('surfaces which tsconfig failed when compilation throws', () => {
    const execFileSync = vi.fn(() => {
      throw new Error('tsc failed');
    });

    expect(() => runTsc('/repo/packages/protocol/tsconfig.json', { execFileSync })).toThrow(
      /tsconfig\.json/i,
    );
  });

  it('invokes tsc.cmd via cmd.exe on Windows', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('C:\\repo\\packages\\protocol\\tsconfig.json', {
      execFileSync,
      tscBin: 'C:\\repo\\node_modules\\.bin\\tsc.cmd',
      platform: 'win32',
    });

    expect(execFileSync).toHaveBeenCalled();
    const [cmd, args, opts] = execFileSync.mock.calls[0] ?? [];
    expect(cmd).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(String(args[3])).toContain('tsc.cmd');
    expect(String(args[3])).toContain('-p');
    expect(opts).toHaveProperty('stdio', 'inherit');
  });

  it('prefers the workspace root tsc binary when present', () => {
    const bin = resolveTscBin({
      exists: (candidate: string) =>
        candidate.includes(`${sep}node_modules${sep}.bin${sep}`) &&
        !candidate.includes(`${sep}cli${sep}node_modules${sep}`),
    });

    expect(bin).toMatch(/node_modules/);
    expect(bin).not.toMatch(/cli[\\/]+node_modules/);
  });
});
