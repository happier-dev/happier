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
      command.cmd === 'powershell.exe' && String(command.args.at(-1)).includes('RegisterTask'));
    // Stop-if-running, register, apply service policy, then explicitly run.
    expect(plan.commands.map((command) => command.cmd)).toEqual(['powershell.exe', 'powershell.exe', 'powershell.exe', 'schtasks']);
    expect(plan.commands[0]?.args).toEqual(expect.arrayContaining([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]));
    expect(plan.commands[0]?.args.at(-1)).toContain('Stop-ScheduledTask');
    expect(create).toBeDefined();
    const registration = String(create?.args.at(-1) ?? '');
    expect(registration).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    expect(registration).toContain('<LogonTrigger><Enabled>true</Enabled><UserId>');
    expect(registration).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(registration).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(registration).toContain('<Command>powershell.exe</Command>');
    expect(registration).toContain('-WindowStyle Hidden -File &quot;C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1&quot;');
    expect(registration).toContain('$xml.Task.Triggers.LogonTrigger.UserId = $userId');
    expect(registration).toContain('$xml.Task.Principals.Principal.UserId = $userId');
    expect(registration).toContain('$folder.RegisterTask($taskName, $xml.OuterXml, 6, $userId, $null, 3, $null)');
  });

  it('plans restart as an ordered task end followed by task run', () => {
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action: 'restart',
      label: 'happier-server',
      taskName: 'Happier\\happier-server',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-server.ps1',
      persistent: true,
    });

    expect(plan.commands).toMatchObject([
      { cmd: 'schtasks', args: ['/End', '/TN', 'Happier\\happier-server'] },
      { cmd: 'schtasks', args: ['/Run', '/TN', 'Happier\\happier-server'] },
    ]);
  });

  /**
   * `persistent: false` means "registered, startable, but nothing starts it for me".
   * A user task can be registered without any trigger; only an explicit Run starts it.
   */
  it('registers a non-persistent task without an automatic trigger', () => {
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action: 'install',
      label: 'happier-daemon.default',
      taskName: 'Happier\\happier-daemon.default',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
      definitionContents: '$ErrorActionPreference = "Stop"',
      persistent: false,
    });
    const create = plan.commands.find((command) =>
      command.cmd === 'powershell.exe' && String(command.args.at(-1)).includes('RegisterTask'));
    const registration = String(create?.args.at(-1) ?? '');
    expect(registration).toContain('<Triggers/>');
    expect(registration).not.toContain('LogonTrigger');
    expect(registration).not.toContain('TimeTrigger');
    expect(registration).toContain('<LogonType>InteractiveToken</LogonType>');

    // No scheduler catch-up in on-demand mode.
    const settings = plan.commands.find((entry) =>
      entry.cmd === 'powershell.exe'
      && String(entry.args.at(-1) ?? '').includes('New-ScheduledTaskSettingsSet'));
    expect(String(settings?.args.at(-1) ?? '')).not.toContain('-StartWhenAvailable');
    // The task is still started now, and still hardened for a long-running process.
    expect(plan.commands.some((entry) => entry.cmd === 'schtasks' && entry.args.includes('/Run'))).toBe(true);
    expect(String(settings?.args.at(-1) ?? '')).toContain('-ExecutionTimeLimit');
  });

  it('keeps elevated SYSTEM boot registration separate from current-user logon registration', () => {
    const plan = planServiceAction({
      backend: 'schtasks-system', action: 'install', label: 'relay',
      definitionPath: 'C:\\ProgramData\\Happier\\relay.ps1', persistent: true,
    });
    const create = plan.commands.find((command) => command.cmd === 'schtasks' && command.args.includes('/Create'));
    expect(create?.args).toEqual(expect.arrayContaining(['ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST']));
  });

  it('keeps XML and PowerShell metacharacters in a wrapper path literal', () => {
    const path = "C:\\Users\\O'Brien & $qa\\relay.ps1";
    const plan = planServiceAction({
      backend: 'schtasks-user', action: 'install', label: 'relay',
      definitionPath: path, persistent: true,
    });
    const registration = String(plan.commands.find((command) =>
      String(command.args.at(-1)).includes('RegisterTask'))?.args.at(-1) ?? '');
    expect(registration).toContain("[xml]$xml = '<Task");
    expect(registration).toContain('O&apos;Brien &amp; $qa');
    expect(registration).not.toContain('/SC');
  });
});
