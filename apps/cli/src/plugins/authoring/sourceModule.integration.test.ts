import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { evaluatePluginDevelopmentCandidate, evaluatePluginAuthorSource } from './sourceModule';

describe('plugin author source module owner', () => {

  it('leaves host Protocol source transforms to the workspace runtime during a cold DeepSec candidate evaluation', async () => {
    const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
    const scratch = await mkdtemp(join(tmpdir(), 'happier-deepsec-source-'));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--conditions=happier-source',
        '--import', './packages/cli-common/registerSourceRuntime.mjs',
        '--input-type=module', '--eval', `
          import assert from 'node:assert/strict';
          import { resolve, sep } from 'node:path';
          import { registerHooks } from 'node:module';
          const protocolRoot = resolve('packages/protocol') + sep;
          const pluginRoot = resolve('packages/plugins/review-deepsec');
          let protocolTransforms = 0;
          let pluginTransforms = 0;
          const { createJiti } = await import(import.meta.resolve('jiti'));
          globalThis.observeCandidateCompiler = (id, options) => {
            const transform = createJiti(id, options).options.transform;
            return createJiti(id, { ...options, transform(input) {
              if (input.filename?.startsWith(protocolRoot)) protocolTransforms++;
              if (input.filename?.startsWith(pluginRoot + sep)) pluginTransforms++;
              return transform(input);
            } });
          };
          const observer = 'data:text/javascript,export const createJiti = globalThis.observeCandidateCompiler';
          registerHooks({ resolve(specifier, context, nextResolve) {
            return specifier === 'jiti' && context.parentURL?.endsWith('/runtime/loadPluginModule.ts')
              ? { url: observer, shortCircuit: true }
              : nextResolve(specifier, context);
          } });
          const { evaluatePluginDevelopmentCandidate } = await import('./apps/cli/src/plugins/authoring/sourceModule.ts');
          const result = await evaluatePluginDevelopmentCandidate({
            locator: pluginRoot,
            sourceAuthority: { kind: 'development', canonicalRoot: pluginRoot, registeredRootId: pluginRoot, observedRevision: 1 },
          });
          assert.equal(result.evaluated.manifest.id, 'happier.review.deepsec');
          assert.equal(typeof result.graph.module.activate, 'function');
          console.log(JSON.stringify({ protocolTransforms, pluginTransforms }));
        `,
      ], {
        cwd: repo,
        env: { ...process.env, NODE_OPTIONS: '', TSX_TSCONFIG_PATH: join(repo, 'apps/cli/tsconfig.json'),
          TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      });
      const measures = JSON.parse(stdout.trim().split('\n').at(-1)!);
      expect(measures.pluginTransforms).toBeGreaterThan(0);
      expect(measures.protocolTransforms).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps dependency-free single-file development on public host SDK imports only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-sdk-boundary-'));
    const publicEntry = join(root, 'public.ts');
    const privateEntry = join(root, 'private.ts');
    const authority = {
      kind: 'development' as const,
      registeredRootId: 'single-file-sdk-boundary',
      canonicalRoot: root,
      observedRevision: 1,
    };
    const manifest = [
      "id: 'example.sdk-boundary', version: '0.1.0', displayName: 'SDK boundary',",
      "engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      'hostAccess: { required: [], optional: [] }, contributes: {},',
    ].join('\n');
    const definePluginManifest = [
      "id: 'example.sdk-boundary', version: '0.1.0', displayName: 'SDK boundary',",
      "engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      'hostAccess: { required: [], optional: [] },',
    ].join('\n');
    try {
      await writeFile(publicEntry, [
        "import { definePlugin } from '@happier-dev/plugin-sdk';",
        `const plugin = definePlugin({ ${definePluginManifest} });`,
        'export const manifest = plugin.manifest;',
        'export const activate = plugin.activate;',
      ].join('\n'), 'utf8');
      await writeFile(privateEntry, [
        "import { normalizePluginDaemonDatabaseRuntimeProjection } from '@happier-dev/plugin-sdk/host/registration';",
        `export const manifest = { ${manifest} };`,
        'export function activate() { void normalizePluginDaemonDatabaseRuntimeProjection; }',
      ].join('\n'), 'utf8');

      await expect(evaluatePluginDevelopmentCandidate({ locator: publicEntry, sourceAuthority: authority }))
        .resolves.toMatchObject({ evaluated: { manifest: { id: 'example.sdk-boundary' } } });
      await expect(evaluatePluginDevelopmentCandidate({
        locator: privateEntry,
        sourceAuthority: { ...authority, observedRevision: 2 },
      })).rejects.toThrow(/host-private plugin SDK module/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves public SDK root and subpath imports from the running host for a lone file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-lone-host-'));
    const entryPath = join(root, 'lone.ts');
    await writeFile(entryPath, [
      "import { defineProtocolString } from '@happier-dev/plugin-sdk/protocol';",
      'export const actionContracts = { marker: \'lone\' };',
      "export const protocolValue = defineProtocolString('lone-file');",
      'export const manifest = {',
      "  schemaVersion: 2, id: 'example.lone-host', version: '0.1.0', displayName: 'Lone host',",
      "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    try {
      // The doctor/author evaluation path must serve the same narrow host
      // resolution as the daemon development candidate path.
      await expect(evaluatePluginAuthorSource({ locator: entryPath })).resolves.toMatchObject({
        entry: { kind: 'singleFile' },
        manifest: { id: 'example.lone-host' },
        actionContracts: { marker: 'lone' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
