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

function createFakeGitPushTool(dir, { remoteTarget = 'refs/heads/pr-123' } = {}) {
  const fakeGit = join(dir, 'fake-git');
  const gitLog = join(dir, 'git-log.jsonl');
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const args = process.argv.slice(2);
const config = Object.fromEntries(Array.from({ length: Number(process.env.GIT_CONFIG_COUNT || 0) }, (_, index) => [
  process.env['GIT_CONFIG_KEY_' + index],
  process.env['GIT_CONFIG_VALUE_' + index],
]));
appendFileSync(process.env.GHOPS_TEST_GIT_LOG, JSON.stringify({
  args,
  config,
  hooksPathExists: existsSync(config['core.hooksPath'] || ''),
}) + '\\n');
if (args[0] === 'rev-parse') process.stdout.write(process.env.GHOPS_TEST_LOCAL_SHA + '\\n');
if (args[0] === 'ls-remote') process.stdout.write((process.env.GHOPS_TEST_REMOTE_SHA || process.env.GHOPS_TEST_LOCAL_SHA) + '\\t${remoteTarget}\\n');
`,
    'utf8',
  );
  chmodSync(fakeGit, 0o755);
  return { fakeGit, gitLog };
}

function createMacHostCredentialFixture(dir, { token = 'mac-host-keychain-token' } = {}) {
  const storageDir = join(dir, 'stacks');
  const stackName = 'ghops-managed-vm';
  const stackDir = join(storageDir, stackName);
  const sshConfigFile = join(dir, 'mac-host.ssh.config');
  const fakeSsh = join(dir, 'ssh');
  const sshLog = join(dir, 'ssh-log.jsonl');
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(sshConfigFile, 'Host happier-dev-target-mac-host\n  HostName 127.0.0.1\n', 'utf8');
  writeFileSync(join(stackDir, 'dev-targets.json'), JSON.stringify({
    version: 2,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'happier-dev-target-mac-host',
      sshConfigFile,
      repoDir: '/Users/test/.happier-stack/workspace-mirror/0.2',
      cliHomeDir: '/Users/test/.happier/stacks/ghops-managed-vm/cli',
    }],
    runtimePlacement: {},
  }), 'utf8');
  writeFileSync(
    fakeSsh,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
appendFileSync(process.env.GHOPS_TEST_SSH_LOG, JSON.stringify({ args, input }) + '\\n');
if (process.env.GHOPS_TEST_SSH_FAIL === '1') {
  process.stderr.write('host credential route unavailable\\n');
  process.exit(255);
}
process.stdout.write(JSON.stringify({
  version: 1,
  ok: true,
  credential: { HAPPIER_GITHUB_BOT_TOKEN: process.env.GHOPS_TEST_MAC_HOST_TOKEN },
}) + '\\n');
});
`,
    'utf8',
  );
  chmodSync(fakeSsh, 0o755);
  return {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      GHOPS_TEST_MAC_HOST_TOKEN: token,
      GHOPS_TEST_SSH_LOG: sshLog,
    },
    sshConfigFile,
    sshLog,
    token,
  };
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

test('pushes one explicit branch ref as happier-bot without exposing the token in argv or output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-git-push-test-'));
  const { fakeGh } = createFakeBotAuthTools(dir);
  const { fakeGit, gitLog } = createFakeGitPushTool(dir);
  const localSha = '1111111111111111111111111111111111111111';
  const token = 'git-push-bot-secret';

  const res = runGhop([
    'git',
    'push',
    '--repo',
    'happier-dev/happier',
    '--source',
    'HEAD',
    '--target',
    'refs/heads/pr-123',
  ], {
    HAPPIER_GITHUB_BOT_TOKEN: token,
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    HAPPIER_GHOPS_GIT_PATH: fakeGit,
    GHOPS_TEST_GIT_LOG: gitLog,
    GHOPS_TEST_LOCAL_SHA: localSha,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, new RegExp(token));
  const calls = readFileSync(gitLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const push = calls.find((call) => call.args[0] === 'push');
  assert.ok(push);
  assert.deepEqual(push.args, [
    'push',
    'https://github.com/happier-dev/happier.git',
    `${localSha}:refs/heads/pr-123`,
  ]);
  assert.doesNotMatch(JSON.stringify(push.args), new RegExp(token));
  assert.equal(push.config['http.extraHeader'], '');
  assert.match(push.config['http.https://github.com/.extraHeader'], /^Authorization: Basic /);
  assert.doesNotMatch(push.config['http.https://github.com/.extraHeader'], new RegExp(token));
  assert.equal(push.hooksPathExists, true);
  assert.equal(existsSync(push.config['core.hooksPath']), false);
  assert.match(res.stdout, new RegExp(`${localSha}.*refs/heads/pr-123`));
});

test('uses an exact force-with-lease when a foreign PR rebase push is explicitly authorized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-git-rebase-push-test-'));
  const { fakeGh } = createFakeBotAuthTools(dir);
  const { fakeGit, gitLog } = createFakeGitPushTool(dir);
  const localSha = '2222222222222222222222222222222222222222';
  const expectedRemoteSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const res = runGhop([
    'git',
    'push',
    '--repo',
    'happier-dev/happier',
    '--source',
    'HEAD',
    '--target',
    'refs/heads/pr-123',
    '--force-with-lease',
    expectedRemoteSha,
  ], {
    HAPPIER_GITHUB_BOT_TOKEN: 'rebase-push-secret',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    HAPPIER_GHOPS_GIT_PATH: fakeGit,
    GHOPS_TEST_GIT_LOG: gitLog,
    GHOPS_TEST_LOCAL_SHA: localSha,
  });

  assert.equal(res.status, 0, res.stderr);
  const calls = readFileSync(gitLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const push = calls.find((call) => call.args[0] === 'push');
  assert.deepEqual(push.args, [
    'push',
    `--force-with-lease=refs/heads/pr-123:${expectedRemoteSha}`,
    'https://github.com/happier-dev/happier.git',
    `${localSha}:refs/heads/pr-123`,
  ]);
});

test('fails closed when the pushed remote branch does not resolve to the intended commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-git-push-verification-test-'));
  const { fakeGh } = createFakeBotAuthTools(dir);
  const { fakeGit, gitLog } = createFakeGitPushTool(dir);
  const intendedSha = '3333333333333333333333333333333333333333';
  const observedSha = '4444444444444444444444444444444444444444';

  const res = runGhop([
    'git',
    'push',
    '--repo',
    'happier-dev/happier',
    '--source',
    'HEAD',
    '--target',
    'refs/heads/pr-123',
  ], {
    HAPPIER_GITHUB_BOT_TOKEN: 'verification-secret',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    HAPPIER_GHOPS_GIT_PATH: fakeGit,
    GHOPS_TEST_GIT_LOG: gitLog,
    GHOPS_TEST_LOCAL_SHA: intendedSha,
    GHOPS_TEST_REMOTE_SHA: observedSha,
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, new RegExp(`did not resolve to ${intendedSha}`));
  assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /verification-secret/);
});

test('fails closed when token is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-missing-token-test-'));
  const { keychainStore } = createFakeBotAuthTools(dir);
  const res = runGhop(['api', 'repos/happier-dev/happier'], {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GHOPS_TEST_KEYCHAIN_STORE: keychainStore,
    HAPPIER_STACK_STORAGE_DIR: join(dir, 'empty-stacks'),
    HAPPIER_STACK_STACK: 'ghops-no-targets',
    HAPPIER_GITHUB_BOT_TOKEN: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /HAPPIER_GITHUB_BOT_TOKEN/);
});

test('uses the execution-host credential broker when the VM has no environment token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-mac-host-token-test-'));
  const { fakeGh } = createFakeBotAuthTools(dir);
  const fixture = createMacHostCredentialFixture(dir);

  const res = runGhop(['api', 'repos/happier-dev/happier'], {
    ...fixture.env,
    HAPPIER_GITHUB_BOT_TOKEN: '',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    GH_TOKEN: 'personal-token-should-not-be-used',
    GITHUB_TOKEN: 'personal-token-should-not-be-used',
  });

  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).token, fixture.token);
  const { args: sshArgs, input } = JSON.parse(readFileSync(fixture.sshLog, 'utf8').trim());
  assert.deepEqual(sshArgs.slice(0, 3), ['-T', '-F', fixture.sshConfigFile]);
  assert.ok(sshArgs.includes('happier-dev-target-mac-host'));
  assert.match(sshArgs.at(-1), /happier-ghops-brokers-/);
  assert.match(sshArgs.at(-1), /\/usr\/bin\/nc -U/);
  assert.deepEqual(JSON.parse(input), { version: 1, operation: 'read-ghops-credential' });
});

test('keeps bot Git pushes on the authoritative checkout when the credential comes from mac-host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-mac-host-git-push-test-'));
  const { fakeGh } = createFakeBotAuthTools(dir);
  const { fakeGit, gitLog } = createFakeGitPushTool(dir);
  const fixture = createMacHostCredentialFixture(dir, { token: 'mac-host-git-push-token' });
  const localSha = '5555555555555555555555555555555555555555';

  const res = runGhop([
    'git',
    'push',
    '--repo',
    'happier-dev/happier',
    '--source',
    'HEAD',
    '--target',
    'refs/heads/pr-123',
  ], {
    ...fixture.env,
    HAPPIER_GITHUB_BOT_TOKEN: '',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    HAPPIER_GHOPS_GIT_PATH: fakeGit,
    GHOPS_TEST_GIT_LOG: gitLog,
    GHOPS_TEST_LOCAL_SHA: localSha,
  });

  assert.equal(res.status, 0, res.stderr);
  const gitCalls = readFileSync(gitLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(gitCalls.some((call) => call.args[0] === 'push'));
  assert.equal(readFileSync(fixture.sshLog, 'utf8').trim().split('\n').length, 1);
});

test('fails closed when the configured mac-host credential route is unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghops-mac-host-unavailable-test-'));
  const { fakeGh } = createFakeBotAuthTools(dir);
  const fixture = createMacHostCredentialFixture(dir);

  const res = runGhop(['api', 'repos/happier-dev/happier'], {
    ...fixture.env,
    GHOPS_TEST_SSH_FAIL: '1',
    HAPPIER_GITHUB_BOT_TOKEN: '',
    HAPPIER_GHOPS_GH_PATH: fakeGh,
    GH_TOKEN: 'personal-token-should-not-be-used',
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /mac-host.*credential/i);
  assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /personal-token-should-not-be-used/);
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
