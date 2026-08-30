import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function createFakeBotAuthTools(dir) {
  const fakeGh = join(dir, 'fake-gh');
  const fakeSecurity = join(dir, 'security');
  const keychainStore = join(dir, 'keychain.json');

  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write((process.env.GHOPS_TEST_LOGIN || 'happier-bot') + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ argv: args, token: process.env.GH_TOKEN ?? null }));
`,
    'utf8',
  );
  chmodSync(fakeGh, 0o755);

  writeFileSync(
    fakeSecurity,
    `#!/usr/bin/env node
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const store = process.env.GHOPS_TEST_KEYCHAIN_STORE;
if (args[0] === 'find-generic-password') {
  if (!existsSync(store)) {
    process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n');
    process.exit(44);
  }
  process.stdout.write(readFileSync(store, 'utf8'));
  process.exit(0);
}
if (args[0] === 'add-generic-password') {
  const passwordIndex = args.indexOf('-w');
  writeFileSync(store, args[passwordIndex + 1], 'utf8');
  process.exit(0);
}
if (args[0] === 'delete-generic-password') {
  if (existsSync(store)) unlinkSync(store);
  process.exit(0);
}
process.exit(2);
`,
    'utf8',
  );
  chmodSync(fakeSecurity, 0o755);

  return { fakeGh, keychainStore };
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

test('forwards nested subcommand help to gh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-nested-help-test-'));
  const { fakeGh } = createFakeBotAuthTools(dir);

  const res = runGhop(['issue', 'edit', '--help'], {
    HAPPIER_GITHUB_BOT_TOKEN: 'nested-help-secret',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    GHOPS_TEST_LOGIN: 'happier-bot',
  });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).argv, ['issue', 'edit', '--help']);
});

test('rejects Git transport commands in favor of the current machine Git identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-git-command-rejection-test-'));
  const res = runGhop(['git', 'push', '--repo', 'happier-dev/happier'], {
    HAPPIER_STACK_STORAGE_DIR: join(dir, 'empty-stacks'),
    HAPPIER_STACK_STACK: 'ghops-no-targets',
    HAPPIER_GITHUB_BOT_TOKEN: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /does not perform Git commits or pushes/i);
  assert.match(res.stderr, /current machine/i);
  assert.doesNotMatch(res.stderr, /HAPPIER_GITHUB_BOT_TOKEN/);
});

test('fails closed when token is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-missing-token-test-'));
  const { keychainStore } = createFakeBotAuthTools(dir);
  const res = runGhop(['api', 'repos/happier-dev/happier'], {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GHOPS_TEST_KEYCHAIN_STORE: keychainStore,
    HAPPIER_GITHUB_BOT_TOKEN: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /HAPPIER_GITHUB_BOT_TOKEN/);
});

test('rejects an ordinary command when the token belongs to a different GitHub identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-command-wrong-user-test-'));
  const { fakeGh } = createFakeBotAuthTools(dir);
  const token = 'wrong-command-user-secret';

  const res = runGhop(['issue', 'list'], {
    HAPPIER_GITHUB_BOT_TOKEN: token,
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    GHOPS_TEST_LOGIN: 'not-happier-bot',
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not-happier-bot/);
  assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, new RegExp(token));
});

test('forwards args and forces gh auth via HAPPIER_GITHUB_BOT_TOKEN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-test-'));
  const fakeGh = join(dir, 'fake-gh');
  const configDir = join(dir, 'gh-config');

  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write((process.env.GHOPS_TEST_LOGIN || 'happier-bot') + '\\n');
  process.exit(0);
}
const payload = {
  argv: args,
  env: {
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    GH_HOST: process.env.GH_HOST ?? null,
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
    GH_HOST: 'attacker.invalid',
  });

  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.argv, ['api', 'repos/happier-dev/happier']);
  assert.equal(out.env.GH_TOKEN, token);
  assert.equal(out.env.GH_HOST, 'github.com');
  assert.equal(out.env.GH_PROMPT_DISABLED, '1');
  assert.equal(out.env.GH_CONFIG_DIR, configDir);
});

test('expands ~/ overrides for gh binary and config dir against HOME', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-home-test-'));
  const homeDir = join(dir, 'home');
  const fakeGh = join(homeDir, 'bin', 'fake-gh');
  const configDir = join(homeDir, 'gh-config');
  mkdirSync(join(homeDir, 'bin'), { recursive: true });

  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write((process.env.GHOPS_TEST_LOGIN || 'happier-bot') + '\\n');
  process.exit(0);
}
const payload = {
  argv: args,
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
    HOME: homeDir,
    USERPROFILE: homeDir,
    HAPPIER_GITHUB_BOT_TOKEN: token,
    HAPPIER_GHOPS_GH_PATH: '~/bin/fake-gh',
    HAPPIER_GHOPS_CONFIG_DIR: '~/gh-config',
  });

  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.argv, ['api', 'repos/happier-dev/happier']);
  assert.equal(out.env.GH_TOKEN, token);
  assert.equal(out.env.GH_PROMPT_DISABLED, '1');
  assert.equal(out.env.GH_CONFIG_DIR, configDir);
});

test('falls back to the happier-bot macOS Keychain token when the environment override is absent', {
  skip: process.platform !== 'darwin',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-keychain-test-'));
  const { fakeGh, keychainStore } = createFakeBotAuthTools(dir);
  const keychainToken = 'keychain-bot-token';
  writeFileSync(keychainStore, JSON.stringify({ HAPPIER_GITHUB_BOT_TOKEN: keychainToken }), 'utf8');

  const res = runGhop(['api', 'repos/happier-dev/happier'], {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GHOPS_TEST_KEYCHAIN_STORE: keychainStore,
    HAPPIER_GITHUB_BOT_TOKEN: '',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    GH_TOKEN: 'personal-token-should-not-be-used',
    GITHUB_TOKEN: 'personal-token-should-not-be-used',
  });

  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.token, keychainToken);
});

test('auth store validates happier-bot before persisting and never prints the token', {
  skip: process.platform !== 'darwin',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-store-test-'));
  const { fakeGh, keychainStore } = createFakeBotAuthTools(dir);
  const token = 'store-me-secretly';

  const res = runGhop(['auth', 'store'], {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GHOPS_TEST_KEYCHAIN_STORE: keychainStore,
    HAPPIER_GITHUB_BOT_TOKEN: token,
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    GHOPS_TEST_LOGIN: 'happier-bot',
  });

  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(readFileSync(keychainStore, 'utf8')).HAPPIER_GITHUB_BOT_TOKEN, token);
  assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, new RegExp(token));
  assert.match(res.stdout, /happier-bot/);
});

test('auth store rejects a token for a different GitHub identity without persisting it', {
  skip: process.platform !== 'darwin',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-store-wrong-user-test-'));
  const { fakeGh, keychainStore } = createFakeBotAuthTools(dir);
  const token = 'wrong-user-secret';

  const res = runGhop(['auth', 'store'], {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GHOPS_TEST_KEYCHAIN_STORE: keychainStore,
    HAPPIER_GITHUB_BOT_TOKEN: token,
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    GHOPS_TEST_LOGIN: 'not-happier-bot',
  });

  assert.notEqual(res.status, 0);
  assert.equal(existsSync(keychainStore), false);
  assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, new RegExp(token));
  assert.match(res.stderr, /not-happier-bot/);
});

test('auth status reports the validated identity and credential source without printing the token', {
  skip: process.platform !== 'darwin',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-status-test-'));
  const { fakeGh, keychainStore } = createFakeBotAuthTools(dir);
  const token = 'status-secret';
  writeFileSync(keychainStore, JSON.stringify({ HAPPIER_GITHUB_BOT_TOKEN: token }), 'utf8');

  const res = runGhop(['auth', 'status'], {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GHOPS_TEST_KEYCHAIN_STORE: keychainStore,
    HAPPIER_GITHUB_BOT_TOKEN: '',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /happier-bot/);
  assert.match(res.stdout, /keychain/i);
  assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, new RegExp(token));
});

test('auth clear removes only the stored Keychain token', {
  skip: process.platform !== 'darwin',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-clear-test-'));
  const { fakeGh, keychainStore } = createFakeBotAuthTools(dir);
  writeFileSync(keychainStore, JSON.stringify({ HAPPIER_GITHUB_BOT_TOKEN: 'clear-secret' }), 'utf8');

  const res = runGhop(['auth', 'clear'], {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GHOPS_TEST_KEYCHAIN_STORE: keychainStore,
    HAPPIER_GITHUB_BOT_TOKEN: '',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(keychainStore), false);
  assert.match(res.stdout, /removed/i);
});
