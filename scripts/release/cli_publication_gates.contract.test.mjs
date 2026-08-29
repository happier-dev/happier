import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runCliUpdateValidation } from '../pipeline/release-validation/executors/cli-update.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const PLUGIN_PACKAGE_NAME = '@happier-dev/plugins-grok';

/**
 * Both gates report on whatever the tarball they pack contains. This sandbox reproduces the
 * only publication asymmetry that lets a SUCCESSFUL pack carry bytes current source cannot
 * produce: an artifact-mode shared build compiles every included generator-owned plugin from
 * current source and refuses when one fails, while a live build isolates that failure and
 * leaves the plugin's last-green package installed for the packer to ship.
 *
 * Everything below the gate is a real process: the sandbox publication scripts, `npm pack`,
 * and `tar`.
 */
function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

const SHARED_DEPS_FIXTURE = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');
const publishesArtifact = process.argv.slice(2).includes('--artifact');
appendFileSync(
  resolve(repoRoot, 'gate-steps.log'),
  \`shared-deps:\${publishesArtifact ? 'artifact' : 'live'}\\n\`,
);

const source = readFileSync(resolve(repoRoot, 'packages', 'plugins', 'grok', 'src', 'plugin.ts'), 'utf8');
const installedDir = resolve(packageRoot, 'node_modules', '@happier-dev', 'plugins-grok');
if (source.includes('FAIL_TO_COMPILE')) {
  if (publishesArtifact) {
    console.error('TS1005: @happier-dev/plugins-grok failed to compile');
    process.exit(1);
  }
  // Live publication retains the previously published package and reports success.
  process.exit(0);
}
mkdirSync(resolve(installedDir, 'dist'), { recursive: true });
writeFileSync(
  resolve(installedDir, 'package.json'),
  \`\${JSON.stringify({ name: '@happier-dev/plugins-grok', version: '0.0.0', main: './dist/index.js' }, null, 2)}\\n\`,
);
writeFileSync(
  resolve(installedDir, 'dist', 'index.js'),
  \`// compiled by the sandbox publication build\\n\${source}\`,
);
`;

const DIST_BUILD_FIXTURE = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');
appendFileSync(resolve(repoRoot, 'gate-steps.log'), 'dist\\n');

// Stands in for the real dist build, whose runtime-input fingerprint covers the bundled
// plugin inventory the shared build regenerates. Reading the installed package here is what
// makes the ordering observable in the packed artifact.
const installedEntry = readFileSync(
  resolve(packageRoot, 'node_modules', '@happier-dev', 'plugins-grok', 'dist', 'index.js'),
  'utf8',
);
for (const outputDir of ['dist', 'package-dist']) {
  mkdirSync(resolve(packageRoot, outputDir), { recursive: true });
  writeFileSync(
    resolve(packageRoot, outputDir, 'index.mjs'),
    \`export const bundledPluginInventory = \${JSON.stringify(installedEntry)};\\n\`,
  );
}
`;

const PACK_TARBALL_FIXTURE = `
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');
appendFileSync(resolve(repoRoot, 'gate-steps.log'), 'pack\\n');

const destFlagIndex = process.argv.indexOf('--dest-dir');
const destDir = destFlagIndex === -1 ? packageRoot : resolve(process.argv[destFlagIndex + 1]);
mkdirSync(destDir, { recursive: true });
const tarballName = execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--silent', '--ignore-scripts', '--pack-destination', destDir],
  { cwd: packageRoot, encoding: 'utf8', shell: process.platform === 'win32' },
).trim();
console.log(resolve(destDir, tarballName));
`;

function createGateSandbox() {
  const sandboxRoot = mkdtempSync(resolve(tmpdir(), 'happier-cli-publication-gate-'));
  const packageRoot = resolve(sandboxRoot, 'apps', 'cli');
  writeFile(resolve(sandboxRoot, 'package.json'), '{"private":true}\n');
  writeFile(resolve(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@happier-dev/cli',
    version: '0.0.0',
    happier: {
      managedRuntimePublication: {
        v: 1,
        mode: 'source-only',
        unavailableProviderRefs: [{
          pluginId: 'happier.provider.cliproxyapi',
          providerId: 'cliproxyapi',
        }],
      },
    },
    files: ['package.json', 'dist', 'package-dist'],
    dependencies: { [PLUGIN_PACKAGE_NAME]: '0.0.0' },
    bundledDependencies: [PLUGIN_PACKAGE_NAME],
  }, null, 2)}\n`);
  writeFile(resolve(packageRoot, 'scripts', 'buildSharedDeps.mjs'), SHARED_DEPS_FIXTURE);
  writeFile(resolve(packageRoot, 'scripts', 'build.mjs'), DIST_BUILD_FIXTURE);
  writeFile(resolve(packageRoot, 'scripts', 'packTarball.mjs'), PACK_TARBALL_FIXTURE);
  writeFile(resolve(sandboxRoot, 'gate-steps.log'), '');
  return { sandboxRoot, packageRoot };
}

function writePluginSource(sandboxRoot, marker) {
  writeFile(
    resolve(sandboxRoot, 'packages', 'plugins', 'grok', 'src', 'plugin.ts'),
    `export const grokPluginMarker = "${marker}";\n`,
  );
}

function publishLastGreenGeneration(sandboxRoot, packageRoot) {
  writePluginSource(sandboxRoot, 'last-green');
  execFileSync(process.execPath, [resolve(packageRoot, 'scripts', 'buildSharedDeps.mjs'), '--artifact'], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readGateSteps(sandboxRoot) {
  return readFileSync(resolve(sandboxRoot, 'gate-steps.log'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function resetGateSteps(sandboxRoot) {
  writeFile(resolve(sandboxRoot, 'gate-steps.log'), '');
}

function listPackedTarballs(sandboxRoot) {
  const packRoot = resolve(sandboxRoot, '.project', 'tmp', 'release-validation', 'cli-update-local-packs');
  const found = [];
  const visit = (absolutePath) => {
    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      const childPath = resolve(absolutePath, entry.name);
      if (entry.isDirectory()) visit(childPath);
      else if (entry.name.endsWith('.tgz')) found.push(childPath);
    }
  };
  try {
    visit(packRoot);
  } catch {
    return [];
  }
  return found.sort();
}

function readPackedEntry(tarballPath, entry) {
  return execFileSync('tar', ['-xzOf', tarballPath, entry], { encoding: 'utf8' });
}

/**
 * Real `execFileSync` for every gate step; only the downstream continuity e2e suite (which
 * needs a full product runtime) is stubbed, so the pack decision itself is never simulated.
 */
function createGateExec(observed) {
  return (command, args, options = {}) => {
    const first = String(args?.[0] ?? '');
    if (!first.endsWith('.mjs') && command !== 'tar') {
      observed.push('e2e');
      return '';
    }
    if (first.includes('run-vitest-with-heartbeat') || first.includes('packages/tests')) {
      observed.push('e2e');
      return '';
    }
    return execFileSync(command, args, options);
  };
}

test('the release-validation cli-update gate emits no tarball while an included plugin fails to build, then ships current source', () => {
  const { sandboxRoot, packageRoot } = createGateSandbox();
  try {
    publishLastGreenGeneration(sandboxRoot, packageRoot);
    resetGateSteps(sandboxRoot);

    // 1. Break the plugin. The gate must refuse before anything is packed.
    writePluginSource(sandboxRoot, 'FAIL_TO_COMPILE');
    const observed = [];
    assert.throws(() => runCliUpdateValidation({
      repoRoot: sandboxRoot,
      update: {
        from: { kind: 'published-channel', ref: 'preview' },
        to: { kind: 'local-build', ref: 'HEAD' },
      },
      exec: createGateExec(observed),
    }));
    assert.deepEqual(readGateSteps(sandboxRoot), ['shared-deps:artifact']);
    assert.deepEqual(listPackedTarballs(sandboxRoot), []);
    assert.equal(
      readFileSync(
        resolve(packageRoot, 'node_modules', '@happier-dev', 'plugins-grok', 'dist', 'index.js'),
        'utf8',
      ).includes('last-green'),
      true,
      'the retained last-green package is still installed; it simply cannot be published',
    );

    // 2. Repair the plugin. The packed tarball must carry a sentinel only current source can
    //    produce, and the packed dist must have been built after that regeneration.
    resetGateSteps(sandboxRoot);
    const sentinel = `grok-sentinel-${process.pid}-${Date.now()}`;
    writePluginSource(sandboxRoot, sentinel);
    runCliUpdateValidation({
      repoRoot: sandboxRoot,
      update: {
        from: { kind: 'published-channel', ref: 'preview' },
        to: { kind: 'local-build', ref: 'HEAD' },
      },
      exec: createGateExec([]),
    });
    assert.deepEqual(readGateSteps(sandboxRoot), ['shared-deps:artifact', 'dist', 'pack']);

    const tarballs = listPackedTarballs(sandboxRoot);
    assert.equal(tarballs.length, 1, `expected exactly one packed tarball, got ${tarballs.join(', ')}`);
    const packedPluginEntry = readPackedEntry(
      tarballs[0],
      `package/node_modules/${PLUGIN_PACKAGE_NAME}/dist/index.js`,
    );
    assert.match(packedPluginEntry, new RegExp(sentinel));
    assert.doesNotMatch(packedPluginEntry, /last-green/);
    assert.match(readPackedEntry(tarballs[0], 'package/dist/index.mjs'), new RegExp(sentinel));
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('a live shared build in the same gate sandbox packs stale plugin bytes', () => {
  // Discrimination: the assertions above are not satisfied by any publication order. This is
  // the exact wiring both gates carried before, driven through the same sandbox.
  const { sandboxRoot, packageRoot } = createGateSandbox();
  try {
    publishLastGreenGeneration(sandboxRoot, packageRoot);
    resetGateSteps(sandboxRoot);
    writePluginSource(sandboxRoot, 'FAIL_TO_COMPILE');

    execFileSync(process.execPath, [resolve(packageRoot, 'scripts', 'buildSharedDeps.mjs')], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync(process.execPath, [resolve(packageRoot, 'scripts', 'build.mjs')], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const destDir = resolve(sandboxRoot, 'live-pack');
    const tarballPath = execFileSync(
      process.execPath,
      [resolve(packageRoot, 'scripts', 'packTarball.mjs'), '--dest-dir', destDir],
      { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();

    assert.deepEqual(readGateSteps(sandboxRoot), ['shared-deps:live', 'dist', 'pack']);
    assert.match(
      readPackedEntry(tarballPath, `package/node_modules/${PLUGIN_PACKAGE_NAME}/dist/index.js`),
      /last-green/,
      'a live shared build packs the retained last-green bytes while current source does not compile',
    );
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('the CLI smoke gate emits no tarball while an included plugin fails to build', () => {
  const { sandboxRoot, packageRoot } = createGateSandbox();
  try {
    publishLastGreenGeneration(sandboxRoot, packageRoot);
    resetGateSteps(sandboxRoot);
    writePluginSource(sandboxRoot, 'FAIL_TO_COMPILE');

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, 'scripts', 'pipeline', 'smoke', 'cli-smoke.mjs')],
      {
        cwd: sandboxRoot,
        env: { ...process.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );

    assert.notEqual(result.status, 0, `expected the smoke gate to fail, got status ${result.status}`);
    assert.match(`${result.stdout}${result.stderr}`, /failed to compile/);
    assert.deepEqual(readGateSteps(sandboxRoot), ['shared-deps:artifact']);
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
