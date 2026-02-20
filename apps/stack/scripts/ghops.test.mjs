import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ghopsPath = fileURLToPath(new URL('./ghops.mjs', import.meta.url));
const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function runGhop(args, env = {}) {
  return spawnSync(process.execPath, [ghopsPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('prints help without requiring a token', () => {
  const res = runGhop(['--help'], {
    HAPPIER_GITHUB_BOT_TOKEN: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /HAPPIER_GITHUB_BOT_TOKEN/);
  assert.doesNotMatch(res.stdout, /\.project\//);
  assert.match(res.stdout, /\.happier\/local\/ghops\/gh/);
});

test('fails closed when token is missing', () => {
  const res = runGhop(['api', 'user'], {
    HAPPIER_GITHUB_BOT_TOKEN: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /HAPPIER_GITHUB_BOT_TOKEN/);
});

test('forwards args and forces gh auth via HAPPIER_GITHUB_BOT_TOKEN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-test-'));
  const fakeGh = join(dir, 'fake-gh');
  const configDir = join(dir, 'gh-config');

  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const payload = {
  argv: process.argv.slice(2),
  env: {
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED ?? null,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? null,
  },
};
process.stdout.write(JSON.stringify(payload));
`,
    'utf8',
  );
  chmodSync(fakeGh, 0o755);

  const token = 'test-bot-token';
  const res = runGhop(['api', 'repos/happier-dev/happier'], {
    HAPPIER_GITHUB_BOT_TOKEN: token,
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    HAPPIER_GHOPS_CONFIG_DIR: configDir,
    GH_TOKEN: 'personal-token-should-not-be-used',
  });

  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.argv, ['api', 'repos/happier-dev/happier']);
  assert.equal(out.env.GH_TOKEN, token);
  assert.equal(out.env.GH_PROMPT_DISABLED, '1');
  assert.equal(out.env.GH_CONFIG_DIR, configDir);
});
