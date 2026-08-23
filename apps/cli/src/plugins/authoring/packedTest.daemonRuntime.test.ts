import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';

import { resolveDisposableDaemonEnvironment } from './packedTest';

const SOURCE_MODULE_URL = 'file:///checkout/apps/cli/src/plugins/authoring/packedTest.ts';
const PACKAGED_MODULE_URL = 'file:///opt/happier/package-dist/plugins-BJBIQUep.mjs';

describe('disposable packed-test daemon runtime', () => {
  it('runs the checkout sources instead of a prebuilt CLI artifact when the harness itself runs from source', () => {
    const environment = resolveDisposableDaemonEnvironment(
      {
        PATH: process.env.PATH,
        HAPPIER_VARIANT: undefined,
        HAPPIER_STACK_REPO_DIR: undefined,
        HAPPIER_STACK_CLI_ROOT_DIR: undefined,
        HAPPIER_STACK_STACK: undefined,
      },
      SOURCE_MODULE_URL,
    );

    expect(environment.HAPPIER_CLI_SUBPROCESS_PREFER_TSX).toBe('1');

    const spec = buildHappyCliSubprocessLaunchSpec(
      ['daemon', 'plugin-packed-test-host'],
      { environment },
    );
    const sourceEntrypoint = join(projectPath(), 'src', 'index.ts');

    // The composed decision is what the journey actually executes: the daemon
    // must load the CLI sources under test, never a `package-dist`/`dist`
    // build that can predate them.
    expect(spec.args).toContain(sourceEntrypoint);
    const packagedCliRoots = [join(projectPath(), 'package-dist'), join(projectPath(), 'dist')];
    expect(spec.args.filter((argument) => (
      packagedCliRoots.some((root) => argument.startsWith(root))
    ))).toEqual([]);
  });

  it('keeps an explicitly pinned caller entrypoint authoritative', () => {
    const environment = resolveDisposableDaemonEnvironment(
      { HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: '/tmp/fake-packed-daemon.mjs' },
      SOURCE_MODULE_URL,
    );

    expect(environment.HAPPIER_CLI_SUBPROCESS_PREFER_TSX).toBeUndefined();
    expect(environment.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT).toBe('/tmp/fake-packed-daemon.mjs');
  });

  it('leaves a packaged CLI on its own packaged entrypoint', () => {
    const environment = resolveDisposableDaemonEnvironment({}, PACKAGED_MODULE_URL);

    expect(environment.HAPPIER_CLI_SUBPROCESS_PREFER_TSX).toBeUndefined();
    expect(environment.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK).toBe('1');
  });
});
