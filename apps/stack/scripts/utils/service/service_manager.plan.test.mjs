import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planServiceAction, uninstallService } from './service_manager.mjs';

test('planServiceAction plans a systemd user install', () => {
  const plan = planServiceAction({
    backend: 'systemd-user',
    action: 'install',
    label: 'dev.happier.selfhost',
    definitionPath: '/home/me/.config/systemd/user/dev.happier.selfhost.service',
    definitionContents: '[Unit]\nDescription=x\n',
    persistent: true,
  });

  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].path, '/home/me/.config/systemd/user/dev.happier.selfhost.service');
  assert.ok(plan.commands.some((c) => c.cmd === 'systemctl' && c.args.includes('--user') && c.args.includes('daemon-reload')));
  assert.ok(plan.commands.some((c) => c.cmd === 'systemctl' && c.args.includes('--user') && c.args.includes('enable')));
});

test('planServiceAction plans a windows task install', () => {
  const plan = planServiceAction({
    backend: 'schtasks-user',
    action: 'install',
    label: 'dev.happier.selfhost',
    taskName: 'Happier\\dev.happier.selfhost',
    definitionPath: 'C:\\\\Users\\\\me\\\\.happier\\\\services\\\\dev.happier.selfhost.ps1',
    definitionContents: 'Set-Location -LiteralPath "C:\\\\Users\\\\me"',
    persistent: true,
  });

  assert.equal(plan.writes.length, 1);
  assert.ok(plan.commands.some((c) => c.cmd === 'schtasks' && c.args.includes('/Create')));
  assert.ok(plan.commands.some((c) => c.cmd === 'schtasks' && c.args.includes('/Run')));
});

test('uninstallService tears down a registered missing-plist launchd orphan by label', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-service-uninstall-launchd-orphan-'));
  const binDir = join(tempRoot, 'bin');
  const logPath = join(tempRoot, 'launchctl.log');
  const previousPath = process.env.PATH;
  const previousLog = process.env.HAPPIER_TEST_SERVICE_LOG;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousLog == null) delete process.env.HAPPIER_TEST_SERVICE_LOG;
    else process.env.HAPPIER_TEST_SERVICE_LOG = previousLog;
    await rm(tempRoot, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  const launchctlPath = join(binDir, 'launchctl');
  await writeFile(launchctlPath, '#!/bin/sh\necho "$*" >> "$HAPPIER_TEST_SERVICE_LOG"\nexit 0\n', 'utf8');
  await chmod(launchctlPath, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.HAPPIER_TEST_SERVICE_LOG = logPath;

  await uninstallService({
    platform: 'darwin',
    mode: 'user',
    homeDir: tempRoot,
    uid: 501,
    spec: { label: 'dev.happier.stack.orphan', programArgs: ['/tmp/hstack', 'start', '--restart'] },
  });

  const invocations = await readFile(logPath, 'utf8');
  assert.match(invocations, /print gui\/501\/dev\.happier\.stack\.orphan/);
  assert.match(invocations, /bootout gui\/501\/dev\.happier\.stack\.orphan/);
  assert.doesNotMatch(invocations, /\.plist/);
});

test('uninstallService preserves and reports a definition removal failure after proving registration absent', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-service-uninstall-rm-failure-'));
  const binDir = join(tempRoot, 'bin');
  const logPath = join(tempRoot, 'systemctl.log');
  const previousPath = process.env.PATH;
  const previousLog = process.env.HAPPIER_TEST_SERVICE_LOG;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousLog == null) delete process.env.HAPPIER_TEST_SERVICE_LOG;
    else process.env.HAPPIER_TEST_SERVICE_LOG = previousLog;
    await rm(tempRoot, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  const systemctlPath = join(binDir, 'systemctl');
  await writeFile(systemctlPath, '#!/bin/sh\necho "$*" >> "$HAPPIER_TEST_SERVICE_LOG"\necho "Unit dev.happier.stack.rm-failure.service could not be found." >&2\nexit 1\n', 'utf8');
  await chmod(systemctlPath, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.HAPPIER_TEST_SERVICE_LOG = logPath;
  const definitionPath = join(tempRoot, '.config', 'systemd', 'user', 'dev.happier.stack.rm-failure.service');
  await mkdir(definitionPath, { recursive: true });

  await assert.rejects(
    uninstallService({
      platform: 'linux',
      mode: 'user',
      homeDir: tempRoot,
      uid: 501,
      spec: { label: 'dev.happier.stack.rm-failure', programArgs: ['/tmp/hstack', 'start', '--restart'] },
    }),
    /directory|operation not permitted|is a directory|eisdir/i,
  );
  await access(definitionPath);
  const invocations = await readFile(logPath, 'utf8');
  assert.match(invocations, /--user show dev\.happier\.stack\.rm-failure\.service/);
  assert.doesNotMatch(invocations, /disable|daemon-reload/);
});
