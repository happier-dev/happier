import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('rolling version allocation uses the max published GitHub or npm version for a product channel', async () => {
  const { resolveRollingPublishVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const result = await resolveRollingPublishVersion({
    repoRoot,
    productId: 'cli',
    channel: 'publicdev',
    baseVersion: '0.2.6',
    env: {
      ...process.env,
      GITHUB_RUN_NUMBER: '16',
      GITHUB_RUN_ATTEMPT: '1',
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
        github: {
          cli: ['0.2.6-dev.125.1'],
        },
        npm: {
          '@happier-dev/cli': ['0.2.6-dev.1778098335.1'],
        },
      }),
    },
  });

  assert.equal(result.version, '0.2.6-dev.1778098336');
});

test('single-surface rolling version allocation catches up to the other published surface', async () => {
  const { resolveRollingPublishVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const result = await resolveRollingPublishVersion({
    repoRoot,
    productId: 'cli',
    channel: 'publicdev',
    baseVersion: '0.2.6',
    publishSurface: 'github',
    env: {
      ...process.env,
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
        github: { cli: ['0.2.6-dev.125.1'] },
        npm: { '@happier-dev/cli': ['0.2.6-dev.126.1'] },
      }),
    },
  });

  assert.equal(result.version, '0.2.6-dev.126.1');
});

test('single-surface rolling version allocation catches up when only the legacy retry segment is behind', async () => {
  const { resolveRollingPublishVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const result = await resolveRollingPublishVersion({
    repoRoot,
    productId: 'cli',
    channel: 'publicdev',
    baseVersion: '0.2.6',
    publishSurface: 'github',
    env: {
      ...process.env,
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
        github: { cli: ['0.2.6-dev.126'] },
        npm: { '@happier-dev/cli': ['0.2.6-dev.126.1'] },
      }),
    },
  });

  assert.equal(result.version, '0.2.6-dev.126.1');
});

test('new base rolling version allocation starts with a single sequence number', async () => {
  const { resolveRollingPublishVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const result = await resolveRollingPublishVersion({
    repoRoot,
    productId: 'cli',
    channel: 'publicdev',
    baseVersion: '0.2.7',
    env: {
      ...process.env,
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
    },
  });

  assert.equal(result.version, '0.2.7-dev.1');
});

test('explicit single-sequence rolling versions are accepted', async () => {
  const { resolveRollingPublishVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const result = await resolveRollingPublishVersion({
    repoRoot,
    productId: 'cli',
    channel: 'publicdev',
    baseVersion: '0.2.6',
    explicitVersion: '0.2.6-dev.127',
    publishSurface: 'github',
    env: {
      ...process.env,
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
        github: { cli: ['0.2.6-dev.125.1'] },
        npm: { '@happier-dev/cli': ['0.2.6-dev.126.1'] },
      }),
    },
  });

  assert.equal(result.version, '0.2.6-dev.127');
});

test('same-version rolling recovery derives identity from the latest immutable GitHub Release', async () => {
  const { resolveRollingRecoveryVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const recovery = await resolveRollingRecoveryVersion({
    repoRoot,
    productId: 'cli',
    channel: 'preview',
    explicitVersion: '0.2.1-preview.127',
    env: {
      ...process.env,
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
        github: { cli: ['cli-v0.2.1-preview.127'] },
        npm: {},
      }),
    },
  });

  assert.equal(recovery.version, '0.2.1-preview.127');
  assert.equal(recovery.source, 'github-release');
});

test('same-version rolling recovery rejects an older or cross-channel immutable Release', async () => {
  const { resolveRollingRecoveryVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');
  const env = {
    ...process.env,
    HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
      github: { cli: ['cli-v0.2.0-preview.99', 'cli-v0.2.1-preview.127', 'cli-v0.2.1'] },
      npm: {},
    }),
  };

  await assert.rejects(
    resolveRollingRecoveryVersion({
      repoRoot,
      productId: 'cli',
      channel: 'preview',
      explicitVersion: '0.2.0-preview.99',
      env,
    }),
    /latest recoverable.*0\.2\.1-preview\.127/i,
  );
  await assert.rejects(
    resolveRollingRecoveryVersion({
      repoRoot,
      productId: 'cli',
      channel: 'stable',
      explicitVersion: '0.2.1-preview.127',
      env,
    }),
    /does not match.*stable/i,
  );
});

test('stable version allocation ignores an empty explicit version override', async () => {
  const { resolveRollingPublishVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const result = await resolveRollingPublishVersion({
    repoRoot,
    productId: 'cli',
    channel: 'stable',
    baseVersion: '0.2.6',
    explicitVersion: '',
    env: {
      ...process.env,
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
    },
  });

  assert.equal(result.version, '0.2.6');
});

test('rolling version allocation merges remote git tags when GitHub release lookup is available but incomplete', async () => {
  const { resolveRollingPublishVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const root = join(tmpdir(), `happier-rolling-version-${process.pid}-${Date.now()}`);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');

  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'gh'), 0o755);

    git(root, ['init', '--bare', origin]);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'release-test@example.com']);
    git(repo, ['config', 'user.name', 'Release Test']);
    git(repo, ['remote', 'add', 'origin', origin]);
    git(repo, ['commit', '--allow-empty', '-m', 'seed']);
    git(repo, ['tag', 'cli-v99.99.99-dev.5']);
    git(repo, ['push', 'origin', 'HEAD', '--tags']);

    const result = await resolveRollingPublishVersion({
      repoRoot: repo,
      productId: 'cli',
      channel: 'publicdev',
      baseVersion: '99.99.99',
      publishSurface: 'github',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'happier-dev/happier',
        GH_REPO: 'happier-dev/happier',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(result.version, '99.99.99-dev.6');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('support preview version allocation uses published npm support versions', async () => {
  const { resolveRollingPublishVersion } = await import('../pipeline/release/lib/rolling-version-allocation.mjs');

  const result = await resolveRollingPublishVersion({
    repoRoot,
    productId: 'support',
    channel: 'preview',
    baseVersion: '0.1.5',
    publishSurface: 'npm',
    env: {
      ...process.env,
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
        github: {},
        npm: { '@happier-dev/support': ['0.1.5-preview.8'] },
      }),
    },
  });

  assert.equal(result.version, '0.1.5-preview.9');
});
