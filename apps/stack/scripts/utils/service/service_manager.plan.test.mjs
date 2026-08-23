import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildServiceDefinition, planServiceAction, stopService, uninstallService } from './service_manager.mjs';

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

test('stopService passes the launchd definition path for persistent macOS services', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-service-stop-launchd-'));
  const binDir = join(tempRoot, 'bin');
  const logPath = join(tempRoot, 'launchctl.log');
  const previousPath = process.env.PATH;
  const previousLogPath = process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH;

  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousLogPath == null) {
      delete process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH;
    } else {
      process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH = previousLogPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(binDir, { recursive: true });
  const launchctlPath = join(binDir, 'launchctl');
  await writeFile(
    launchctlPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const logPath = process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH;",
      "if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(process.argv.slice(2))}\\n`, 'utf8');",
    ].join('\n'),
    'utf8',
  );
  await chmod(launchctlPath, 0o755);

  process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${previousPath ?? ''}`;
  process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH = logPath;

  await assert.doesNotReject(
    stopService({
      platform: 'darwin',
      mode: 'user',
      homeDir: tempRoot,
      spec: {
        label: 'dev.happier.selfhost',
        description: 'Happier test service',
        programArgs: ['/tmp/happier-server'],
        workingDirectory: tempRoot,
      },
      persistent: true,
      uid: 501,
    }),
  );

  const launchctlInvocations = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const bootoutInvocation = launchctlInvocations.find((args) => args[0] === 'bootout');

  assert.deepEqual(bootoutInvocation, [
    'bootout',
    'gui/501',
    join(tempRoot, 'Library', 'LaunchAgents', 'dev.happier.selfhost.plist'),
  ]);
});

test('uninstallService removes definitions only after backend-confirmed teardown', async (t) => {
  for (const { platform, command, mode, uid } of [
    { platform: 'linux', command: 'systemctl', mode: 'user', uid: 501 },
    { platform: 'darwin', command: 'launchctl', mode: 'user', uid: 501 },
    { platform: 'win32', command: 'powershell.exe', mode: 'user', uid: null },
  ]) {
    for (const outcome of ['absent', 'denied']) {
      // eslint-disable-next-line no-await-in-loop
      await t.test(`${command} ${outcome}`, async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), `happier-service-uninstall-${command}-`));
        const binDir = join(tempRoot, 'bin');
        const logPath = join(tempRoot, 'service-command.log');
        const previousPath = process.env.PATH;
        const previousLogPath = process.env.HAPPIER_TEST_SERVICE_LOG;
        try {
          await mkdir(binDir, { recursive: true });
          const commandPath = join(binDir, command);
          const behavior = outcome === 'denied'
            ? '#!/bin/sh\necho "Access is denied: Permission denied" >&2\nexit 1\n'
            : command === 'systemctl'
              ? '#!/bin/sh\ncase "$*" in *daemon-reload*) exit 0;; esac\necho "Unit dev.happier.stack.test.service does not exist." >&2\nexit 1\n'
              : command === 'launchctl'
                ? '#!/bin/sh\necho "Could not find specified service" >&2\nexit 1\n'
                : '#!/bin/sh\necho \'{"exists":false,"state":null,"lastTaskResult":null}\'\nexit 0\n';
          const script = behavior.replace('#!/bin/sh\n', '#!/bin/sh\necho "$*" >> "$HAPPIER_TEST_SERVICE_LOG"\n');
          await writeFile(commandPath, script, 'utf8');
          await chmod(commandPath, 0o755);
          process.env.PATH = `${binDir}:${previousPath ?? ''}`;
          process.env.HAPPIER_TEST_SERVICE_LOG = logPath;

          const spec = { label: 'dev.happier.stack.test', programArgs: ['/tmp/hstack', 'start', '--restart'] };
          const backend = platform === 'linux' ? 'systemd-user' : platform === 'darwin' ? 'launchd-user' : 'schtasks-user';
          const definition = buildServiceDefinition({ backend, homeDir: tempRoot, spec });
          await mkdir(dirname(definition.path), { recursive: true });
          await writeFile(definition.path, definition.contents, 'utf8');

          const operation = uninstallService({ platform, mode, homeDir: tempRoot, spec, uid });
          if (outcome === 'denied') {
            await assert.rejects(operation, /denied|permission|command failed/i);
            await access(definition.path);
          } else {
            await assert.doesNotReject(operation);
            await assert.rejects(access(definition.path));
            const invocations = await readFile(logPath, 'utf8');
            if (command === 'systemctl') {
              assert.match(invocations, /--user show dev\.happier\.stack\.test\.service/);
              assert.doesNotMatch(invocations, /disable|daemon-reload/);
            } else if (command === 'launchctl') {
              assert.match(invocations, /print gui\/501\/dev\.happier\.stack\.test/);
              assert.doesNotMatch(invocations, /bootout|disable|\.plist/);
            } else {
              assert.match(invocations, /Get-ScheduledTask/);
              assert.doesNotMatch(invocations, /Stop-ScheduledTask|Unregister-ScheduledTask/);
            }
          }
        } finally {
          process.env.PATH = previousPath;
          if (previousLogPath == null) delete process.env.HAPPIER_TEST_SERVICE_LOG;
          else process.env.HAPPIER_TEST_SERVICE_LOG = previousLogPath;
          await rm(tempRoot, { recursive: true, force: true });
        }
      });
    }
  }
});

test('uninstallService tears down a registered launchd orphan by label when its plist is missing', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-service-uninstall-launchd-orphan-'));
  const binDir = join(tempRoot, 'bin');
  const logPath = join(tempRoot, 'launchctl.log');
  const previousPath = process.env.PATH;
  const previousLogPath = process.env.HAPPIER_TEST_SERVICE_LOG;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousLogPath == null) delete process.env.HAPPIER_TEST_SERVICE_LOG;
    else process.env.HAPPIER_TEST_SERVICE_LOG = previousLogPath;
    await rm(tempRoot, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  const launchctlPath = join(binDir, 'launchctl');
  await writeFile(launchctlPath, '#!/bin/sh\necho "$*" >> "$HAPPIER_TEST_SERVICE_LOG"\nexit 0\n', 'utf8');
  await chmod(launchctlPath, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.HAPPIER_TEST_SERVICE_LOG = logPath;

  const spec = { label: 'dev.happier.stack.orphan', programArgs: ['/tmp/hstack', 'start', '--restart'] };
  await uninstallService({ platform: 'darwin', mode: 'user', homeDir: tempRoot, spec, uid: 501 });

  const invocations = await readFile(logPath, 'utf8');
  assert.match(invocations, /print gui\/501\/dev\.happier\.stack\.orphan/);
  assert.match(invocations, /bootout gui\/501\/dev\.happier\.stack\.orphan/);
  assert.match(invocations, /disable gui\/501\/dev\.happier\.stack\.orphan/);
  assert.doesNotMatch(invocations, /\.plist/);
});

test('uninstallService propagates stale definition removal failure after proving registration absent', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-service-uninstall-rm-failure-'));
  const binDir = join(tempRoot, 'bin');
  const previousPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previousPath;
    await rm(tempRoot, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  const systemctlPath = join(binDir, 'systemctl');
  await writeFile(systemctlPath, '#!/bin/sh\necho "Unit dev.happier.stack.rm-failure.service could not be found." >&2\nexit 1\n', 'utf8');
  await chmod(systemctlPath, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  const spec = { label: 'dev.happier.stack.rm-failure', programArgs: ['/tmp/hstack', 'start', '--restart'] };
  const definition = buildServiceDefinition({ backend: 'systemd-user', homeDir: tempRoot, spec });
  await mkdir(definition.path, { recursive: true });

  await assert.rejects(
    uninstallService({ platform: 'linux', mode: 'user', homeDir: tempRoot, spec, uid: 501 }),
    /directory|operation not permitted|is a directory|eisdir/i,
  );
  await access(definition.path);
});
