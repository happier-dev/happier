import { describe, expect, it } from 'vitest';

import { buildServiceDefinition, planServiceAction } from './manager';

describe('buildServiceDefinition restart policy', () => {
  it('renders an explicit on-failure systemd policy for a terminal successful disposition', () => {
    const definition = buildServiceDefinition({
      backend: 'systemd-user',
      homeDir: '/home/alice',
      spec: {
        label: 'dev.happier.stack.exp',
        programArgs: ['/opt/hstack', 'start', '--restart'],
        restartPolicy: 'on-failure',
      },
    });

    expect(definition.contents).toContain('Restart=on-failure');
    expect(definition.contents).not.toContain('Restart=always');
  });
});

describe('planServiceAction restart policy (Windows)', () => {
  const install = (restartPolicy?: 'always' | 'on-failure' | 'no') => planServiceAction({
    backend: 'schtasks-user',
    action: 'install',
    label: 'happier-daemon.default',
    taskName: 'Happier\\happier-daemon.default',
    definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    definitionContents: '$ErrorActionPreference = "Stop"',
    persistent: true,
    ...(restartPolicy ? { restartPolicy } : {}),
  });

  const settingsScript = (plan: ReturnType<typeof planServiceAction>): string | null => {
    const command = plan.commands.find((entry) =>
      entry.cmd === 'powershell.exe'
      && String(entry.args.at(-1) ?? '').includes('New-ScheduledTaskSettingsSet'));
    return command ? String(command.args.at(-1) ?? '') : null;
  };

  it('restarts a failed Windows task, matching systemd Restart= and launchd KeepAlive', () => {
    const script = settingsScript(install());

    expect(script).not.toBeNull();
    expect(script).toContain('-RestartCount');
    expect(script).toContain('-RestartInterval');
  });

  it('survives the Task Scheduler defaults that kill long-running background processes', () => {
    const script = settingsScript(install()) ?? '';

    // Default ExecutionTimeLimit stops a task after three days.
    expect(script).toContain('-ExecutionTimeLimit');
    // Default settings refuse to start on battery and stop when unplugged — fatal on a laptop.
    expect(script).toContain('-AllowStartIfOnBatteries');
    expect(script).toContain('-DontStopIfGoingOnBatteries');
    // A missed trigger (machine asleep at logon/boot) should still start the task.
    expect(script).toContain('-StartWhenAvailable');
  });

  it('applies the settings before the task is first run', () => {
    const plan = install();
    const settingsIndex = plan.commands.findIndex((entry) =>
      entry.cmd === 'powershell.exe'
      && String(entry.args.at(-1) ?? '').includes('New-ScheduledTaskSettingsSet'));
    const runIndex = plan.commands.findIndex((entry) =>
      entry.cmd === 'schtasks' && entry.args.includes('/Run'));

    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBeLessThan(runIndex);
  });

  it('honours restartPolicy "no" without giving up the long-running hardening', () => {
    const script = settingsScript(install('no')) ?? '';

    expect(script).not.toContain('-RestartCount');
    expect(script).toContain('-ExecutionTimeLimit');
  });
});
