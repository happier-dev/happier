import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

test('local bundled workspace preflight falls back to bundleWorkspaceDeps when the monorepo sync helper is unavailable', async () => {
  const rootDir = resolve('/Users/leeroy/Documents/Development/happier/dev/apps/stack');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'local-bundled-preflight-fallback-'));
  try {
    const markerPath = join(fixtureDir, 'bundle.json');
    const bundleStubPath = join(fixtureDir, 'bundleWorkspaceDeps.mjs');
    const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      bundleStubPath,
      [
        "import { writeFileSync } from 'node:fs';",
        'export async function bundleWorkspaceDeps(opts) {',
        `  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(opts), 'utf8');`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      resolveSyncModulePathStubPath,
      [
        'export function resolveBundledWorkspaceSyncModulePath() {',
        '  return null;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
        '  }',
        "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const modulePath = join(rootDir, 'bin', 'localBundledWorkspacePreflight.mjs');
    const res = await runNodeCapture(
      ['--input-type=module', '-e', `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(modulePath)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(rootDir)});`],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
        },
      },
    );

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const options = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(options.repoRoot, resolve('/Users/leeroy/Documents/Development/happier/dev'));
    assert.equal(options.stackDir, rootDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
