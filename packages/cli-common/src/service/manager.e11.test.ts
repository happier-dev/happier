import { describe, expect, it } from 'vitest';

import {
  isBenignServiceAbsenceFailure,
  planServiceAction,
  resolveServiceDefinitionPath,
  buildServiceDefinition,
} from './manager';

describe('E11 canonical service lifecycle', () => {
  it('renders an explicit on-failure policy without changing the default', () => {
    const stack = buildServiceDefinition({
      backend: 'systemd-user',
      homeDir: '/home/alice',
      spec: {
        label: 'dev.happier.stack.exp',
        programArgs: ['/opt/hstack', 'start', '--restart'],
        restartPolicy: 'on-failure',
      },
    });
    const ordinary = buildServiceDefinition({
      backend: 'systemd-user',
      homeDir: '/home/alice',
      spec: { label: 'dev.happier.other', programArgs: ['/opt/other'] },
    });

    expect(stack.contents).toContain('Restart=on-failure');
    expect(ordinary.contents).toContain('Restart=always');
  });

  it.each([
    ['systemd-user', 'systemctl', ['--user', 'disable', '--now', 'dev.happier.stack.exp.service']],
    ['launchd-user', 'launchctl', ['bootout', 'gui/501/dev.happier.stack.exp']],
  ] as const)('plans %s teardown fail-closed by canonical target', (backend, cmd, args) => {
    const plan = planServiceAction({
      backend,
      action: 'uninstall',
      label: 'dev.happier.stack.exp',
      definitionPath: '/tmp/definition',
      taskName: 'Happier\\dev.happier.stack.exp',
      uid: 501,
    });
    expect(plan.commands).toContainEqual(expect.objectContaining({
      cmd,
      args,
      expectedFailure: 'service-absent',
    }));
  });

  it('plans Windows teardown through typed scheduler commands', () => {
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action: 'uninstall',
      label: 'dev.happier.stack.exp',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\dev.happier.stack.exp.ps1',
      taskName: 'Happier\\dev.happier.stack.exp',
    });

    expect(plan.commands).toHaveLength(2);
    expect(plan.commands.every((command) => command.cmd === 'powershell.exe')).toBe(true);
    expect(plan.commands[0]?.args.at(-1)).toContain('Stop-ScheduledTask');
    expect(plan.commands[1]?.args.at(-1)).toContain('Unregister-ScheduledTask');
    expect(plan.commands.every((command) => command.allowFail !== true)).toBe(true);
  });

  it('only classifies explicit backend absence as benign', () => {
    expect(isBenignServiceAbsenceFailure({
      cmd: 'launchctl',
      args: ['bootout', 'gui/501/dev.happier.stack.exp'],
      status: 1,
      stdout: '',
      stderr: 'Could not find specified service',
    })).toBe(true);
    expect(isBenignServiceAbsenceFailure({
      cmd: 'launchctl',
      args: ['bootout', 'gui/501/dev.happier.stack.exp'],
      status: 1,
      stdout: '',
      stderr: 'Boot-out failed: 3: No such process',
    })).toBe(true);
    expect(isBenignServiceAbsenceFailure({
      cmd: 'launchctl',
      args: ['bootout', 'gui/501/dev.happier.stack.exp'],
      status: 1,
      stdout: '',
      stderr: 'Boot-out failed: 1: Operation not permitted',
    })).toBe(false);
    expect(isBenignServiceAbsenceFailure({
      cmd: 'systemctl',
      args: ['--user', 'stop', 'dev.happier.stack.exp.service'],
      status: 5,
      stdout: '',
      stderr: 'Unit dev.happier.stack.exp.service not loaded.',
    })).toBe(true);
  });

  it('owns definition paths across supported service backends', () => {
    expect(resolveServiceDefinitionPath({ platform: 'darwin', mode: 'user', homeDir: '/home/alice', label: 'dev.happier.stack.exp' }))
      .toBe('/home/alice/Library/LaunchAgents/dev.happier.stack.exp.plist');
    expect(resolveServiceDefinitionPath({ platform: 'linux', mode: 'system', homeDir: '/home/alice', label: 'dev.happier.stack.exp' }))
      .toBe('/etc/systemd/system/dev.happier.stack.exp.service');
    expect(resolveServiceDefinitionPath({ platform: 'win32', mode: 'user', homeDir: 'C:\\Users\\alice', label: 'dev.happier.stack.exp' }))
      .toBe('C:\\Users\\alice\\.happier\\services\\dev.happier.stack.exp.ps1');
  });
});
