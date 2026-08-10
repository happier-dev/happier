import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const { channel, rollingTag } of [
  { channel: 'preview', rollingTag: 'server-preview' },
  { channel: 'dev', rollingTag: 'server-dev' },
]) {
  test(`pipeline CLI can publish server-runtime rolling release for ${channel} in dry-run`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'publish-server-runtime',
        '--channel',
        channel,
        '--allow-stable',
        'false',
        '--run-contracts',
        'false',
        '--check-installers',
        'false',
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, new RegExp(`\\[pipeline\\] server-runtime: channel=${channel} tag=${rollingTag}`));
    assert.match(out, /scripts\/pipeline\/release\/publish-server-runtime\.mjs/);
    // Manifests embed absolute GitHub release URLs; ensure we never emit a double-slash repo placeholder.
    assert.doesNotMatch(out, /https:\/\/github\.com\/\/releases\//);

    const wrapperSource = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs'), 'utf8');
    assert.match(wrapperSource, /publishing\/publish-binary-release\.mjs/);
  });
}

test('server runtime publisher exposes separate unsigned candidate build and authorized finalize modes', () => {
  const wrapperSource = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs'), 'utf8');
  const publisherSource = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publishing', 'publish-binary-release.mjs'), 'utf8');
  assert.match(publisherSource, /build-candidate/);
  assert.match(publisherSource, /finalize-candidate/);
  assert.match(publisherSource, /authorized-sha/);
  assert.match(publisherSource, /server-runtime-candidate\.mjs/);
  assert.match(wrapperSource, /publishing\/publish-binary-release\.mjs/);
});

test('server runtime version allocation runs before workspace dependencies are installed', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-server-release-preinstall-'));
  const loaderPath = join(fixtureDir, 'reject-workspace-imports.mjs');
  const githubOutputPath = join(fixtureDir, 'github-output.txt');
  writeFileSync(
    loaderPath,
    [
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier.startsWith('@happier-dev/')) {",
      "    throw new Error(`workspace dependency imported before install: ${specifier}`);",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      '',
    ].join('\n'),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-loader',
        loaderPath,
        resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs'),
        '--phase',
        'build-candidate',
        '--channel',
        'dev',
        '--base-version',
        '0.1.0',
        '--allow-stable',
        'false',
        '--run-contracts',
        'false',
        '--check-installers',
        'false',
        '--dry-run',
        '--github-output',
        githubOutputPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GITHUB_RUN_NUMBER: '217',
          GITHUB_RUN_ATTEMPT: '1',
          HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(fs.readFileSync(githubOutputPath, 'utf8'), /^version=0\.1\.0-dev\.\d+$/m);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('authorized server finalizer control scripts load without installed workspace dependencies', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-server-finalizer-preinstall-'));
  const loaderPath = join(fixtureDir, 'reject-workspace-imports.mjs');
  writeFileSync(
    loaderPath,
    [
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier.startsWith('@happier-dev/')) {",
      "    throw new Error(`workspace dependency imported in credentialed finalizer: ${specifier}`);",
      "  }",
      "  if (specifier.includes('ensureCliCommonDistModule.mjs')) {",
      "    throw new Error(`build-only CLI Common loader imported in credentialed finalizer: ${specifier}`);",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      '',
    ].join('\n'),
  );

  const scripts = [
    {
      path: resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publishing', 'prepare-binary-assets.mjs'),
      args: [],
      expectedFailure: /Unknown binary publish product/,
    },
    {
      path: resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-manifests.mjs'),
      args: [],
      expectedFailure: /--product is required/,
    },
    {
      path: resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs'),
      args: ['--artifacts-dir', fixtureDir],
      expectedFailure: /no checksums file found/,
    },
  ];

  try {
    for (const script of scripts) {
      const result = spawnSync(
        process.execPath,
        ['--experimental-loader', loaderPath, script.path, ...script.args],
        { cwd: repoRoot, env: process.env, encoding: 'utf8' },
      );
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      assert.doesNotMatch(
        output,
        /(workspace dependency|build-only CLI Common loader) imported in credentialed finalizer/,
        `${script.path} imported a workspace package before the finalizer could validate trusted artifacts`,
      );
      if (script.expectedFailure) {
        assert.notEqual(result.status, 0, `${script.path} unexpectedly completed without its required inputs`);
        assert.match(output, script.expectedFailure);
      } else {
        assert.equal(result.status, 0, output);
      }
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('authorized prepared-artifact finalization does not load build-only CLI Common code', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-server-finalizer-matrix-'));
  const artifactsDir = join(fixtureDir, 'artifacts');
  const loaderPath = join(fixtureDir, 'reject-build-dependencies.mjs');
  const runnerPath = join(fixtureDir, 'run-finalizer.mjs');
  const version = '0.2.10-dev.53';
  fs.mkdirSync(artifactsDir);
  for (const [os, arch] of [
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['windows', 'x64'],
  ]) {
    writeFileSync(join(artifactsDir, `happier-server-v${version}-${os}-${arch}.tar.gz`), `${os}-${arch}\n`);
  }
  writeFileSync(join(artifactsDir, 'darwin-arm64.server.json'), '{}\n');
  writeFileSync(join(artifactsDir, 'darwin-x64.server.json'), '{}\n');
  writeFileSync(
    loaderPath,
    [
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier.startsWith('@happier-dev/')) {",
      "    throw new Error(`workspace dependency imported in credentialed finalizer: ${specifier}`);",
      "  }",
      "  if (specifier.includes('ensureCliCommonDistModule.mjs')) {",
      "    throw new Error(`build-only CLI Common loader imported in credentialed finalizer: ${specifier}`);",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      '',
    ].join('\n'),
  );
  writeFileSync(
    runnerPath,
    [
      `import { finalizePreparedBinaryArtifacts } from ${JSON.stringify(new URL('../pipeline/release/publishing/prepare-binary-assets.mjs', import.meta.url).href)};`,
      `import { getBinaryPublishProductSpec } from ${JSON.stringify(new URL('../pipeline/release/publishing/product-specs.mjs', import.meta.url).href)};`,
      'await finalizePreparedBinaryArtifacts({',
      `  artifactsDir: ${JSON.stringify(artifactsDir)},`,
      "  productSpec: getBinaryPublishProductSpec('server'),",
      "  channel: 'dev',",
      `  version: ${JSON.stringify(version)},`,
      "  signFile: async ({ path }) => `${path}.minisig`,",
      '});',
      '',
    ].join('\n'),
  );

  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-loader', loaderPath, runnerPath],
      { cwd: repoRoot, env: process.env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
