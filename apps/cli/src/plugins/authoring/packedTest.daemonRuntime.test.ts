import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';

import {
  recordDisposableDaemonLaunchEntrypoint,
  resolveDisposableDaemonEnvironment,
} from './packedTest';

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

  it('pins a built harness to the CLI build it is itself running from', async () => {
    // A dev build is the ordinary way `happier plugins test --packed` runs:
    // `bin/happier.mjs` prefers `dist/`, while the subprocess resolver prefers
    // `package-dist/`. Without a pin the daemon proves a different build than
    // the one hosting the journey.
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-packed-daemon-runtime-'));
    const buildDirectory = join(runtimeRoot, 'dist');
    await mkdir(buildDirectory, { recursive: true });
    const buildEntrypoint = join(buildDirectory, 'index.mjs');
    await writeFile(buildEntrypoint, 'export {};\n', 'utf8');

    try {
      const environment = resolveDisposableDaemonEnvironment(
        {
          PATH: process.env.PATH,
          HAPPIER_VARIANT: undefined,
          HAPPIER_STACK_REPO_DIR: undefined,
          HAPPIER_STACK_CLI_ROOT_DIR: undefined,
          HAPPIER_STACK_STACK: undefined,
        },
        pathToFileURL(join(buildDirectory, 'plugins-BJBIQUep.mjs')).href,
      );

      expect(environment.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT).toBe(buildEntrypoint);
      expect(environment.HAPPIER_CLI_SUBPROCESS_PREFER_TSX).toBeUndefined();

      const spec = buildHappyCliSubprocessLaunchSpec(
        ['daemon', 'plugin-packed-test-host'],
        { environment },
      );

      expect(spec.args).toContain(buildEntrypoint);
      expect(recordDisposableDaemonLaunchEntrypoint(spec, buildEntrypoint)).toBe(buildEntrypoint);
      expect(() => recordDisposableDaemonLaunchEntrypoint(
        spec,
        join(runtimeRoot, 'package-dist', 'index.mjs'),
      )).toThrow('Disposable plugin daemon launch did not use the expected CLI entrypoint');
      const packagedCliRoots = [join(projectPath(), 'package-dist'), join(projectPath(), 'dist')];
      expect(spec.args.filter((argument) => (
        packagedCliRoots.some((root) => argument.startsWith(root))
      ))).toEqual([]);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('leaves a build with no Node entrypoint on the ordinary resolver', async () => {
    // A `dist` directory can exist without `index.mjs` (a CJS-only build, or a
    // rebuild in progress). Pinning it would turn a resolvable spawn into
    // `Entrypoint ... does not exist`.
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-packed-daemon-runtime-'));
    const buildDirectory = join(runtimeRoot, 'dist');
    await mkdir(buildDirectory, { recursive: true });

    try {
      const environment = resolveDisposableDaemonEnvironment(
        {},
        pathToFileURL(join(buildDirectory, 'plugins-BJBIQUep.mjs')).href,
      );

      expect(environment.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT).toBeUndefined();
      expect(environment.HAPPIER_CLI_SUBPROCESS_PREFER_TSX).toBeUndefined();
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('leaves a packaged CLI on its own packaged entrypoint', () => {
    const environment = resolveDisposableDaemonEnvironment({}, PACKAGED_MODULE_URL);

    expect(environment.HAPPIER_CLI_SUBPROCESS_PREFER_TSX).toBeUndefined();
    expect(environment.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK).toBe('1');
  });
});
