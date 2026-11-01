import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildWindowsScheduledTaskLauncherAction,
  buildListWindowsScheduledTaskFolderPowerShellCommand,
  buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand,
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  buildStopWindowsScheduledTaskIfRunningPowerShellCommand,
  buildWindowsScheduledTaskPowerShellAction,
  isWindowsScheduledTaskLauncherActionExpected,
  parseWindowsScheduledTaskFolderPowerShellJson,
  parseWindowsScheduledTaskStatusPowerShellJson,
  renderWindowsScheduledTaskWrapperPs1,
} from './windows';

describe('Windows scheduled-task launcher action', () => {
  it('accepts Windows executable path casing while requiring the exact launcher arguments', () => {
    const paths = {
      launcherPath: 'C:\\Users\\Test\\happier-service-launcher.exe',
      definitionPath: 'C:\\Users\\Test\\daemon.ps1',
      diagnosticLogPath: 'C:\\Users\\Test\\daemon.launcher.log',
    };
    const action = buildWindowsScheduledTaskLauncherAction(paths);
    expect(isWindowsScheduledTaskLauncherActionExpected({
      ...paths,
      taskToRun: `${action.executable.toUpperCase()} ${action.arguments}`,
    })).toBe(true);
    expect(isWindowsScheduledTaskLauncherActionExpected({
      ...paths,
      taskToRun: `${action.executable} ${action.arguments.replace('--wrapper', '--WRAPPER')}`,
    })).toBe(false);
    expect(isWindowsScheduledTaskLauncherActionExpected({
      ...paths,
      taskToRun: `${action.executable}.elsewhere ${action.arguments}`,
    })).toBe(false);
  });

  it('keeps executable and arguments structured with literal Unicode and metacharacters', () => {
    const action = buildWindowsScheduledTaskLauncherAction({
      launcherPath: 'C:\\Users\\Zoë & QA\\launcher.exe',
      definitionPath: 'C:\\Users\\Zoë & QA\\daemon `$1.ps1',
      diagnosticLogPath: 'C:\\Users\\Zoë & QA\\daemon.launcher.log',
    });

    expect(action).toEqual({
      executable: 'C:\\Users\\Zoë & QA\\launcher.exe',
      arguments: '--wrapper "C:\\Users\\Zoë & QA\\daemon `$1.ps1" --diagnostic-log "C:\\Users\\Zoë & QA\\daemon.launcher.log"',
    });
  });
});

describe('Windows scheduled task folder listing PowerShell helper', () => {
  it('lists only the requested task folder instead of enumerating every scheduled task', () => {
    const command = buildListWindowsScheduledTaskFolderPowerShellCommand({ taskFolder: '\\Happier\\' });

    expect(command).toContain('Schedule.Service');
    expect(command).toContain('.GetFolder("\\Happier")');
    expect(command).toContain('ConvertTo-Json');
    expect(command).not.toContain('schtasks');
  });

  it('parses task paths from invariant JSON and rejects anything else', () => {
    expect(parseWindowsScheduledTaskFolderPowerShellJson('["\\\\Happier\\\\happier-daemon.default"]'))
      .toEqual(['\\Happier\\happier-daemon.default']);
    expect(parseWindowsScheduledTaskFolderPowerShellJson('[]')).toEqual([]);
    // The COM producer emits explicit [] for an empty inventory; blank output proves nothing.
    expect(parseWindowsScheduledTaskFolderPowerShellJson('')).toBeNull();
    expect(parseWindowsScheduledTaskFolderPowerShellJson(' \r\n')).toBeNull();
    expect(parseWindowsScheduledTaskFolderPowerShellJson('ERROR: The system cannot find the file specified.')).toBeNull();
    expect(parseWindowsScheduledTaskFolderPowerShellJson('[1]')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('reports a missing task folder as empty without parsing localized errors', () => {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      buildListWindowsScheduledTaskFolderPowerShellCommand({ taskFolder: `\\HappierMissingFolderTest${process.pid}\\` }),
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

    expect(result.status).toBe(0);
    expect(parseWindowsScheduledTaskFolderPowerShellJson(result.stdout)).toEqual([]);
  });
});

// Windows PowerShell 5.1 appends redirected streams as UTF-16LE; PowerShell 7 writes UTF-8.
function readPowerShellLog(path: string): string {
  const bytes = readFileSync(path);
  const isUtf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || bytes.includes(0);
  return bytes.toString(isUtf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '');
}

function runWrapperWithWindowsPowerShell(params: Readonly<{
  workingDirectory: string;
  programArgs: readonly string[];
  env?: Record<string, string>;
}>): Readonly<{ status: number | null; stdoutLog: string; stderrLog: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'happier-wrapper-$HOME-'));
  try {
    const stdoutPath = join(dir, 'out.log');
    const stderrPath = join(dir, 'err.log');
    const wrapperPath = join(dir, 'wrapper.ps1');
    writeFileSync(wrapperPath, renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: params.workingDirectory,
      programArgs: params.programArgs,
      env: params.env,
      stdoutPath,
      stderrPath,
    }));
    // The scheduled task action runs Windows PowerShell 5.1 (`powershell.exe`), not pwsh.
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const readIfPresent = (path: string) => {
      try {
        return readPowerShellLog(path);
      } catch {
        return '';
      }
    };
    return { status: result.status, stdoutLog: readIfPresent(stdoutPath), stderrLog: readIfPresent(stderrPath) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Windows scheduled task wrapper script', () => {
  it.runIf(process.platform === 'win32')('preserves literal dollar signs in paths, arguments and environment values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-working-$HOME-'));
    const literal = 'literal$HOME`"$env:USERPROFILE';
    try {
      const result = runWrapperWithWindowsPowerShell({
        workingDirectory: dir,
        programArgs: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],value:process.env.WRAPPER_LITERAL}))', 'argument$HOME'],
        env: { WRAPPER_LITERAL: literal },
      });

      expect(result.status).toBe(0);
      // Windows may expand an 8.3 alias from tmpdir() in the child process cwd.
      expect(JSON.parse(result.stdoutLog)).toEqual({ cwd: realpathSync.native(dir), arg: 'argument$HOME', value: literal });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('keeps the program running when it writes to stderr and propagates its exit code', () => {
    const result = runWrapperWithWindowsPowerShell({
      workingDirectory: tmpdir(),
      programArgs: [
        process.execPath,
        '-e',
        "process.stderr.write('(node) [DEP0169] DeprecationWarning\\n'); setTimeout(() => { process.stdout.write('still-running\\n'); process.exit(3); }, 500);",
      ],
    });

    expect(result.stdoutLog).toContain('still-running');
    expect(result.stderrLog).toContain('DEP0169');
    expect(result.status).toBe(3);
  });

  it.runIf(process.platform === 'win32')('records wrapper setup failures in the stderr log and exits non-zero', () => {
    const result = runWrapperWithWindowsPowerShell({
      workingDirectory: join(tmpdir(), 'happier-wrapper-missing-dir', 'does-not-exist'),
      programArgs: [process.execPath, '-e', "process.stdout.write('should-not-run\\n')"],
    });

    expect(result.status).not.toBe(0);
    expect(result.stdoutLog).not.toContain('should-not-run');
    expect(result.stderrLog).toContain('does-not-exist');
  });

  it('keeps the program invocation on a single `& ` line for definition readers', () => {
    const script = renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: 'C:\\Users\\tester',
      programArgs: ['C:\\Users\\tester\\.happier\\bin\\happier.exe', 'daemon', 'start-sync', '--takeover'],
      stdoutPath: 'C:\\Users\\tester\\.happier\\logs\\out.log',
      stderrPath: 'C:\\Users\\tester\\.happier\\logs\\err.log',
    });

    expect(/^& (.*)$/mu.exec(script)?.[1]).toBe(
      '"C:\\Users\\tester\\.happier\\bin\\happier.exe" "daemon" "start-sync" "--takeover"'
      + ' 1>> "C:\\Users\\tester\\.happier\\logs\\out.log" 2>> "C:\\Users\\tester\\.happier\\logs\\err.log"',
    );
  });
});

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

describe('Windows scheduled task lifecycle PowerShell helpers', () => {
  it('recognizes only the current and released 0.2.1 legacy action argument forms', () => {
    const definitionPath = 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1';
    const command = buildStopWindowsScheduledTaskIfRunningPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
      definitionPath,
    });
    const currentArguments = buildWindowsScheduledTaskPowerShellAction({ definitionPath }).slice('powershell.exe '.length);
    const releasedArguments = `-NoProfile -ExecutionPolicy Bypass -File "${definitionPath}"`;
    const quote = (value: string) => `"${value.replaceAll('`', '``').replaceAll('$', '`$').replaceAll('"', '`"')}"`;

    expect(command).toContain(`$expectedLegacyArguments = @(${quote(currentArguments)}, ${quote(releasedArguments)})`);
    expect(command).toContain('$registeredArguments.Equals($_, [StringComparison]::OrdinalIgnoreCase)');
  });

  it.runIf(process.platform === 'win32').each([
    { kind: 'current', executable: 'powershell.exe', extraArguments: '', expectedStatus: 0 },
    { kind: 'released-0.2.1', executable: 'powershell.exe', extraArguments: '', expectedStatus: 0 },
    { kind: 'released-0.2.1', executable: 'powershell.exe', extraArguments: ' -NoExit', expectedStatus: 1 },
    { kind: 'released-0.2.1', executable: 'other.exe', extraArguments: '', expectedStatus: 1 },
  ])('checks the full $kind task action before stopping ($executable, extra "$extraArguments")', ({
    kind, executable, extraArguments, expectedStatus,
  }) => {
    const definitionPath = 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1';
    const argumentsValue = (kind === 'current'
      ? buildWindowsScheduledTaskPowerShellAction({ definitionPath }).slice('powershell.exe '.length)
      : `-NoProfile -ExecutionPolicy Bypass -File "${definitionPath}"`) + extraArguments;
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    // Task Scheduler and the process inventory are OS boundaries; execute the real generated guard.
    const fixture = [
      '$global:fixtureStopped = $false',
      `function Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction); [pscustomobject]@{ State = $(if ($global:fixtureStopped) { 3 } else { 4 }); Actions = @([pscustomobject]@{ Execute = ${literal(executable)}; Arguments = ${literal(argumentsValue)} }) } }`,
      'function Get-CimInstance { param($ClassName, $ErrorAction); @() }',
      'function Stop-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction); $global:fixtureStopped = $true; Write-Output "fixture-stopped" }',
      buildStopWindowsScheduledTaskIfRunningPowerShellCommand({
        qualifiedTaskName: 'Happier\\happier-daemon.default',
        definitionPath,
      }),
    ].join('; ');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', fixture,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

    expect(result.status).toBe(expectedStatus);
    expect(result.stdout.includes('fixture-stopped')).toBe(expectedStatus === 0);
  });

  it.each([false, true])('refuses tasks with multiple actions before stopping any process (native launcher: %s)', (native) => {
    const command = buildStopWindowsScheduledTaskIfRunningPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
      ...(native ? {
        launcherPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default\\launcher-1\\happier-service-launcher.exe',
        diagnosticLogPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.launcher.log',
      } : {}),
    });

    const actionCountGuard = command.indexOf('if ($registeredActions.Count -ne 1)');
    expect(actionCountGuard).toBeGreaterThanOrEqual(0);
    expect(command).toContain('$registeredActions = @($task.Actions)');
    expect(actionCountGuard).toBeLessThan(command.indexOf('$registeredAction = $registeredActions[0]'));
    expect(actionCountGuard).toBeLessThan(command.indexOf('Stop-ScheduledTask'));
    expect(actionCountGuard).toBeLessThan(command.indexOf('Get-CimInstance Win32_Process'));
  });

  it('stops only an existing running task through typed scheduler state', () => {
    const command = buildStopWindowsScheduledTaskIfRunningPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    });

    expect(command).toContain('Get-ScheduledTask');
    expect(command).toContain('[int]$task.State -eq 4');
    expect(command).toContain('Get-CimInstance Win32_Process');
    expect(command).toContain('-File `"C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1`"');
    expect(command).toContain('taskkill.exe /PID $serviceProcessId /T /F');
    expect(command.indexOf('taskkill.exe')).toBeLessThan(command.lastIndexOf('Stop-ScheduledTask'));
    expect(command).toContain('Stop-ScheduledTask');
    expect(command).toContain('-ErrorAction Stop');
    expect(command.trim()).toMatch(/exit 0$/);
    expect(command).not.toContain('schtasks');
  });

  it('stops a matching native launcher through Task Scheduler so its job contains the tree', () => {
    const command = buildStopWindowsScheduledTaskIfRunningPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
      launcherPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default\\launcher-1\\happier-service-launcher.exe',
      diagnosticLogPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.launcher.log',
    });

    expect(command).toContain('$registeredLauncherRoot.Equals($expectedLauncherRoot');
    expect(command).toContain('$registeredLauncherVersionDir -match "^launcher-');
    expect(command).toContain('$registeredArguments.Equals($expectedNativeArguments');
    expect(command.indexOf('Stop-ScheduledTask')).toBeLessThan(command.indexOf('taskkill.exe'));
    expect(command).toContain('Refusing to stop scheduled task');
  });

  it('removes only an existing task without parsing localized command output', () => {
    const command = buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
    });

    expect(command).toContain('Get-ScheduledTask');
    expect(command).toContain('Unregister-ScheduledTask');
    expect(command).toContain('-Confirm:$false');
    expect(command).toContain('-ErrorAction Stop');
    expect(command.trim()).toMatch(/exit 0$/);
    expect(command).not.toContain('schtasks');
  });
});
