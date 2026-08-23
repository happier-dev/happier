import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('production bump planning directs an unversioned exact candidate to materialize before final promotion', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-release-bump-plan-'));
  const bin = join(root, 'bin');
  const cliVersion = JSON.parse(readFileSync(join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8')).version;
  mkdirSync(bin);
  const git = join(bin, 'git');
  writeFileSync(
    git,
    `#!/bin/sh\nset -eu\nif [ "$1" = show ] && [ "$2" = origin/main:apps/cli/package.json ]; then printf '%s\\n' ${JSON.stringify(JSON.stringify({ version: cliVersion }))}; exit 0; fi\necho "unexpected git call: $*" >&2\nexit 2\n`,
    { mode: 0o755 },
  );
  chmodSync(git, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
        '--environment',
        'production',
        '--bump-preset',
        'none',
        '--deploy-targets',
        'cli',
        '--changed-ui',
        'false',
        '--changed-cli',
        'false',
        '--changed-stack',
        'false',
        '--changed-server',
        'false',
        '--changed-website',
        'false',
        '--changed-shared',
        'false',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /materialize and commit CHANGELOG and version changes.*bump=none/i);
    assert.doesNotMatch(result.stderr, /set bump/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a materialized final candidate resolves no new post-approval bump', () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'none',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'ui,cli,stack,server_runner',
      '--changed-ui',
      'true',
      '--changed-cli',
      'true',
      '--changed-stack',
      'true',
      '--changed-server',
      'true',
      '--changed-website',
      'true',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.deepEqual(
    {
      bump_app: parsed.bump_app,
      bump_cli: parsed.bump_cli,
      bump_stack: parsed.bump_stack,
      bump_server: parsed.bump_server,
      bump_website: parsed.bump_website,
    },
    {
      bump_app: 'none',
      bump_cli: 'none',
      bump_stack: 'none',
      bump_server: 'none',
      bump_website: 'none',
    },
  );
  assert.equal(parsed.should_bump, false);
});

test('resolve-bump-plan computes bump + publish flags from changed components and deploy_targets', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'none',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'ui,server,cli,stack',
      '--changed-ui',
      'true',
      '--changed-cli',
      'false',
      '--changed-stack',
      'true',
      '--changed-server',
      'false',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    publish_cli: true,
    publish_stack: true,
    publish_server: false,
    publish_plugin_sdk: false,
    publish_sdk: false,
    bump_app: 'patch',
    bump_cli: 'none',
    bump_stack: 'patch',
    bump_server: 'none',
    bump_website: 'none',
    bump_plugin_sdk: 'none',
    bump_sdk: 'none',
    should_bump: true,
  });
});

test('resolve-bump-plan only publishes server runner when deploy_targets includes server_runner', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'server',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'true',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.equal(parsed.publish_server, false);

  const out2 = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'server_runner',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'true',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const parsed2 = JSON.parse(out2);
  assert.equal(parsed2.publish_server, true);
});

test('resolve-bump-plan honors per-component versioned change inputs over global shared fanout', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'ui,cli,stack,server_runner',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'false',
      '--changed-website',
      'false',
      '--changed-shared',
      'true',
      '--versioned-app-changed',
      'false',
      '--versioned-cli-changed',
      'true',
      '--versioned-stack-changed',
      'false',
      '--versioned-server-changed',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    publish_cli: true,
    publish_stack: true,
    publish_server: true,
    publish_plugin_sdk: false,
    publish_sdk: false,
    bump_app: 'none',
    bump_cli: 'patch',
    bump_stack: 'none',
    bump_server: 'none',
    bump_website: 'none',
    bump_plugin_sdk: 'patch',
    bump_sdk: 'none',
    should_bump: true,
  });
});

test('resolve-bump-plan treats cli-common host-shared changes as cli and stack releases only', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'ui,cli,stack,server_runner',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'false',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
      '--changed-cli-stack-shared',
      'true',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    publish_cli: true,
    publish_stack: true,
    publish_server: true,
    publish_plugin_sdk: false,
    publish_sdk: false,
    bump_app: 'none',
    bump_cli: 'patch',
    bump_stack: 'patch',
    bump_server: 'none',
    bump_website: 'none',
    bump_plugin_sdk: 'none',
    bump_sdk: 'none',
    should_bump: true,
  });
});

test('resolve-bump-plan selects and versions both public SDK release components from their canonical changed inputs', () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'minor',
      '--deploy-targets',
      'plugin_sdk,sdk',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'false',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
      '--changed-plugin-sdk',
      'true',
      '--changed-sdk',
      'true',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.equal(parsed.publish_plugin_sdk, true);
  assert.equal(parsed.publish_sdk, true);
  assert.equal(parsed.bump_plugin_sdk, 'minor');
  assert.equal(parsed.bump_sdk, 'minor');
});
