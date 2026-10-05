function psDoubleQuote(s: string): string {
  // PowerShell double-quoted string escapes use the backtick. Escape the
  // escape character first so later escapes remain syntactic.
  return String(s ?? '')
    .replaceAll('`', '``')
    .replaceAll('$', '`$')
    .replaceAll('"', '`"');
}

function psQuoted(s: string): string {
  return `"${psDoubleQuote(s)}"`;
}

export function splitQualifiedWindowsScheduledTaskName(qualifiedTaskName: string): Readonly<{
  taskName: string;
  taskPath: string;
}> {
  const parts = String(qualifiedTaskName ?? '')
    .trim()
    .replaceAll('/', '\\')
    .split('\\')
    .filter(Boolean);
  const taskName = parts.pop() ?? '';
  if (!taskName) throw new Error('qualifiedTaskName is required for Windows scheduled task control');
  return {
    taskName,
    taskPath: parts.length > 0 ? `\\${parts.join('\\')}\\` : '\\',
  };
}

/** Register only the invoking user's interactive task, never an all-users logon trigger. */
export function buildRegisterWindowsUserScheduledTaskPowerShellCommand(params: Readonly<{
  qualifiedTaskName: string;
  definitionPath: string;
  persistent: boolean;
}>): string {
  const { taskName, taskPath } = splitQualifiedWindowsScheduledTaskName(params.qualifiedTaskName);
  const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const action = buildWindowsScheduledTaskPowerShellAction({ definitionPath: params.definitionPath });
  const xml = '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
    + (params.persistent
      ? '<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>current-user</UserId></LogonTrigger></Triggers>'
      : '<Triggers/>')
    + '<Principals><Principal id="Author"><UserId>current-user</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>'
    + '<Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>'
    + xmlEscape(action.slice('powershell.exe '.length)) + '</Arguments></Exec></Actions></Task>';
  return [
    '$ErrorActionPreference = "Stop"',
    '$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    `[xml]$xml = ${literal(xml)}`,
    '$xml.Task.Principals.Principal.UserId = $userId',
    ...(params.persistent ? ['$xml.Task.Triggers.LogonTrigger.UserId = $userId'] : []),
    '$scheduler = New-Object -ComObject Schedule.Service',
    '$scheduler.Connect()',
    // Create the existing task namespace only when absent; access failures must remain failures.
    '$folder = $scheduler.GetFolder("\\")',
    ...taskPath.split('\\').filter(Boolean).map((part) =>
      `$child = $folder.GetFolders(0) | Where-Object { $_.Name -eq ${literal(part)} }; if ($null -eq $child) { $child = $folder.CreateFolder(${literal(part)}) }; $folder = $child`),
    `$taskName = ${literal(taskName)}`,
    // TASK_CREATE_OR_UPDATE=6, TASK_LOGON_INTERACTIVE_TOKEN=3: no password or elevation.
    '$folder.RegisterTask($taskName, $xml.OuterXml, 6, $userId, $null, 3, $null) | Out-Null',
  ].join('; ');
}

export function buildStopWindowsScheduledTaskIfRunningPowerShellCommand(params: Readonly<{
  qualifiedTaskName: string;
  definitionPath: string;
}>): string {
  const { taskName, taskPath } = splitQualifiedWindowsScheduledTaskName(params.qualifiedTaskName);
  const definitionPath = String(params.definitionPath ?? '').trim();
  if (!definitionPath) throw new Error('definitionPath is required for Windows scheduled task stop');
  const wrapperActionToken = `-File "${definitionPath}"`;
  return [
    '$ErrorActionPreference = "Stop"',
    `$taskPath = ${psQuoted(taskPath)}`,
    `$taskName = ${psQuoted(taskName)}`,
    `$wrapperActionToken = ${psQuoted(wrapperActionToken)}`,
    '$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue',
    'if ($null -ne $task -and [int]$task.State -eq 4) {',
    // Stop-ScheduledTask terminates the PowerShell action but can leave the
    // executable launched by that wrapper running. Find only this task's
    // wrapper by its exact -File argument, then terminate each direct child
    // process tree while the wrapper is still alive. This also works for
    // wrappers installed before this lifecycle fix.
    '  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '  $wrapperProcessIds = @($allProcesses | Where-Object { ([string]$_.CommandLine).IndexOf($wrapperActionToken, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { [int]$_.ProcessId })',
    '  $serviceProcessIds = @($allProcesses | Where-Object { $wrapperProcessIds -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })',
    '  foreach ($serviceProcessId in $serviceProcessIds) {',
    '    $taskkillProcess = Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", [string]$serviceProcessId, "/T", "/F") -NoNewWindow -Wait -PassThru',
    '    $taskkillExitCode = $taskkillProcess.ExitCode',
    '    if ($taskkillExitCode -ne 0 -and $null -ne (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue)) {',
    '      throw "Failed to stop scheduled task child process $serviceProcessId (taskkill exit $taskkillExitCode)"',
    '    }',
    '    Wait-Process -Id $serviceProcessId -Timeout 10 -ErrorAction SilentlyContinue',
    '    if ($null -ne (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue)) {',
    '      throw "Failed to wait for scheduled task child process $serviceProcessId to exit"',
    '    }',
    '  }',
    '  $task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue',
    '  if ($null -ne $task -and [int]$task.State -eq 4) {',
    '    Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop',
    '  }',
    '}',
    // A missing task is the intended no-op. Get-ScheduledTask with
    // SilentlyContinue still leaves PowerShell's process status at 1 unless
    // successful completion is made explicit.
    'exit 0',
  ].join('; ');
}

export function buildSetWindowsScheduledTaskEnabledPowerShellCommand(params: Readonly<{
  qualifiedTaskName: string;
  enabled: boolean;
}>): string {
  const { taskName, taskPath } = splitQualifiedWindowsScheduledTaskName(params.qualifiedTaskName);
  const command = params.enabled ? 'Enable-ScheduledTask' : 'Disable-ScheduledTask';
  return [
    '$ErrorActionPreference = "Stop"',
    `$taskPath = ${psQuoted(taskPath)}`,
    `$taskName = ${psQuoted(taskName)}`,
    '$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue',
    `if ($null -ne $task) { ${command} -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop | Out-Null }`,
    'exit 0',
  ].join('; ');
}

export function buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand(params: Readonly<{
  qualifiedTaskName: string;
}>): string {
  const { taskName, taskPath } = splitQualifiedWindowsScheduledTaskName(params.qualifiedTaskName);
  return [
    '$ErrorActionPreference = "Stop"',
    `$taskPath = ${psQuoted(taskPath)}`,
    `$taskName = ${psQuoted(taskName)}`,
    '$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue',
    'if ($null -ne $task) {',
    '  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop',
    '}',
    'exit 0',
  ].join('; ');
}

export type WindowsScheduledTaskStatusSnapshot = Readonly<{
  exists: boolean;
  enabled: boolean;
  active: boolean;
  stateLabel: string;
  stateValue: number | null;
  lastRunTime: string;
  lastTaskResult: number | null;
  taskToRun: string;
  autostart?: boolean | null;
}>;

export function buildReadWindowsScheduledTaskStatusPowerShellCommand(params: Readonly<{
  taskName: string;
  taskPath?: string;
  includeAutostart?: boolean;
}>): string {
  const taskName = String(params.taskName ?? '').trim();
  const taskPath = String(params.taskPath ?? '\\Happier\\').trim() || '\\Happier\\';
  return [
    '$ErrorActionPreference = "Stop"',
    `$taskPath = ${psQuoted(taskPath)}`,
    `$taskName = ${psQuoted(taskName)}`,
    '$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue',
    'if ($null -eq $task) {',
    '  [pscustomobject]@{ exists = $false; enabled = $false; active = $false; stateLabel = "not_installed"; stateValue = $null; lastRunTime = ""; lastTaskResult = $null; taskToRun = "" } | ConvertTo-Json -Compress',
    '  exit 0',
    '}',
    '$taskInfo = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop',
    '$stateLabel = if ($null -ne $task.State) { $task.State.ToString() } elseif ($null -ne $taskInfo.State) { $taskInfo.State.ToString() } else { "" }',
    '$stateValue = if ($null -ne $task.State) { [int]$task.State } elseif ($null -ne $taskInfo.State) { [int]$taskInfo.State } else { $null }',
    '$enabled = if ($null -ne $task.Settings) { [bool]$task.Settings.Enabled } else { $false }',
    '$active = $stateValue -eq 4',
    '$lastRunTime = if ($null -ne $taskInfo.LastRunTime) { $taskInfo.LastRunTime.ToString("o") } else { "" }',
    '$lastTaskResult = if ($null -ne $taskInfo.LastTaskResult) { [int64]$taskInfo.LastTaskResult } else { $null }',
    '$taskToRun = (@($task.Actions | ForEach-Object { $execute = if ($null -ne $_.Execute) { $_.Execute.ToString() } else { "" }; $arguments = if ($null -ne $_.Arguments) { $_.Arguments.ToString() } else { "" }; if ($execute.Trim()) { ($execute + " " + $arguments).Trim() } else { $_.ToString() } }) -join "; ")',
    ...(params.includeAutostart ? ['$autostart = @($task.Triggers | Where-Object { $_.Enabled -ne $false -and $_.CimClass.CimClassName -in @("MSFT_TaskLogonTrigger", "MSFT_TaskBootTrigger") }).Count -gt 0'] : []),
    `[pscustomobject]@{ exists = $true; enabled = $enabled; active = $active; stateLabel = $stateLabel; stateValue = $stateValue; lastRunTime = $lastRunTime; lastTaskResult = $lastTaskResult; taskToRun = $taskToRun${params.includeAutostart ? '; autostart = $autostart' : ''} } | ConvertTo-Json -Compress`,
  ].join('; ');
}

export function parseWindowsScheduledTaskStatusPowerShellJson(text: string): WindowsScheduledTaskStatusSnapshot | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      exists?: unknown;
      enabled?: unknown;
      active?: unknown;
      stateLabel?: unknown;
      stateValue?: unknown;
      lastRunTime?: unknown;
      lastTaskResult?: unknown;
      taskToRun?: unknown;
      autostart?: unknown;
    };
    const stateValue = typeof parsed.stateValue === 'number' && Number.isInteger(parsed.stateValue)
      ? parsed.stateValue
      : null;
    const lastTaskResult = typeof parsed.lastTaskResult === 'number' && Number.isInteger(parsed.lastTaskResult)
      ? parsed.lastTaskResult
      : null;
    return {
      exists: parsed.exists === true,
      enabled: parsed.enabled === true,
      active: parsed.active === true || stateValue === 4,
      stateLabel: typeof parsed.stateLabel === 'string' ? parsed.stateLabel.trim() : '',
      stateValue,
      lastRunTime: typeof parsed.lastRunTime === 'string' ? parsed.lastRunTime.trim() : '',
      lastTaskResult,
      taskToRun: typeof parsed.taskToRun === 'string' ? parsed.taskToRun.trim() : '',
      ...('autostart' in parsed ? { autostart: typeof parsed.autostart === 'boolean' ? parsed.autostart : null } : {}),
    };
  } catch {
    return null;
  }
}

export function buildWindowsScheduledTaskPowerShellAction(params: Readonly<{
  definitionPath: string;
}>): string {
  const definitionPath = String(params.definitionPath ?? '').trim();
  if (!definitionPath) throw new Error('definitionPath is required for Windows scheduled task action');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${definitionPath}"`;
}

export function renderWindowsScheduledTaskWrapperPs1(params: Readonly<{
  workingDirectory?: string;
  programArgs?: readonly string[];
  env?: Record<string, string>;
  stdoutPath?: string;
  stderrPath?: string;
}>): string {
  const wd = String(params.workingDirectory ?? '').trim();
  const args = Array.isArray(params.programArgs) ? params.programArgs.map((a) => String(a ?? '')).filter(Boolean) : [];
  const out = String(params.stdoutPath ?? '').trim();
  const err = String(params.stderrPath ?? '').trim();

  const envLines = Object.entries(params.env ?? {})
    .filter(([k]) => String(k ?? '').trim())
    .map(([k, v]) => `$env:${String(k).trim()} = ${psQuoted(String(v ?? ''))}`)
    .join('\n');

  const cmd = args.length ? `& ${args.map(psQuoted).join(' ')}` : '';
  const redirect = [
    out ? `1>> ${psQuoted(out)}` : '',
    err ? `2>> ${psQuoted(err)}` : '',
  ].filter(Boolean).join(' ');
  const body = [
    wd ? `Set-Location -LiteralPath ${psQuoted(wd)}` : '',
    envLines,
    cmd ? '$LASTEXITCODE = 1' : '',
    cmd ? '$ErrorActionPreference = "Continue"' : '',
    cmd ? `${cmd}${redirect ? ` ${redirect}` : ''}` : '',
    cmd ? '$exitCode = $LASTEXITCODE' : '',
    cmd ? 'exit $exitCode' : '',
  ].filter(Boolean);
  const diagnosticPath = err || out;

  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    ...body.map((line) => line.split('\n').map((part) => `  ${part}`).join('\n')),
    '} catch {',
    diagnosticPath
      ? `  ($_ | Out-String) | Add-Content -LiteralPath ${psQuoted(diagnosticPath)}`
      : '  Write-Error ($_ | Out-String)',
    '  exit 1',
    '}',
    '',
  ]
    .join('\n');
}
/**
 * Apply the Task Scheduler settings a long-running background process needs.
 *
 * systemd gets `Restart=` and launchd gets `KeepAlive`; a scheduled task created
 * with `schtasks /Create` gets none of that, so a Happier daemon or relay that
 * exits on Windows stays dead until the next logon or boot. These settings close
 * that gap and three neighbouring Task Scheduler defaults that are wrong for a
 * service:
 *
 * - tasks are stopped after three days (`ExecutionTimeLimit`);
 * - tasks refuse to start on battery and are stopped when the machine unplugs;
 * - a trigger missed while the machine was off never fires.
 */
export function buildApplyWindowsScheduledTaskServicePolicyPowerShellCommand(params: Readonly<{
  qualifiedTaskName: string;
  /** `no` keeps the hardening but does not restart a failed run. */
  restartPolicy: 'always' | 'on-failure' | 'no';
  restartIntervalMinutes?: number;
  restartCount?: number;
  /** No missed-start catch-up for an on-demand task. */
  catchUpMissedStart?: boolean;
}>): string {
  const { taskName, taskPath } = splitQualifiedWindowsScheduledTaskName(params.qualifiedTaskName);
  const restartIntervalMinutes = Number.isFinite(params.restartIntervalMinutes)
    ? Math.max(1, Math.trunc(Number(params.restartIntervalMinutes)))
    : 1;
  const restartCount = Number.isFinite(params.restartCount)
    ? Math.max(1, Math.trunc(Number(params.restartCount)))
    : 3;

  // Task Scheduler only models restart-on-failure, so `always` and `on-failure`
  // resolve to the same settings. `no` opts out of restarting only.
  const restartArgs = params.restartPolicy === 'no'
    ? []
    : [
      `-RestartCount ${restartCount}`,
      `-RestartInterval (New-TimeSpan -Minutes ${restartIntervalMinutes})`,
    ];

  const settingsArgs = [
    ...restartArgs,
    // Zero means "no limit" — without it the task is killed after three days.
    '-ExecutionTimeLimit (New-TimeSpan -Seconds 0)',
    '-AllowStartIfOnBatteries',
    '-DontStopIfGoingOnBatteries',
    ...(params.catchUpMissedStart === false ? [] : ['-StartWhenAvailable']),
    '-MultipleInstances IgnoreNew',
  ].join(' ');

  return [
    '$ErrorActionPreference = "Stop"',
    `$taskPath = ${psQuoted(taskPath)}`,
    `$taskName = ${psQuoted(taskName)}`,
    `$settings = New-ScheduledTaskSettingsSet ${settingsArgs}`,
    'Set-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Settings $settings | Out-Null',
  ].join('; ');
}
