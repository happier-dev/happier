import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyServicePlan,
  isBenignServiceAbsenceFailure,
  planServiceAction,
  resolveServiceDefinitionPath,
} from './manager';

describe('service uninstall semantics', () => {
  it('unregisters an explicit systemd timer before deleting its definition and reloading', () => {
    const definitionPath = '/tmp/dev.happier.stack.exp.timer';
    const plan = planServiceAction({ backend: 'systemd-user', action: 'uninstall', label: 'dev.happier.stack.exp', definitionPath });
    expect(plan.commands[0]).toMatchObject({ cmd: 'systemctl', args: ['--user', 'disable', '--now', 'dev.happier.stack.exp.timer'], expectedFailure: 'service-absent' });
    expect(plan.removals).toEqual([{ path: definitionPath, beforeCommandIndex: 1 }]);
    expect(plan.commands[1]).toMatchObject({ cmd: 'systemctl', args: ['--user', 'daemon-reload'] });
  });

  it.each([
    ['systemd-user', 'systemctl', ['--user', 'disable', '--now', 'dev.happier.stack.exp.service']],
    ['launchd-user', 'launchctl', ['bootout', 'gui/501/dev.happier.stack.exp']],
  ] as const)('plans %s teardown as fail-closed before definition removal', (backend, command, args) => {
    const definitionPath = '/tmp/dev.happier.stack.exp.service';
    const plan = planServiceAction({
      backend,
      action: 'uninstall',
      label: 'dev.happier.stack.exp',
      definitionPath,
      taskName: 'Happier\\dev.happier.stack.exp',
      uid: 501,
    });

    expect(plan.commands).toContainEqual(expect.objectContaining({
      cmd: command,
      args,
      expectedFailure: 'service-absent',
    }));
    expect(plan.commands.find((item) => item.cmd === command && item.args.join(' ') === args.join(' '))?.allowFail).not.toBe(true);
    expect(plan.removals).toContainEqual({ path: definitionPath, beforeCommandIndex: backend === 'systemd-user' ? 1 : 2 });
  });

  it('plans Windows teardown through typed scheduler commands before definition removal', () => {
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
    expect(plan.removals).toContainEqual({
      path: 'C:\\Users\\test\\.happier\\services\\dev.happier.stack.exp',
      recursive: true,
      beforeCommandIndex: 2,
    });
  });

  it.each([
    ['systemctl', ['--user', 'disable', '--now', 'x.service'], 'Unit x.service does not exist.'],
    ['systemctl', ['show', 'x.service', '--property=LoadState', '--value'], 'Unit x.service could not be found.'],
    ['launchctl', ['bootout', 'gui/501', '/tmp/x.plist'], 'Could not find specified service'],
    ['launchctl', ['print', 'gui/501/x'], 'Could not find service "x" in domain'],
    ['launchctl', ['bootout', 'gui/501/dev.happier.stack.x'], 'Boot-out failed: 3: No such process'],
  ])('accepts benign already-absent %s failures', (cmd, args, stderr) => {
    expect(isBenignServiceAbsenceFailure({ cmd, args, stderr, stdout: '', status: 1 })).toBe(true);
  });

  it.each([
    ['systemctl', ['--user', 'disable', '--now', 'x.service'], 'Failed to connect to bus: Permission denied'],
    ['launchctl', ['bootout', 'gui/501', '/tmp/x.plist'], 'Boot-out failed: 1: Operation not permitted'],
    ['schtasks', ['/Delete', '/F', '/TN', 'Happier\\x'], 'ERROR: Access is denied.'],
  ])('rejects real %s teardown failures', (cmd, args, stderr) => {
    expect(isBenignServiceAbsenceFailure({ cmd, args, stderr, stdout: '', status: 1 })).toBe(false);
  });

  it.each([
    ['schtasks', ['/Delete', '/F', '/TN', 'Happier\\x'], 'ERROR: The task is not currently running.'],
  ])('does not mistake ambiguous %s output for successful target teardown', (cmd, args, stderr) => {
    expect(isBenignServiceAbsenceFailure({ cmd, args, stderr, stdout: '', status: 1 })).toBe(false);
  });

  describe.sequential('applyServicePlan backend boundary', () => {
    it.each([
      ['systemctl', ['disable', '--now', 'x.service'], 'Unit x.service does not exist.'],
      ['launchctl', ['bootout', 'gui/501/x'], 'Could not find specified service'],
    ])('continues past an already-absent %s service', async (command, args, stderr) => {
      await withFakeServiceCommand(command, stderr, async () => {
        await expect(applyServicePlan({
          writes: [],
          commands: [{ cmd: command, args, expectedFailure: 'service-absent' }],
        })).resolves.toBeUndefined();
      });
    });

    it.each([
      ['systemctl', 'Failed to connect to bus: Permission denied'],
      ['launchctl', 'Operation not permitted'],
      ['schtasks', 'ERROR: Access is denied.'],
    ])('fails closed when %s teardown is rejected', async (command, stderr) => {
      await withFakeServiceCommand(command, stderr, async () => {
        await expect(applyServicePlan({
          writes: [],
          commands: [{ cmd: command, args: ['uninstall'], expectedFailure: 'service-absent' }],
        })).rejects.toThrow(/command failed|unavailable/i);
      });
    });

    it('does not require a privileged systemd reload after proving the service is already absent', async () => {
      await withFakeServiceCommand('systemctl', 'Unit x.service does not exist.', async () => {
        await expect(applyServicePlan({
          writes: [],
          commands: [
            {
              cmd: 'systemctl',
              args: ['disable', '--now', 'x.service'],
              expectedFailure: 'service-absent',
              completePlanOnExpectedFailure: true,
            },
            { cmd: '__must_not_run__', args: [] },
          ],
        })).resolves.toBeUndefined();
      });
    });
  });
});

async function withFakeServiceCommand(command: string, stderr: string, run: () => Promise<void>): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-service-uninstall-'));
  const commandPath = join(tempRoot, command);
  const previousPath = process.env.PATH;
  writeFileSync(commandPath, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit 1\n`, 'utf8');
  chmodSync(commandPath, 0o755);
  process.env.PATH = `${tempRoot}:${previousPath ?? ''}`;
  try {
    await run();
  } finally {
    process.env.PATH = previousPath;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe('resolveServiceDefinitionPath', () => {
  it('owns platform definition paths for every Stack backend', () => {
    expect(resolveServiceDefinitionPath({ platform: 'darwin', mode: 'user', homeDir: '/home/alice', label: 'dev.happier.stack.exp' }))
      .toBe('/home/alice/Library/LaunchAgents/dev.happier.stack.exp.plist');
    expect(resolveServiceDefinitionPath({ platform: 'linux', mode: 'system', homeDir: '/home/alice', label: 'dev.happier.stack.exp' }))
      .toBe('/etc/systemd/system/dev.happier.stack.exp.service');
    expect(resolveServiceDefinitionPath({ platform: 'win32', mode: 'user', homeDir: 'C:\\Users\\alice', label: 'dev.happier.stack.exp' }))
      .toBe('C:\\Users\\alice\\.happier\\services\\dev.happier.stack.exp.ps1');
  });
});
