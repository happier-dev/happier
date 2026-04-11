import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    killMode: 'process',
    runAsUser: 'happier',
    stdoutPath: '/var/log/happier/test.out.log',
    stderrPath: '/var/log/happier/test.err.log',
    wantedBy: 'multi-user.target',
  });
  assert.match(unit, /\nUser=happier\n/);
  assert.match(unit, /\nKillMode=process\n/);
  assert.match(unit, /Environment=PORT=3005/);
  assert.match(unit, /WantedBy=multi-user\.target/);
});

test('renderSystemdServiceUnit rejects newline injection in header fields', () => {
  assert.throws(
    () =>
      renderSystemdServiceUnit({
        description: 'Happier Test\nInjected',
        execStart: '/bin/true',
      }),
    /newline|newlines|must not/i,
  );

  assert.throws(
    () =>
      renderSystemdServiceUnit({
        description: 'Happier Test',
        execStart: '/bin/true',
        wantedBy: 'default.target\nInjected',
      }),
    /newline|newlines|must not/i,
  );
});

test('renderSystemdServiceUnit escapes percent signs in ExecStart args', () => {
  const unit = renderSystemdServiceUnit({
    description: 'Happier Test',
    execStart: ['/bin/echo', '100%'],
  });
  assert.match(unit, /ExecStart=.*\s100%%\n/);
});

test('planServiceAction restarts systemd services after install instead of relying on enable --now', () => {
  const plan = planServiceAction({
    backend: 'systemd-user',
    action: 'install',
    label: 'dev.happier.test',
    definitionPath: '/home/me/.config/systemd/user/dev.happier.test.service',
    definitionContents: '[Unit]\nDescription=Happier Test\n',
    persistent: true,
  });

  const argsText = plan.commands.map((command) => `${command.cmd} ${command.args.join(' ')}`).join('\n');
  assert.match(argsText, /systemctl --user daemon-reload/);
  assert.match(argsText, /systemctl --user enable dev\.happier\.test\.service/);
  assert.match(argsText, /systemctl --user restart dev\.happier\.test\.service/);
  assert.doesNotMatch(argsText, /enable --now/);
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

test('buildLaunchdPlistXml includes StartCalendarInterval when provided', () => {
  const plist = buildLaunchdPlistXml({
    label: 'dev.happier.daily',
    programArgs: ['/usr/bin/true'],
    env: {},
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/err.log',
    workingDirectory: '/tmp',
    keepAliveOnFailure: false,
    startCalendarInterval: { hour: 3, minute: 15 },
  });
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>3<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>15<\/integer>/);
  assert.doesNotMatch(plist, /<key>StartInterval<\/key>/);
});

test('buildLaunchdPlistXml uses KeepAlive SuccessfulExit=false by default', () => {
  const plist = buildLaunchdPlistXml({
    label: 'dev.happier.stack',
    programArgs: ['/usr/bin/true'],
    env: {},
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/err.log',
    workingDirectory: '/tmp',
  });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
});

test('buildLaunchdPlistXml optionally abandons process-group cleanup', () => {
  const plist = buildLaunchdPlistXml({
    label: 'dev.happier.stack',
    programArgs: ['/usr/bin/true'],
    env: {},
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/err.log',
    workingDirectory: '/tmp',
    abandonProcessGroup: true,
  });
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
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

test('buildServiceDefinition injects PATH from the service target executable rather than the installer runtime', () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '/custom/tools:/usr/bin:/bin';
  try {
    const def = buildServiceDefinition({
      backend: 'launchd-user',
      homeDir: '/Users/me',
      spec: {
        label: 'dev.happier.test',
        description: 'Happier Test',
        programArgs: ['/Users/me/.happier-stack/bin/hstack', 'start'],
        workingDirectory: '/Users/me/.happier',
        env: { PORT: '3005' },
        stdoutPath: '/Users/me/.happier/logs/out.log',
        stderrPath: '/Users/me/.happier/logs/err.log',
      },
    });

    assert.match(def.contents, /<key>PATH<\/key>/);
    assert.match(def.contents, /\/Users\/me\/\.happier-stack\/bin:\/custom\/tools:\/usr\/bin:\/bin/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('buildServiceDefinition injects PATH into non-launchd service definitions when callers omit it', () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '/custom/tools:/usr/bin:/bin';
  try {
    const linux = buildServiceDefinition({
      backend: 'systemd-user',
      homeDir: '/home/me',
      spec: {
        label: 'dev.happier.test',
        description: 'Happier Test',
        programArgs: ['/home/me/.happier-stack/bin/hstack', 'start'],
        workingDirectory: '/home/me/.happier',
        env: { PORT: '3005' },
      },
    });
    assert.match(linux.contents, /Environment=PATH=\/home\/me\/\.happier-stack\/bin:\/custom\/tools:\/usr\/bin:\/bin/);

    process.env.PATH = 'C:\\\\custom\\\\tools;C:\\\\Windows\\\\System32';
    const win = buildServiceDefinition({
      backend: 'schtasks-user',
      homeDir: 'C:\\\\Users\\\\me',
      spec: {
        label: 'dev.happier.test',
        description: 'Happier Test',
        programArgs: ['C:\\\\Users\\\\me\\\\.happier-stack\\\\bin\\\\hstack.cmd', 'start'],
        workingDirectory: 'C:\\\\Users\\\\me\\\\.happier',
        env: { PORT: '3005' },
      },
    });
    assert.match(win.contents, /\$env:Path = "C:\\\\Users\\\\me\\\\\.happier-stack\\\\bin\\;C:\\\\custom\\\\tools;C:\\\\Windows\\\\System32/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('buildServiceDefinition normalizes lowercase path env keys to PATH on posix services', () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '/custom/tools:/usr/bin:/bin';
  try {
    const mac = buildServiceDefinition({
      backend: 'launchd-user',
      homeDir: '/Users/me',
      spec: {
        label: 'dev.happier.test',
        description: 'Happier Test',
        programArgs: ['/Users/me/.happier-stack/bin/hstack', 'start'],
        workingDirectory: '/Users/me/.happier',
        env: { path: '/shadow/bin', PORT: '3005' },
        stdoutPath: '/Users/me/.happier/logs/out.log',
        stderrPath: '/Users/me/.happier/logs/err.log',
      },
    });
    assert.match(mac.contents, /<key>PATH<\/key>/);
    assert.match(mac.contents, /\/shadow\/bin/);
    assert.doesNotMatch(mac.contents, /<key>path<\/key>/);

    const linux = buildServiceDefinition({
      backend: 'systemd-user',
      homeDir: '/home/me',
      spec: {
        label: 'dev.happier.test',
        description: 'Happier Test',
        programArgs: ['/home/me/.happier-stack/bin/hstack', 'start'],
        workingDirectory: '/home/me/.happier',
        env: { path: '/shadow/bin', PORT: '3005' },
      },
    });
    assert.match(linux.contents, /Environment=PATH=\/shadow\/bin/);
    assert.doesNotMatch(linux.contents, /Environment=path=/);
  } finally {
    process.env.PATH = previousPath;
  }
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

test('planServiceAction uses launchctl bootstrap when process.getuid is unavailable', () => {
  const originalGetUid = process.getuid;
  try {
    process.getuid = undefined;
    const plan = planServiceAction({
      backend: 'launchd-user',
      action: 'install',
      label: 'dev.happier.test',
      definitionPath: '/Users/me/Library/LaunchAgents/dev.happier.test.plist',
      definitionContents: '<plist/>',
      persistent: true,
    });
    const bootstrap = plan.commands.find((c) => c.cmd === 'launchctl' && c.args[0] === 'bootstrap');
    assert.ok(bootstrap, 'expected launchctl bootstrap plan when uid can be resolved without process.getuid');
  } finally {
    process.getuid = originalGetUid;
  }
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

test('applyServicePlan explains when systemd user services lack a session bus', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-common-systemctl-user-bus-'));
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });

  const systemctlPath = join(binDir, 'systemctl');
  await writeFile(
    systemctlPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--user" ]]; then
  echo "Failed to connect to bus: No medium found" >&2
  exit 1
fi
exit 0
`,
    'utf8',
  );
  await chmod(systemctlPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  try {
    await assert.rejects(
      () => applyServicePlan({ writes: [], commands: [{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] }] }),
      /Systemd user service is unavailable/i,
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('applyServicePlan falls back to launchctl load when bootstrap gui/uid fails with EIO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-common-launchctl-fallback-'));
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });

  const tracePath = join(root, 'trace.txt');
  const launchctlPath = join(binDir, 'launchctl');
  await writeFile(
    launchctlPath,
    `#!/usr/bin/env bash
 set -euo pipefail
 echo "$*" >> ${JSON.stringify(tracePath)}
 cmd="$1"
 shift 1 || true
 if [[ "$cmd" == "bootstrap" ]]; then
   echo "Bootstrap failed: 5: Input/output error" >&2
   exit 5
 fi
 if [[ "$cmd" == "enable" || "$cmd" == "kickstart" ]]; then
   echo "should not call $cmd after fallback" >&2
   exit 42
 fi
 exit 0
`,
    'utf8',
  );
  await chmod(launchctlPath, 0o755);

  const definitionPath = join(root, 'dev.happier.test.plist');
  const plan = planServiceAction({
    backend: 'launchd-user',
    action: 'install',
    label: 'dev.happier.test',
    definitionPath,
    definitionContents: '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>',
    persistent: true,
    uid: 501,
  });

  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath ?? ''}`;
  try {
    await applyServicePlan(plan);
  } finally {
    process.env.PATH = prevPath;
  }

  const trace = await readFile(tracePath, 'utf8').catch(() => '');
  assert.match(trace, /^bootout\s+gui\/501\/dev\.happier\.test/m);
  assert.match(trace, /^bootstrap\s+gui\/501\s+/m);
  assert.match(trace, /^unload\s+-w\s+/m);
  assert.match(trace, /^load\s+-w\s+/m);

  await rm(root, { recursive: true, force: true });
});

test('applyServicePlan does not execute shell metacharacters while probing for commands on Unix', async () => {
  if (process.platform === 'win32') return;

  const root = await mkdtemp(join(tmpdir(), 'happier-cli-common-service-injection-'));
  try {
    const probePath = join(root, 'probe');
    await assert.rejects(
      () => applyServicePlan({ writes: [], commands: [{ cmd: `missing-command; touch ${JSON.stringify(probePath)}`, args: [] }] }),
      /command not found|missing/i,
    );
    assert.equal(existsSync(probePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
