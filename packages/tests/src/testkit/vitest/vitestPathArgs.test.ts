import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findUnresolvedVitestPathArgs } from '../../../scripts/vitestPathArgs.mjs';

/**
 * F-7. `vitest run <path>` silently ignores a positional path it cannot match and still exits 0.
 * D2 passed seven paths, vitest collected six, and the run reported success — the evidence was
 * invalid, not just one test missing. In this workspace the same hole makes an ORPHANED suite look
 * green: a suite re-homed into a config that does not collect it reports nothing and exits 0, which
 * is indistinguishable from a passing run and is exactly the defect G6 exists to close.
 *
 * The guard runs in `scripts/run-vitest-with-heartbeat.mjs`, the single wrapper every
 * `packages/tests` CI lane invokes vitest through, so one check covers `test:core`, `:core:fast`,
 * `:core:slow`, `:core:handoff`, the compat lane, the stress lanes and the packed-voice lane.
 *
 * This test lives under `src/testkit/**` deliberately: `vitest.core.fast.config.ts` collects that
 * glob and CI's `e2e-core` job runs that config. `scripts/*.test.mjs` would have been the obvious
 * home, but `test:scripts:self` is referenced by ZERO workflows — putting the guard's own test
 * there would have reproduced the defect it guards against.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'e1-vitest-path-args-'));
  mkdirSync(join(root, 'suites/real'), { recursive: true });
  writeFileSync(join(root, 'suites/real/alpha.test.ts'), 'export {};\n');
  mkdirSync(join(root, 'suites/empty'), { recursive: true });
  writeFileSync(join(root, 'suites/empty/README.md'), 'no tests here\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findUnresolvedVitestPathArgs', () => {
  it('reports a positional path that does not resolve to anything', () => {
    const found = findUnresolvedVitestPathArgs(
      ['suites/real/alpha.test.ts', 'suites/real/ghost.test.ts'],
      { packageRoot: root },
    );

    expect(found).toEqual([{ arg: 'suites/real/ghost.test.ts', reason: 'missing' }]);
  });

  it('reports an existing directory that contains no test files', () => {
    const found = findUnresolvedVitestPathArgs(['suites/empty'], { packageRoot: root });

    expect(found).toEqual([{ arg: 'suites/empty', reason: 'no-test-files' }]);
  });

  it('accepts a directory that does contain test files', () => {
    expect(findUnresolvedVitestPathArgs(['suites/real'], { packageRoot: root })).toEqual([]);
  });

  it('does not treat a flag value as a path even when it looks like one', () => {
    // `-t suites/ghost` is a test-NAME pattern. Validating it as a path would fail every lane
    // that filters by name, so the guard must consume option values the same way the wrapper does.
    expect(
      findUnresolvedVitestPathArgs(['suites/real/alpha.test.ts', '-t', 'suites/ghost'], { packageRoot: root }),
    ).toEqual([]);
  });

  it('leaves a bare substring filter alone', () => {
    // vitest positional args may be plain substring filters. Only path-shaped args are validated,
    // otherwise the guard would break ad hoc `vitest run pendingQueue` style invocations.
    expect(findUnresolvedVitestPathArgs(['pendingQueue'], { packageRoot: root })).toEqual([]);
  });
});
