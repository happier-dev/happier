import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';

import { resolveSpawnDetachedNodeInvocation, type DetachedSpawnResult } from '@happier-dev/cli-common/update';

/** Not a child of the daemon, so `taskkill /T` of the service does not end the updater. */
export const WINDOWS_REMOTE_CLI_UPDATE_TASK = 'Happier\\happier-cli-remote-update';

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsRemoteCliUpdateAdmissionPath(logPath: string): string {
  return `${logPath}.admission.json`;
}

/** The task action. It runs the updater and leaves one admission line even if the updater crashes first. */
export function renderWindowsRemoteUpdateRunner(params: Readonly<{
  file: string;
  args: readonly string[];
  cwd: string;
  logPath: string;
  admissionPath: string;
  homeDir: string | null;
}>): string {
  const args = params.args.map((arg) => psLiteral(arg)).join(', ');
  const home = params.homeDir ? `$env:HAPPIER_HOME_DIR = ${psLiteral(params.homeDir)}\r\n` : '';
  return [
    "$ErrorActionPreference = 'Continue'",
    home.trimEnd(),
    "$env:HAPPIER_CLI_UPDATE_CHECK = '0'",
    `Set-Location -LiteralPath ${psLiteral(params.cwd)}`,
    `$exe = ${psLiteral(params.file)}`,
    `$log = ${psLiteral(params.logPath)}`,
    `$admission = ${psLiteral(params.admissionPath)}`,
    `& $exe @(${args}) *>> $log`,
    'if (-not (Test-Path -LiteralPath $admission)) {',
    "  $utf8 = New-Object System.Text.UTF8Encoding $false",
    "  [System.IO.File]::WriteAllText($admission, '{\"admitted\":false,\"code\":\"cli_update_failed\",\"message\":\"updater exited before admission\"}' + \"`n\", $utf8)",
    '}',
    'exit 0',
    '',
  ].filter((line) => line !== '').join('\r\n');
}

export function renderWindowsRemoteUpdateRegistration(params: Readonly<{
  runnerPath: string;
}>): string {
  const runner = psLiteral(params.runnerPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$runner = ${runner}`,
    "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File \"' + $runner + '\"')",
    "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    "Register-ScheduledTask -TaskName 'happier-cli-remote-update' -TaskPath '\\Happier\\' -Action $action -Principal $principal -Settings $settings -Force | Out-Null",
    "$task = Get-ScheduledTask -TaskPath '\\Happier\\' -TaskName 'happier-cli-remote-update'",
    "$task.Settings.ExecutionTimeLimit = 'PT0S'",
    '$task.Settings.StartWhenAvailable = $false',
    '$task.Settings.DisallowStartIfOnBatteries = $false',
    '$task.Settings.StopIfGoingOnBatteries = $false',
    'Set-ScheduledTask -InputObject $task | Out-Null',
    "schtasks.exe /Run /TN 'Happier\\happier-cli-remote-update'",
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    'exit 0',
    '',
  ].join('\r\n');
}

/** Emit the admission line, then end. A missing file keeps the stream open until the task writes one. */
export function watchAdmissionFile(path: string, readIntervalMs = 200): PassThrough {
  const stream = new PassThrough();
  const timer = setInterval(() => {
    try {
      if (!existsSync(path)) return;
      const text = readFileSync(path, 'utf8');
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      clearInterval(timer);
      stream.end(text.slice(0, newline + 1));
    } catch {
      clearInterval(timer);
      stream.end();
    }
  }, readIntervalMs);
  timer.unref();
  stream.on('close', () => clearInterval(timer));
  return stream;
}

export function spawnWindowsRemoteCliUpdate(params: Readonly<{
  script: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  admissionFdEnvName?: string;
}>, deps: Readonly<{
  execPath?: string;
  runRegistration?: (scriptPath: string) => number;
}> = {}): DetachedSpawnResult {
  const admissionPath = windowsRemoteCliUpdateAdmissionPath(params.logPath);
  const resolved = resolveSpawnDetachedNodeInvocation({
    execPath: deps.execPath ?? process.execPath,
    script: params.script,
    args: [...params.args, '--admission-path', admissionPath],
  });
  const runnerPath = `${params.logPath}.run.ps1`;
  const registrationPath = `${params.logPath}.register.ps1`;
  mkdirSync(dirname(params.logPath), { recursive: true });
  rmSync(admissionPath, { force: true });
  writeFileSync(runnerPath, renderWindowsRemoteUpdateRunner({
    file: resolved.file,
    args: resolved.args,
    cwd: resolved.isRuntime ? params.cwd : process.cwd(),
    logPath: params.logPath,
    admissionPath,
    homeDir: params.env.HAPPIER_HOME_DIR?.trim() || null,
  }), 'utf8');
  writeFileSync(registrationPath, renderWindowsRemoteUpdateRegistration({ runnerPath }), 'utf8');
  const runRegistration = deps.runRegistration ?? ((scriptPath: string) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return typeof result.status === 'number' ? result.status : 1;
  });
  if (runRegistration(registrationPath) !== 0) return { started: false, admission: null };
  return { started: true, admission: watchAdmissionFile(admissionPath) };
}
