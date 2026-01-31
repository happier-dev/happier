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
