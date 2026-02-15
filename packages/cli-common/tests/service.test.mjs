import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveServiceBackend,
  buildServiceDefinition,
  planServiceAction,
  renderSystemdServiceUnit,
  renderWindowsScheduledTaskWrapperPs1,
  buildLaunchdPlistXml,
  applyServicePlan,
} from '../dist/service/index.js';

test('resolveServiceBackend selects platform backend by mode', () => {
  assert.equal(resolveServiceBackend({ platform: 'linux', mode: 'user' }), 'systemd-user');
  assert.equal(resolveServiceBackend({ platform: 'linux', mode: 'system' }), 'systemd-system');
  assert.equal(resolveServiceBackend({ platform: 'darwin', mode: 'user' }), 'launchd-user');
  assert.equal(resolveServiceBackend({ platform: 'darwin', mode: 'system' }), 'launchd-system');
  assert.equal(resolveServiceBackend({ platform: 'win32', mode: 'user' }), 'schtasks-user');
  assert.equal(resolveServiceBackend({ platform: 'win32', mode: 'system' }), 'schtasks-system');
});

test('renderSystemdServiceUnit includes User= when runAsUser is set', () => {
  const unit = renderSystemdServiceUnit({
    description: 'Happier Test',
    execStart: '/opt/happier/bin/hstack start',
    workingDirectory: '%h',
    env: { PORT: '3005' },
    restart: 'always',
    runAsUser: 'happier',
    stdoutPath: '/var/log/happier/test.out.log',
    stderrPath: '/var/log/happier/test.err.log',
    wantedBy: 'multi-user.target',
  });
  assert.match(unit, /\nUser=happier\n/);
  assert.match(unit, /Environment=PORT=3005/);
  assert.match(unit, /WantedBy=multi-user\.target/);
});

test('renderWindowsScheduledTaskWrapperPs1 sets env and runs program args', () => {
  const ps1 = renderWindowsScheduledTaskWrapperPs1({
    workingDirectory: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host',
    programArgs: ['C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\bin\\\\happier-server.exe', '--port', '3005'],
    env: { PORT: '3005' },
    stdoutPath: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\logs\\\\out.log',
    stderrPath: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\logs\\\\err.log',
  });
  assert.match(ps1, /\$env:PORT = "3005"/);
  assert.match(ps1, /Set-Location -LiteralPath/);
  assert.match(ps1, /happier-server\.exe/);
});

test('buildLaunchdPlistXml includes StartInterval when provided', () => {
  const plist = buildLaunchdPlistXml({
    label: 'dev.happier.timer',
    programArgs: ['/usr/bin/true'],
    env: {},
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/err.log',
    workingDirectory: '/tmp',
    keepAliveOnFailure: false,
    startIntervalSec: 3600,
  });
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
});

test('buildServiceDefinition writes expected service definition paths', () => {
  const linux = buildServiceDefinition({
    backend: 'systemd-user',
    homeDir: '/home/me',
    spec: {
      label: 'dev.happier.test',
      description: 'Happier Test',
      programArgs: ['/home/me/.happier/bin/happier'],
      workingDirectory: '/home/me/.happier',
      env: { PORT: '3005' },
    },
  });
  assert.equal(linux.path, '/home/me/.config/systemd/user/dev.happier.test.service');

  const mac = buildServiceDefinition({
    backend: 'launchd-user',
    homeDir: '/Users/me',
    spec: {
      label: 'dev.happier.test',
      description: 'Happier Test',
      programArgs: ['/Users/me/.happier/bin/happier'],
      workingDirectory: '/Users/me/.happier',
      env: { PORT: '3005' },
      stdoutPath: '/Users/me/.happier/logs/out.log',
      stderrPath: '/Users/me/.happier/logs/err.log',
    },
  });
  assert.equal(mac.path, '/Users/me/Library/LaunchAgents/dev.happier.test.plist');
  assert.match(mac.contents, /<key>Label<\/key>/);

  const win = buildServiceDefinition({
    backend: 'schtasks-user',
    homeDir: 'C:\\\\Users\\\\me',
    spec: {
      label: 'dev.happier.test',
      description: 'Happier Test',
      programArgs: ['C:\\\\Users\\\\me\\\\.happier\\\\bin\\\\happier.exe'],
      workingDirectory: 'C:\\\\Users\\\\me\\\\.happier',
      env: { PORT: '3005' },
    },
  });
  assert.match(win.path, /dev\.happier\.test\.ps1$/);
});

test('planServiceAction uses ONSTART for system scheduled tasks', () => {
  const plan = planServiceAction({
    backend: 'schtasks-system',
    action: 'install',
    label: 'dev.happier.test',
    definitionPath: 'C:\\\\ProgramData\\\\happier\\\\services\\\\dev.happier.test.ps1',
    definitionContents: 'Write-Host test',
    taskName: 'Happier\\\\dev.happier.test',
    persistent: true,
  });
  const create = plan.commands.find((c) => c.cmd === 'schtasks');
  assert.ok(create);
  assert.equal(create.args.includes('ONSTART'), true);
  assert.equal(create.args.includes('SYSTEM'), true);
});

test('applyServicePlan throws when a required command is missing', async () => {
  await assert.rejects(
    () => applyServicePlan({ writes: [], commands: [{ cmd: '__happier_missing_cmd__', args: [] }] }),
    /missing|not found|Unsupported|command/i
  );
});

test('applyServicePlan throws when a command exits non-zero (unless allowFail)', async () => {
  await assert.rejects(
    () => applyServicePlan({ writes: [], commands: [{ cmd: process.execPath, args: ['-e', 'process.exit(2)'] }] }),
    /exit|non-zero|failed/i
  );

  await applyServicePlan({
    writes: [],
    commands: [{ cmd: process.execPath, args: ['-e', 'process.exit(2)'], allowFail: true }],
  });
});
