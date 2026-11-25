import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { NegativeTypeContractsFixtureResult } from './test-support/negativeTypeContracts.fixture.js';
import { runBoundedFixtureCommand } from './test-support/boundedFixtureCommand.js';

describe('SDK negative type contracts', () => {
    // One TypeScript program over every reconstructed negative case in the
    // package: the cost tracks the SDK source tree, not a fixed workload, and
    // it grows with each `@sdk-negative-type-case` fence. Measured 83.9 s in
    // isolation and >120 s inside `vitest run` for the whole package, where it
    // shares the host with the other whole-program declaration suites. The
    // budget is sized from that in-suite reality with headroom, so a slow
    // shared host cannot turn a passing type contract into a red suite.
    it('rejects every data-driven negative case without source suppression fences', async () => {
        const sourceRoot = resolve(import.meta.dirname);
        const output = await runBoundedFixtureCommand(
            'SDK negative type contract analysis',
            resolve(sourceRoot, '..'),
            [
                '--conditions=happier-source',
                '--import', resolve(sourceRoot, '../../cli-common/registerSourceRuntime.mjs'),
                resolve(sourceRoot, 'test-support/negativeTypeContracts.fixture.ts'),
            ],
            { timeoutMs: 300_000 },
        );
        const result = JSON.parse(output) as NegativeTypeContractsFixtureResult;

        // Missing fixture discovery must fail, but legitimate additions and
        // removals do not need a second hand-maintained case census. Ordinary
        // expected-error fences are checked by the package test compiler.
        expect(result.caseCount).toBeGreaterThan(0);
        expect(result.syntacticDiagnostics).toEqual([]);
        expect(result.missing).toEqual([]);
        expect(result.unexpectedFiles).toEqual([]);
    }, 300_000);
});
