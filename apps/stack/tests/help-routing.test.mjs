import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function runHstack(args) {
  const testDir = resolve(fileURLToPath(import.meta.url), '..');
  const repoRoot = resolve(testDir, '..', '..', '..');
  const hstackBin = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');

  return spawnSync(process.execPath, [hstackBin, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_UPDATE_CHECK: '0',
    },
    encoding: 'utf8',
  });
}

function assertOutputContains(stdout, needle) {
  if (needle instanceof RegExp) {
    assert.match(stdout, needle);
    return;
  }
  assert.ok(stdout.includes(needle), `expected stdout to include ${JSON.stringify(needle)}\nstdout:\n${stdout}`);
}

function assertOutputExcludes(stdout, needle) {
  if (needle instanceof RegExp) {
    assert.doesNotMatch(stdout, needle);
    return;
  }
  assert.ok(!stdout.includes(needle), `expected stdout to exclude ${JSON.stringify(needle)}\nstdout:\n${stdout}`);
}

const helpScenarios = [
  {
    title: 'hstack stack -h prints stack root help',
    args: ['stack', '-h'],
    includes: [/\[stack\] usage:/, 'hstack stack build <name>', 'hstack stack new <name>'],
    excludes: [],
  },
  {
    title: 'hstack stack build -h prints build help (not root help)',
    args: ['stack', 'build', '-h'],
    includes: ['hstack stack build <name>', '--tauri'],
    excludes: ['hstack stack new <name>'],
  },
  {
    title: 'hstack stack test -h prints test help (not stack root help)',
    args: ['stack', 'test', '-h'],
    includes: ['[test] usage:', 'hstack test'],
    excludes: ['hstack stack new <name>'],
  },
  {
    title: 'hstack stack build <stack> -h prints build help (not root help)',
    args: ['stack', 'build', 'dev', '-h'],
    includes: ['hstack stack build <name>', '--tauri'],
    excludes: ['hstack stack new <name>'],
  },
  {
    title: 'hstack wt new -h prints new help (not root help)',
    args: ['wt', 'new', '-h'],
    includes: ['hstack wt new <slug>'],
    excludes: ['hstack wt sync'],
  },
  {
    title: 'hstack auth login -h prints login help (not root help)',
    args: ['auth', 'login', '-h'],
    includes: ['hstack auth login'],
    excludes: ['hstack auth status'],
  },
  {
    title: 'hstack tailscale enable -h prints enable help (not root help)',
    args: ['tailscale', 'enable', '-h'],
    includes: ['hstack tailscale enable'],
    excludes: ['hstack tailscale status'],
  },
  {
    title: 'hstack service status -h prints status help (not root help)',
    args: ['service', 'status', '-h'],
    includes: ['hstack service status'],
    excludes: ['hstack service install', 'hstack service uninstall'],
  },
  {
    title: 'hstack srv use -h prints use help (not root help)',
    args: ['srv', 'use', '-h'],
    includes: ['hstack srv use <happier-server-light|happier-server>'],
    excludes: ['hstack srv status'],
  },
  {
    title: 'hstack completion install -h prints install help (not root help)',
    args: ['completion', 'install', '-h'],
    includes: ['hstack completion install'],
    excludes: ['hstack completion print'],
  },
  {
    title: 'hstack self check -h prints check help (not root help)',
    args: ['self', 'check', '-h'],
    includes: ['hstack self check'],
    excludes: ['hstack self status'],
  },
  {
    title: 'hstack self-host -h prints self-host command help',
    args: ['self-host', '-h'],
    includes: ['hstack self-host install', 'hstack self-host status', 'hstack self-host update'],
    excludes: ['hstack self check'],
  },
  {
    title: 'hstack contrib sync -h prints sync help (not root help)',
    args: ['contrib', 'sync', '-h'],
    includes: ['hstack contrib sync'],
    excludes: ['hstack contrib status'],
  },
  {
    title: 'hstack menubar install -h prints install help (not root help)',
    args: ['menubar', 'install', '-h'],
    includes: ['hstack menubar install'],
    excludes: ['hstack menubar uninstall'],
  },
  {
    title: 'hstack monorepo port status -h prints status help (not root help)',
    args: ['monorepo', 'port', 'status', '-h'],
    includes: ['hstack monorepo port status'],
    excludes: ['hstack monorepo port guide'],
  },
];

for (const scenario of helpScenarios) {
  test(scenario.title, () => {
    const res = runHstack(scenario.args);
    assert.equal(res.status, 0);
    for (const needle of scenario.includes) assertOutputContains(res.stdout, needle);
    for (const needle of scenario.excludes) assertOutputExcludes(res.stdout, needle);
  });
}
