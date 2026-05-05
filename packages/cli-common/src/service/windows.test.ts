import { describe, expect, it } from 'vitest';

import {
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  parseWindowsScheduledTaskStatusPowerShellJson,
} from './windows';

describe('Windows scheduled task PowerShell status helper', () => {
  it('parses launch post-mortem fields from invariant JSON', () => {
    const parsed = parseWindowsScheduledTaskStatusPowerShellJson(JSON.stringify({
      exists: true,
      enabled: true,
      active: false,
      stateLabel: 'Ready',
      stateValue: 3,
      lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
      lastTaskResult: 267009,
      taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    }));

    expect(parsed).toEqual({
      exists: true,
      enabled: true,
      active: false,
      stateLabel: 'Ready',
      stateValue: 3,
      lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
      lastTaskResult: 267009,
      taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    });
  });

  it('queries launch post-mortem fields using culture-independent property names', () => {
    const command = buildReadWindowsScheduledTaskStatusPowerShellCommand({
      taskPath: '\\Happier\\',
      taskName: 'happier-daemon.default',
    });

    expect(command).toContain('Get-ScheduledTaskInfo');
    expect(command).toContain('LastTaskResult');
    expect(command).toContain('LastRunTime');
    expect(command).toContain('Actions');
    expect(command).toContain('ConvertTo-Json -Compress');
  });
});
