import { describe, expect, it } from 'vitest';

import { planServiceAction } from './manager';

describe('planServiceAction (schtasks install)', () => {
  it('creates Windows user tasks with a hidden non-interactive PowerShell action', () => {
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action: 'install',
      label: 'happier-daemon.default',
      taskName: 'Happier\\happier-daemon.default',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
      definitionContents: '$ErrorActionPreference = "Stop"',
      persistent: true,
    });

    const create = plan.commands.find((command) =>
      command.cmd === 'schtasks' && command.args.includes('/Create'));
    // stop-if-running, /Create, apply service policy (restart + long-running
    // hardening, which schtasks cannot express), /Run.
    expect(plan.commands.map((command) => command.cmd)).toEqual(['powershell.exe', 'schtasks', 'powershell.exe', 'schtasks']);
    expect(plan.commands[0]?.args).toEqual(expect.arrayContaining([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]));
    expect(plan.commands[0]?.args.at(-1)).toContain('Stop-ScheduledTask');
    expect(create).toBeDefined();
    expect(create?.args).toContain('/SC');
    expect(create?.args).toContain('ONLOGON');
    expect(create?.args).not.toContain('/IT');
    expect(create?.args).toContain('/TR');
    expect(create?.args[create.args.indexOf('/TR') + 1]).toBe('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1"');
  });
});
