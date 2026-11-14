import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AuthoritativePackagedRuntimeCustody } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

// Filesystem boundary only: keep bundled ingestion and contribution projection real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } =
    await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

// Process-location boundary: which immutable runtime closure this process
// executes from. A source checkout has none, so the test names one.
const packagedCustody: { current: AuthoritativePackagedRuntimeCustody | null } =
  { current: null };
vi.mock(
  '@/packagedRuntime/resolvePackagedRuntimeEntrypoint',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/packagedRuntime/resolvePackagedRuntimeEntrypoint')
      >();
    return {
      ...actual,
      resolveAuthoritativePackagedRuntimeCustody: () => packagedCustody.current,
    };
  },
);

const OPENCODE_PLUGIN_ID = 'happier.agent.opencode';
const PACKAGED_ENTRY_MARKER = '__HAPPIER_PACKAGED_OPENCODE_ENTRY_EVALUATED__';

declare global {
  var __HAPPIER_PACKAGED_OPENCODE_ENTRY_EVALUATED__: boolean | undefined;
}

async function seedPackagedRuntimeRoot(): Promise<string> {
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'happier-packaged-serving-'),
  );
  const manifestsDir = join(runtimeRoot, 'assets', 'bundled-plugin-manifests');
  await mkdir(manifestsDir, { recursive: true });
  // A cold start maps every bundled declaration of the packaged closure.
  await cp(
    resolve(__dirname, '../../../assets/bundled-plugin-manifests'),
    manifestsDir,
    { recursive: true },
  );
  const packageRoot = join(
    runtimeRoot,
    'node_modules',
    '@happier-dev',
    'plugins-opencode',
  );
  await mkdir(join(packageRoot, '.happier-plugin-build'), { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-opencode', type: 'module' }),
  );
  // The packaged closure's own activation bytes; evaluating them proves the
  // registry selected this runtime root rather than an ambient package.
  await writeFile(
    join(packageRoot, '.happier-plugin-build', 'daemon.js'),
    `export async function activate() {\n  globalThis.${PACKAGED_ENTRY_MARKER} = true;\n  throw new Error('packaged fixture activation stops here');\n}\n`,
  );
  return runtimeRoot;
}

describe('resolveExecutablePluginRuntimeRegistry packaged serving occurrences', () => {
  it('activates a serving bundled plugin from the packaged runtime closure after an incremental re-resolution', async () => {
    const runtimeRoot = await seedPackagedRuntimeRoot();
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-packaged-serving-home-'),
    );
    packagedCustody.current = Object.freeze({
      root: runtimeRoot,
      packagedRuntime: Object.freeze({
        kind: 'cli_version_root' as const,
        versionRootId: 'local-stable-1',
      }),
      provenance: 'packaged-module' as const,
    });
    let first: Awaited<
      ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
    > | null = null;
    let second: Awaited<
      ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
    > | null = null;
    try {
      // Cold start: OpenCode is declared and dormant until its demand.
      first = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
      const occurrenceId = first.readPluginOccurrenceId?.(OPENCODE_PLUGIN_ID);
      const sourceCustody = first.readPluginSourceCustody?.(OPENCODE_PLUGIN_ID);
      if (!occurrenceId || !sourceCustody)
        throw new Error('Expected a dormant packaged OpenCode occurrence');
      expect(sourceCustody).toMatchObject({ kind: 'bundled_first_party' });

      // An incremental reload re-resolves only changed plugins and keeps
      // the dormant OpenCode slot serving its existing occurrence.
      second = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        pluginIds: [],
        servingPluginOccurrences: new Map([
          [OPENCODE_PLUGIN_ID, { occurrenceId, sourceCustody }],
        ]),
      });
      expect(second.readPluginOccurrenceId?.(OPENCODE_PLUGIN_ID)).toBe(
        occurrenceId,
      );
      globalThis[PACKAGED_ENTRY_MARKER] = undefined;
      // The fixture's activate throws after marking; the activation outcome
      // itself is not this test's contract.
      await second.activatePluginsForValidation([OPENCODE_PLUGIN_ID]);

      expect(second.pluginDiagnosticsByPluginId[OPENCODE_PLUGIN_ID]).toEqual([
        expect.objectContaining({ message: 'packaged fixture activation stops here' }),
      ]);
      expect(globalThis[PACKAGED_ENTRY_MARKER]).toBe(true);
    } finally {
      packagedCustody.current = null;
      delete globalThis[PACKAGED_ENTRY_MARKER];
      await second?.dispose();
      await first?.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
