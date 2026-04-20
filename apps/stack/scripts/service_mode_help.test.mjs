import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture as runNode } from './testkit/stack_script_command_testkit.mjs';
import { prependPathEntries } from './testkit/core/env_scope.mjs';

test('hstack service --help documents systemd mode flag', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const res = await runNode([join(rootDir, 'scripts', 'service.mjs'), '--help'], { cwd: rootDir, env: process.env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /--mode=system\|user/);
  assert.match(res.stdout, /--auth-now\b/, `expected help to mention --auth-now\nstdout:\n${res.stdout}`);
});

test('hstack service --help tolerates invalid mode values', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const res = await runNode([join(rootDir, 'scripts', 'service.mjs'), '--help', '--mode=not-a-mode'], {
    cwd: rootDir,
    env: process.env,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /hstack service/);
  assert.match(res.stdout, /--mode=system\|user/);
});

test('hstack service repair reconciles the service definition when confirmed', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-service-repair-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const fakeBinDir = join(tmp, 'bin');
  const fakeLaunchctlLogPath = join(tmp, 'launchctl.log');
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    join(fakeBinDir, 'launchctl'),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(fakeLaunchctlLogPath)}
exit 0
`,
    'utf-8',
  );
  await chmod(join(fakeBinDir, 'launchctl'), 0o755);

  const env = prependPathEntries(
    {
      ...process.env,
      HOME: tmp,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'stack-home'),
      HAPPIER_STACK_STORAGE_DIR: join(tmp, 'stacks'),
      HAPPIER_STACK_STACK: 'repair-test',
      HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1',
    },
    [fakeBinDir],
  );

  const res = await runNode([join(rootDir, 'scripts', 'service.mjs'), 'repair', '--yes', '--json'], {
    cwd: rootDir,
    env,
  });

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'repair');

  const plistPath = join(tmp, 'Library', 'LaunchAgents', 'dev.happier.stack.repair-test.plist');
  const plist = await readFile(plistPath, 'utf-8');
  assert.match(plist, /dev\.happier\.stack\.repair-test/);

  const launchctlLog = await readFile(fakeLaunchctlLogPath, 'utf-8');
  assert.match(launchctlLog, /^bootstrap gui\//m);
  assert.match(launchctlLog, /^kickstart -k gui\//m);
});
