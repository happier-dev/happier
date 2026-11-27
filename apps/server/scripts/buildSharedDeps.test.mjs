import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { prepareServerWorkspacePrerequisites } from './buildSharedDeps.mjs';
import { buildPublicProfileRenderer } from './buildPublicProfileRenderer.mjs';
import { buildPublicShareViewerBundle } from './buildPublicShareViewer.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const adapterSource = await readFile(new URL('./buildSharedDeps.mjs', import.meta.url), 'utf8');

test('server shared prerequisites delegate to the canonical stale-only workspace owner', () => {
  assert.match(adapterSource, /ensureWorkspacePackagesBuiltForComponent/);
  assert.doesNotMatch(adapterSource, /\bexecFileSync\b|\brunTsc\b/);
});

test('server shared prerequisite adapter passes its package root and caller environment to the canonical owner', async () => {
  const calls = [];
  const env = { CI: '1' };
  const result = await prepareServerWorkspacePrerequisites({
    env,
    quiet: true,
    ensureWorkspacePackagesBuiltForComponent: async (...args) => {
      calls.push(args);
      return { ok: true, built: [], skipped: [] };
    },
  });

  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /apps\/server$/);
  assert.deepEqual(calls[0][1], { env, quiet: true });
  assert.deepEqual(result, { ok: true, built: [], skipped: [] });
});

test('server source tests verify generated schemas without rebuilding shared runtime packages', () => {
  assert.match(packageJson.scripts['test:local'], /\btest:prepare\b/);
  assert.doesNotMatch(packageJson.scripts['test:prepare'], /\bbuild:shared\b/);
  assert.match(packageJson.scripts['test:prepare'], /scripts\/schemaSync\.ts --check\b/);
  assert.match(packageJson.scripts['typecheck:runtime'], /scripts\/generateClients\.ts --check\b/);
  assert.doesNotMatch(
    packageJson.scripts['typecheck:runtime'],
    /\b(?:yarn|build|build:shared|generate:providers)\b/,
  );
});

test('server ordinary typecheck prepares stale ignored Prisma clients before checking source', () => {
  assert.match(
    packageJson.scripts['typecheck:local'],
    /^node \.\/scripts\/preparePublicRendererAssets\.mjs && pnpm --silent run generate:providers && node \.\/scripts\/runTypeScriptCli\.mjs --noEmit(?: -p [\w.]+)*$/,
  );
  assert.doesNotMatch(packageJson.scripts['typecheck:local'], /\b(?:build|build:shared)\b/);
});

test('server build prepares generated clients through the canonical postinstall lifecycle', () => {
  assert.equal(packageJson.scripts.prebuild, 'pnpm --silent run postinstall:real');
  assert.equal(packageJson.scripts['postinstall:real'], 'pnpm --silent run generate:providers && pnpm --silent run build:shared');
});

test('server finite typecheck verifies generated clients before checking source', () => {
  assert.match(
    packageJson.scripts['typecheck:source:finite'],
    /^node \.\/scripts\/preparePublicRendererAssets\.mjs && pnpm --silent run generate:providers:check && node \.\/scripts\/runTypeScriptCli\.mjs --noEmit(?: -p [\w.]+)*$/,
  );
});

test('server ordinary integration entries route through hstack without runtime preparation', () => {
  for (const scriptName of ['test:integration', 'test:db-contract']) {
    assert.match(packageJson.scripts[scriptName], new RegExp(`--script=${scriptName}:local`));
    assert.doesNotMatch(packageJson.scripts[scriptName], /\bbuild:shared\b/);
    assert.doesNotMatch(packageJson.scripts[`${scriptName}:local`], /\bbuild:shared\b/);
  }
});

for (const renderer of ['profile', 'share']) {
  test(`public ${renderer} renderer resolves real web packages from a hoisted workspace install`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-public-renderer-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const projectDir = join(root, 'apps/server');
    const sourceDir = join(projectDir, renderer === 'profile'
      ? 'sources/app/account/profile/render' : 'sources/app/api/routes/share');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(root, 'apps/ui'), { recursive: true });
    const requireServer = createRequire(import.meta.url);
    await mkdir(join(root, 'node_modules/@happier-dev'), { recursive: true });
    for (const name of ['react', 'react-dom', 'react-native-web', 'react-native-svg']) {
      await symlink(dirname(requireServer.resolve(`${name}/package.json`)), join(root, 'node_modules', name), 'junction');
    }
    // The filesystem boundary models a workspace export and an installed private copy;
    // no protocol schema or domain behavior is replaced by the fixture.
    const protocolDir = join(root, 'packages/protocol');
    const privateDir = join(sourceDir, 'private');
    const privateProtocolDir = join(privateDir, 'node_modules/@happier-dev/protocol');
    await mkdir(join(protocolDir, 'src/sharing'), { recursive: true });
    await mkdir(join(privateProtocolDir, 'dist/sharing'), { recursive: true });
    await writeFile(join(protocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: {
      './sharing/public-viewer': { 'happier-source': './src/sharing/publicViewer.ts', default: './dist/sharing/publicViewer.js' },
      './widgets': { 'happier-source': './src/widgets.ts', default: './dist/widgets.js' },
    } }));
    await symlink(protocolDir, join(root, 'node_modules/@happier-dev/protocol'), 'junction');
    await writeFile(join(privateProtocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: {
      './sharing/public-viewer': './dist/sharing/publicViewer.js', './widgets': './dist/widgets.js',
    } }));
    for (const file of ['sharing/publicViewer', 'widgets']) {
      await writeFile(join(protocolDir, `src/${file}.ts`), 'export const probe = "workspace-protocol-source";');
      await writeFile(join(privateProtocolDir, `dist/${file}.js`), 'export const probe = "private-protocol-copy";');
    }
    await writeFile(join(privateDir, 'index.ts'), `
      import { probe as viewer } from '@happier-dev/protocol/sharing/public-viewer';
      import { probe as widgets } from '@happier-dev/protocol/widgets';
      export const protocol = [viewer, widgets];
    `);
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(projectDir, 'package.json'), '{}');
    await writeFile(join(root, 'apps/ui/package.json'), '{}');
    await writeFile(join(projectDir, 'tsconfig.json'), '{}');
    const entry = renderer === 'profile' ? 'publicProfileRenderer.ts' : 'publicShareViewerBrowser.ts';
    await writeFile(join(sourceDir, entry), `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { View } from 'react-native';
      import { Svg } from 'react-native-svg';
      import { protocol } from './private/index';
      globalThis.publicRendererDependencyProbe = [createElement, createRoot, View, Svg, protocol];
    `);

    const buildRenderer = renderer === 'profile' ? buildPublicProfileRenderer : buildPublicShareViewerBundle;
    await buildRenderer({ projectDir });
    await buildRenderer({ projectDir, check: true });
    const target = join(sourceDir, renderer === 'profile'
      ? 'publicProfileRenderer.generated.mjs' : 'publicShareViewerBundle.generated.ts');
    const output = await readFile(target, 'utf8');
    assert.match(output, /publicRendererDependencyProbe/);
    assert.match(output, /workspace-protocol-source/);
    assert.doesNotMatch(output, /private-protocol-copy/);
    await writeFile(target, 'previous-generation\n');
    let patch = '';
    const stdout = t.mock.method(process.stdout, 'write', chunk => {
      patch += String(chunk);
      return true;
    });
    try {
      await buildRenderer({ projectDir, printPatch: true });
    } finally {
      stdout.mock.restore();
    }
    assert.equal(await readFile(target, 'utf8'), 'previous-generation\n');
    const lines = patch.split('\n');
    assert.equal(lines[0], '*** Begin Patch');
    assert.equal(lines[1], `*** Add File: ${target}`);
    assert.equal(lines.slice(2, -2).map(line => line.slice(1)).join('\n') + '\n', output);
  });
}

test('the profile renderer uses the same TS settings for a Protocol export and its relative source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-profile-protocol-resolution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, 'apps/server');
  const sourceDir = join(projectDir, 'sources/app/account/profile/render');
  const protocol = join(root, 'packages/protocol');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(protocol, { recursive: true });
  await mkdir(join(root, 'node_modules/@happier-dev'), { recursive: true });
  const require = createRequire(import.meta.url);
  for (const name of ['react-native-web', 'react-native-svg']) {
    await symlink(dirname(require.resolve(`${name}/package.json`)), join(root, 'node_modules', name), 'junction');
  }
  await symlink(protocol, join(root, 'node_modules/@happier-dev/protocol'), 'junction');
  await writeFile(join(protocol, 'package.json'), JSON.stringify({
    name: '@happier-dev/protocol', type: 'module', exports: { './fixture': './fixture.ts' },
  }));
  await writeFile(join(projectDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { useDefineForClassFields: false } }));
  await writeFile(join(projectDir, 'package.json'), '{"type":"module"}');
  await writeFile(join(protocol, 'fixture.ts'), `
    class Base { set value(n: number) { this.seen = n; } }
    class Derived extends Base { value = 7; }
    export const fromSetter = new Derived().seen;
  `);
  await writeFile(join(protocol, 'relative.ts'), 'export { fromSetter as relative } from "./fixture";');
  await writeFile(join(sourceDir, 'publicProfileRenderer.ts'), `
    import { fromSetter } from '@happier-dev/protocol/fixture';
    import { relative } from '../../../../../../../packages/protocol/relative';
    export const observed = [fromSetter, relative];
  `);

  await buildPublicProfileRenderer({ projectDir });
  const renderer = await import(pathToFileURL(join(sourceDir, 'publicProfileRenderer.generated.mjs')).href);
  assert.deepEqual(renderer.observed, [7, 7]);
});
