import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { buildLaunchdPlistXml } from '../launchd.js';
import { renderSystemdServiceUnit } from '../systemd.js';
import { renderWindowsScheduledTaskWrapperPs1 } from '../windows.js';
import {
  listKnownServiceDefinitionFiles,
  parseLaunchdPlist,
  parseSystemdUnit,
  parseWindowsScheduledTaskWrapperPs1,
  readLaunchdLoadedStatus,
  readScheduledTaskStatus,
  readSystemdUnitStatus,
} from './index.js';

describe('listKnownServiceDefinitionFiles', () => {
  it('lists known definition files from the provided roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-common-service-discovery-'));
    try {
      const userRoot = join(root, 'user');
      const systemRoot = join(root, 'system');
      await mkdir(userRoot, { recursive: true });
      await mkdir(systemRoot, { recursive: true });

      await writeFile(join(userRoot, 'com.happier.cli.daemon.cloud.plist'), '<plist/>', 'utf8');
      await writeFile(join(userRoot, 'ignored.txt'), 'nope', 'utf8');
      await writeFile(join(systemRoot, 'happier-daemon.cloud.service'), '[Unit]\n', 'utf8');
      await writeFile(join(systemRoot, 'happier-daemon.cloud.ps1'), '# ps1', 'utf8');

      const files = await listKnownServiceDefinitionFiles({
        roots: [
          { path: userRoot, scope: 'user' },
          { path: systemRoot, scope: 'system' },
        ],
      });

      expect(files).toEqual([
        {
          path: join(systemRoot, 'happier-daemon.cloud.ps1'),
          scope: 'system',
          kind: 'windows-wrapper-ps1',
          label: 'happier-daemon.cloud',
        },
        {
          path: join(systemRoot, 'happier-daemon.cloud.service'),
          scope: 'system',
          kind: 'systemd-unit',
          label: 'happier-daemon.cloud',
        },
        {
          path: join(userRoot, 'com.happier.cli.daemon.cloud.plist'),
          scope: 'user',
          kind: 'launchd-plist',
          label: 'com.happier.cli.daemon.cloud',
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('parseLaunchdPlist', () => {
  it('parses launchd service definition primitives', () => {
    const xml = buildLaunchdPlistXml({
      label: 'com.happier.cli.daemon.cloud',
      programArgs: ['/usr/bin/node', '/opt/happier/bin/happier', 'daemon', 'start-sync'],
      env: {
        PATH: '/usr/bin:/bin',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
      },
      stdoutPath: '/tmp/out.log',
      stderrPath: '/tmp/err.log',
      workingDirectory: '/tmp',
      keepAliveOnFailure: false,
      startCalendarInterval: { hour: 3, minute: 15 },
    });

    expect(parseLaunchdPlist({ contents: xml, sourcePath: '/Users/me/Library/LaunchAgents/com.happier.cli.daemon.cloud.plist' })).toEqual({
      kind: 'launchd-plist',
      label: 'com.happier.cli.daemon.cloud',
      programArgs: ['/usr/bin/node', '/opt/happier/bin/happier', 'daemon', 'start-sync'],
      env: {
        PATH: '/usr/bin:/bin',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
      },
      workingDirectory: '/tmp',
      stdoutPath: '/tmp/out.log',
      stderrPath: '/tmp/err.log',
      runAtLoad: true,
      keepAliveOnFailure: false,
      startIntervalSec: null,
      startCalendarInterval: { hour: 3, minute: 15 },
    });
  });
});

describe('parseSystemdUnit', () => {
  it('parses systemd service definition primitives', () => {
    const unit = renderSystemdServiceUnit({
      description: 'Happier Daemon',
      execStart: ['/usr/bin/node', '/opt/happier/bin/happier', 'daemon', 'start-sync'],
      workingDirectory: '/tmp',
      env: {
        PATH: '/usr/bin:/bin',
        HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
      },
      restart: 'on-failure',
      runAsUser: 'happier',
      stdoutPath: '/tmp/out.log',
      stderrPath: '/tmp/err.log',
      wantedBy: 'multi-user.target',
    });

    expect(parseSystemdUnit({
      contents: unit,
      sourcePath: '/home/me/.config/systemd/user/happier-daemon.cloud.service',
    })).toEqual({
      kind: 'systemd-unit',
      label: 'happier-daemon.cloud',
      description: 'Happier Daemon',
      programArgs: ['/usr/bin/node', '/opt/happier/bin/happier', 'daemon', 'start-sync'],
      env: {
        PATH: '/usr/bin:/bin',
        HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
      },
      workingDirectory: '/tmp',
      runAsUser: 'happier',
      stdoutPath: '/tmp/out.log',
      stderrPath: '/tmp/err.log',
      restart: 'on-failure',
      wantedBy: 'multi-user.target',
    });
  });
});

describe('parseWindowsScheduledTaskWrapperPs1', () => {
  it('parses scheduled task wrapper service definition primitives', () => {
    const script = renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: 'C:\\Users\\me\\.happier',
      programArgs: ['C:\\Users\\me\\.happier\\bin\\happier.exe', 'daemon', 'start-sync'],
      env: {
        PATH: 'C:\\Users\\me\\.happier\\bin;C:\\Windows\\System32',
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
      },
      stdoutPath: 'C:\\Users\\me\\.happier\\logs\\out.log',
      stderrPath: 'C:\\Users\\me\\.happier\\logs\\err.log',
    });

    expect(parseWindowsScheduledTaskWrapperPs1({
      contents: script,
      sourcePath: 'C:\\Users\\me\\.happier\\services\\happier-daemon.cloud.ps1',
    })).toEqual({
      kind: 'windows-wrapper-ps1',
      label: 'happier-daemon.cloud',
      workingDirectory: 'C:\\Users\\me\\.happier',
      programArgs: ['C:\\Users\\me\\.happier\\bin\\happier.exe', 'daemon', 'start-sync'],
      env: {
        PATH: 'C:\\Users\\me\\.happier\\bin;C:\\Windows\\System32',
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
      },
      stdoutPath: 'C:\\Users\\me\\.happier\\logs\\out.log',
      stderrPath: 'C:\\Users\\me\\.happier\\logs\\err.log',
    });
  });
});

describe('service status readers', () => {
  it('parses launchd list output', () => {
    expect(
      readLaunchdLoadedStatus({
        output: 'PID\tStatus\tLabel\n123\t0\tcom.happier.cli.daemon.cloud\n',
      }),
    ).toEqual({
      state: 'loaded',
      pid: 123,
      lastExitStatus: 0,
      label: 'com.happier.cli.daemon.cloud',
    });
  });

  it('parses systemd show output', () => {
    expect(
      readSystemdUnitStatus({
        output: [
          'LoadState=loaded',
          'ActiveState=active',
          'SubState=running',
          'Result=success',
          'ExecMainStatus=0',
          'NRestarts=3',
          'UnitFileState=enabled',
          'FragmentPath=/home/me/.config/systemd/user/happier-daemon.cloud.service',
          'MainPID=456',
          '',
        ].join('\n'),
      }),
    ).toEqual({
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      result: 'success',
      execMainStatus: 0,
      nRestarts: 3,
      unitFileState: 'enabled',
      fragmentPath: '/home/me/.config/systemd/user/happier-daemon.cloud.service',
      mainPid: 456,
    });
  });

  it('treats blank or omitted numeric systemd fields as unknown', () => {
    expect(
      readSystemdUnitStatus({
        output: [
          'LoadState=loaded',
          'ActiveState=inactive',
          'SubState=dead',
          'Result=exit-code',
          'ExecMainStatus=',
          'UnitFileState=disabled',
          '',
        ].join('\n'),
      }),
    ).toEqual({
      loadState: 'loaded',
      activeState: 'inactive',
      subState: 'dead',
      result: 'exit-code',
      execMainStatus: null,
      nRestarts: null,
      unitFileState: 'disabled',
      fragmentPath: null,
      mainPid: null,
    });
  });

  it('parses schtasks query output', () => {
    expect(
      readScheduledTaskStatus({
        output: [
          'TaskName: \\Happier\\happier-daemon.cloud',
          'Scheduled Task State: Enabled',
          'Status: Running',
          'Last Run Time: 4/7/2026 8:00:00 AM',
          'Next Run Time: 4/7/2026 8:15:00 AM',
          'Last Result: 0',
          'Task To Run: C:\\Users\\me\\.happier\\services\\happier-daemon.cloud.ps1',
          '',
        ].join('\n'),
      }),
    ).toEqual({
      taskName: '\\Happier\\happier-daemon.cloud',
      scheduledTaskState: 'Enabled',
      status: 'Running',
      enabled: true,
      running: true,
      lastRunTime: '4/7/2026 8:00:00 AM',
      nextRunTime: '4/7/2026 8:15:00 AM',
      lastResult: 0,
      taskToRun: 'C:\\Users\\me\\.happier\\services\\happier-daemon.cloud.ps1',
    });
  });
});
