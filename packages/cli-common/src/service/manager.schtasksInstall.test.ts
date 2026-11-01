import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyServicePlan, planServiceAction, preflightServiceInstallAssets } from './manager';

describe('planServiceAction (schtasks install)', () => {
  it('creates Windows user tasks through the packaged windowless launcher', () => {
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action: 'install',
      label: 'happier-daemon.default',
      taskName: 'Happier\\happier-daemon.default',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
      definitionContents: '$ErrorActionPreference = "Stop"',
      persistent: true,
      windowsLauncher: {
        sourcePath: 'C:\\package\\native\\windows-x64\\happier-service-launcher.exe',
        version: '0.2.17',
      },
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
    expect(registration).toContain('<Command>C:\\Users\\test\\.happier\\services\\happier-daemon.default\\launcher-0.2.17\\happier-service-launcher.exe</Command>');
    expect(registration).toContain('--wrapper &quot;C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1&quot;');
    expect(registration).toContain('--diagnostic-log &quot;C:\\Users\\test\\.happier\\services\\happier-daemon.default.launcher.log&quot;');
    expect(registration).toContain('$xml.Task.Triggers.LogonTrigger.UserId = $userId');
    expect(registration).toContain('$xml.Task.Principals.Principal.UserId = $userId');
    expect(registration).toContain('$folder.RegisterTask($taskName, $xml.OuterXml, 6, $userId, $null, 3, $null)');
    expect(plan.copies).toEqual([{
      sourcePath: 'C:\\package\\native\\windows-x64\\happier-service-launcher.exe',
      destinationPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default\\launcher-0.2.17\\happier-service-launcher.exe',
      validation: 'windows-service-launcher-x64-v1',
    }]);
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
      windowsLauncher: {
        sourcePath: 'C:\\package\\native\\windows-x64\\happier-service-launcher.exe',
        version: '0.2.17',
      },
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
      windowsLauncher: {
        sourcePath: 'C:\\package\\native\\windows-x64\\happier-service-launcher.exe',
        version: '0.2.17',
      },
    });
    const registration = String(plan.commands.find((command) =>
      String(command.args.at(-1)).includes('RegisterTask'))?.args.at(-1) ?? '');
    expect(registration).toContain("[xml]$xml = '<Task");
    expect(registration).toContain('O&apos;Brien &amp; $qa');
    expect(registration).not.toContain('/SC');
  });

  it('preflights the helper before stopping or replacing an installed task', () => {
    const plan = planServiceAction({
      backend: 'schtasks-user', action: 'install', label: 'relay',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\relay.ps1', persistent: true,
      windowsLauncher: {
        sourcePath: 'C:\\missing\\happier-service-launcher.exe',
        version: '0.2.17',
      },
    });

    expect(plan.copies).toHaveLength(1);
    expect(plan.commands[0]?.args.at(-1)).toContain('Stop-ScheduledTask');
  });

  it('rejects an invalid helper before writing a replacement wrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-launcher-preflight-'));
    const sourcePath = join(root, 'invalid.exe');
    const definitionPath = join(root, 'relay.ps1');
    await writeFile(sourcePath, 'not a PE');
    await writeFile(definitionPath, 'original wrapper');
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action: 'install',
      label: 'relay',
      definitionPath,
      definitionContents: 'replacement wrapper',
      persistent: true,
      windowsLauncher: { sourcePath, version: 'fixture' },
    });

    await expect(applyServicePlan(plan, { runCommands: false })).rejects.toThrow(/invalid .*launcher/u);
    await expect(readFile(definitionPath, 'utf8')).resolves.toBe('original wrapper');
  });

  it('lets consumers reject a missing helper before they stop the current service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-launcher-consumer-preflight-'));
    const sourcePath = join(root, 'missing.exe');

    await expect(preflightServiceInstallAssets({
      backend: 'schtasks-user',
      windowsLauncher: { sourcePath, version: 'fixture' },
    })).rejects.toThrow(/launcher is unavailable/u);
    await expect(preflightServiceInstallAssets({
      backend: 'systemd-user',
      windowsLauncher: { sourcePath, version: 'fixture' },
    })).resolves.toBeUndefined();
  });
});
