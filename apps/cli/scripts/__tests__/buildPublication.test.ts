import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { resolveWorkspaceBundlePublicationMode } from '../../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  buildCliPublication,
  resolveCliPublicationBuildSteps,
} from '../buildPublication.mjs';

const packageRoot = resolve(process.cwd());

describe('CLI publication build', () => {
  it('compiles the shared closure in artifact mode before the dist build it fingerprints', () => {
    // The shared build regenerates the bundled plugin inventory
    // (generatedBundledPluginArtifacts.ts), which is an input to the dist runtime-input
    // fingerprint that packTarball.mjs asserts. Building dist first records a fingerprint
    // the regeneration immediately invalidates; running the shared build in live mode
    // keeps a failing plugin's last-green package and packs bytes current source cannot
    // produce.
    const steps = resolveCliPublicationBuildSteps({ packageRoot });
    expect(steps.map((step) => step.name)).toEqual(['shared-deps', 'dist']);

    const [sharedDeps, dist] = steps;
    expect(sharedDeps!.args[0]).toBe(resolve(packageRoot, 'scripts', 'buildSharedDeps.mjs'));
    expect(resolveWorkspaceBundlePublicationMode({
      argv: sharedDeps!.args.slice(1),
      env: {},
    })).toBe('artifact');
    expect(dist!.args).toEqual([resolve(packageRoot, 'scripts', 'build.mjs')]);

    // build.mjs resolves the package it builds from its working directory.
    for (const step of steps) {
      expect(step.cwd).toBe(packageRoot);
    }
  });

  it('resolves the same steps from a repository root as from the package root', () => {
    const repoRoot = resolve(packageRoot, '..', '..');
    expect(resolveCliPublicationBuildSteps({ repoRoot })).toEqual(
      resolveCliPublicationBuildSteps({ packageRoot }),
    );
  });

  it('runs every step in order through the caller-provided executor', () => {
    const calls: Array<{ command: string; args: string[]; cwd: unknown; env: unknown }> = [];
    buildCliPublication({
      packageRoot,
      env: { HAPPIER_TEST_PUBLICATION: '1' },
      exec: (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd, env: options?.env });
        return '';
      },
    });

    expect(calls.map((call) => call.args)).toEqual(
      resolveCliPublicationBuildSteps({ packageRoot }).map((step) => step.args),
    );
    expect(calls.every((call) => call.cwd === packageRoot)).toBe(true);
    expect(calls.every(
      (call) => (call.env as Record<string, string>).HAPPIER_TEST_PUBLICATION === '1',
    )).toBe(true);
  });

  it('accepts a bounded environment override for a complete source-rebuilt closure', () => {
    const timeouts: unknown[] = [];
    buildCliPublication({
      packageRoot,
      env: { HAPPIER_CLI_PUBLICATION_BUILD_TIMEOUT_MS: '5400000' },
      exec: (_command, _args, options) => {
        timeouts.push(options?.timeout);
        return '';
      },
    });

    expect(timeouts).toEqual([5_400_000, 5_400_000]);
  });

  it('stops at the first failing step instead of packing an unfinished closure', () => {
    const attempted: string[] = [];
    expect(() => buildCliPublication({
      packageRoot,
      exec: (_command, args) => {
        attempted.push(String(args[0]));
        throw new Error('shared build refused: a bundled plugin failed to compile');
      },
    })).toThrow(/shared build refused/);
    expect(attempted).toHaveLength(1);
  });
});
