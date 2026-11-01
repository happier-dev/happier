function psDoubleQuote(s: string): string {
  // Escape the escape character before interpolation and quote characters.
  return String(s ?? '').replaceAll('`', '``').replaceAll('$', '`$').replaceAll('"', '`"');
}

function psQuoted(s: string): string {
  return `"${psDoubleQuote(s)}"`;
}

/** Read a literal emitted by this renderer, or a legacy single-quoted definition value. */
export function parsePowerShellQuotedString(value: string): string | null {
  const match = /^"((?:[^"`]|`.)*)"|^'((?:[^']|'')*)'/u.exec(value.trim());
  if (!match) return null;
  return match[1] === undefined
    ? match[2].replaceAll("''", "'")
    : match[1].replace(/`([`$"])/gu, '$1');
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

export type WindowsScheduledTaskAction = Readonly<{
  executable: string;
  arguments: string;
}>;

export function buildWindowsScheduledTaskLauncherAction(params: Readonly<{
  launcherPath: string;
  definitionPath: string;
  diagnosticLogPath: string;
}>): WindowsScheduledTaskAction {
  const launcherPath = String(params.launcherPath ?? '').trim();
  const definitionPath = String(params.definitionPath ?? '').trim();
  const diagnosticLogPath = String(params.diagnosticLogPath ?? '').trim();
  if (!launcherPath) throw new Error('launcherPath is required for Windows scheduled task action');
  if (!definitionPath) throw new Error('definitionPath is required for Windows scheduled task action');
  if (!diagnosticLogPath) throw new Error('diagnosticLogPath is required for Windows scheduled task action');
  return {
    executable: launcherPath,
    arguments: `--wrapper ${quoteWindowsCommandLineArgument(definitionPath)} --diagnostic-log ${quoteWindowsCommandLineArgument(diagnosticLogPath)}`,
  };
}

export function isWindowsScheduledTaskLauncherActionExpected(params: Readonly<{
  taskToRun: string;
  launcherPath: string;
  definitionPath: string;
  diagnosticLogPath: string;
}>): boolean {
  const taskToRun = String(params.taskToRun ?? '').trim();
  if (!taskToRun) return false;
  const expected = buildWindowsScheduledTaskLauncherAction(params);
  // Windows executable paths ignore casing; option names and arguments retain the
  // launcher's exact contract. Discovery and install verification use this same rule.
  const argumentsSuffix = ` ${expected.arguments}`;
  return taskToRun.endsWith(argumentsSuffix)
    && taskToRun.slice(0, -argumentsSuffix.length).toLowerCase() === expected.executable.toLowerCase();
}

/** Register only the invoking user's interactive task, never an all-users logon trigger. */
export function buildRegisterWindowsUserScheduledTaskPowerShellCommand(params: Readonly<{
  qualifiedTaskName: string;
  definitionPath: string;
  persistent: boolean;
  action?: WindowsScheduledTaskAction;
}>): string {
  const { taskName, taskPath } = splitQualifiedWindowsScheduledTaskName(params.qualifiedTaskName);
  const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const action = params.action ?? {
    executable: 'powershell.exe',
    arguments: buildWindowsScheduledTaskPowerShellAction({ definitionPath: params.definitionPath }).slice('powershell.exe '.length),
  };
  const xml = '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
    + (params.persistent
      ? '<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>current-user</UserId></LogonTrigger></Triggers>'
      : '<Triggers/>')
    + '<Principals><Principal id="Author"><UserId>current-user</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>'
    + '<Actions Context="Author"><Exec><Command>' + xmlEscape(action.executable) + '</Command><Arguments>'
    + xmlEscape(action.arguments) + '</Arguments></Exec></Actions></Task>';
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
  launcherPath?: string;
  diagnosticLogPath?: string;
}>): string {
  const { taskName, taskPath } = splitQualifiedWindowsScheduledTaskName(params.qualifiedTaskName);
  const definitionPath = String(params.definitionPath ?? '').trim();
  if (!definitionPath) throw new Error('definitionPath is required for Windows scheduled task stop');
  const wrapperActionToken = `-File "${definitionPath}"`;
  const launcherPath = String(params.launcherPath ?? '').trim();
  const expectedNativeArguments = launcherPath && params.diagnosticLogPath
    ? buildWindowsScheduledTaskLauncherAction({
        launcherPath,
        definitionPath,
        diagnosticLogPath: params.diagnosticLogPath,
      }).arguments
    : '';
  const expectedLegacyArguments = [
    buildWindowsScheduledTaskPowerShellAction({ definitionPath }).slice('powershell.exe '.length),
    // cli-v0.2.1 emitted this action; its registered task can survive later CLI updates.
    `-NoProfile -ExecutionPolicy Bypass -File "${definitionPath}"`,
  ];
  return [
    '$ErrorActionPreference = "Stop"',
    `$taskPath = ${psQuoted(taskPath)}`,
    `$taskName = ${psQuoted(taskName)}`,
    `$definitionPath = ${psQuoted(definitionPath)}`,
    `$wrapperActionToken = ${psQuoted(wrapperActionToken)}`,
    `$launcherPath = ${psQuoted(launcherPath)}`,
    `$expectedNativeArguments = ${psQuoted(expectedNativeArguments)}`,
    `$expectedLegacyArguments = @(${expectedLegacyArguments.map(psQuoted).join(', ')})`,
    '$expectedLauncherRoot = Join-Path (Split-Path -Parent $definitionPath) ([IO.Path]::GetFileNameWithoutExtension($definitionPath))',
    '$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue',
    'if ($null -ne $task -and [int]$task.State -eq 4) {',
    '  $registeredActions = @($task.Actions)',
    '  if ($registeredActions.Count -ne 1) {',
    '    throw "Refusing to stop scheduled task because it does not have exactly one registered action"',
    '  }',
    '  $registeredAction = $registeredActions[0]',
    '  $registeredExecute = if ($null -ne $registeredAction.Execute) { [string]$registeredAction.Execute } else { "" }',
    '  $registeredArguments = if ($null -ne $registeredAction.Arguments) { [string]$registeredAction.Arguments } else { "" }',
    '  $registeredLauncherParent = if ($registeredExecute) { Split-Path -Parent $registeredExecute } else { "" }',
    '  $registeredLauncherVersionDir = if ($registeredLauncherParent) { Split-Path -Leaf $registeredLauncherParent } else { "" }',
    '  $registeredLauncherRoot = if ($registeredLauncherParent) { Split-Path -Parent $registeredLauncherParent } else { "" }',
    '  $isNativeAction = $launcherPath -and ([IO.Path]::GetFileName($registeredExecute)).Equals("happier-service-launcher.exe", [StringComparison]::OrdinalIgnoreCase) -and $registeredLauncherRoot.Equals($expectedLauncherRoot, [StringComparison]::OrdinalIgnoreCase) -and $registeredLauncherVersionDir -match "^launcher-[A-Za-z0-9._-]+$" -and $registeredArguments.Equals($expectedNativeArguments, [StringComparison]::Ordinal)',
    '  if ($isNativeAction) {',
    // The launcher owns the wrapper tree in a kill-on-close job. Task Scheduler
    // terminates the registered launcher; forced launcher loss then closes the
    // job and contains only that task-owned tree.
    '    Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop',
    '    exit 0',
    '  }',
    '  $isExpectedLegacyArguments = @($expectedLegacyArguments | Where-Object { $registeredArguments.Equals($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0',
    '  if (-not $registeredExecute.Equals("powershell.exe", [StringComparison]::OrdinalIgnoreCase) -or -not $isExpectedLegacyArguments) {',
    '    throw "Refusing to stop scheduled task because its registered action is not the expected Happier launcher or legacy wrapper"',
    '  }',
    // Stop-ScheduledTask terminates the PowerShell action but can leave the
    // executable launched by that wrapper running. Find only this task's
    // wrapper by its exact -File argument, then terminate each direct child
    // process tree while the wrapper is still alive. This also works for
    // wrappers installed before this lifecycle fix.
    '  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '  $wrapperProcessIds = @($allProcesses | Where-Object { ([string]$_.CommandLine).IndexOf($wrapperActionToken, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { [int]$_.ProcessId })',
    '  $serviceProcessIds = @($allProcesses | Where-Object { $wrapperProcessIds -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })',
    '  foreach ($serviceProcessId in $serviceProcessIds) {',
    '    & taskkill.exe /PID $serviceProcessId /T /F | Out-Null',
    '    if ($LASTEXITCODE -ne 0 -and $null -ne (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue)) {',
    '      throw "Failed to stop scheduled task child process $serviceProcessId (taskkill exit $LASTEXITCODE)"',
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

/**
 * List the tasks in one Task Scheduler folder as invariant JSON (`["\\Happier\\task", ...]`).
 *
 * `schtasks /Query` without `/TN` enumerates every task on the machine, which can exceed the
 * schtasks timeout on hosts with many tasks; with `/TN <folder>` a missing folder is only a
 * localized error message. The scheduler API reports a missing folder as FileNotFoundException.
 */
export function buildListWindowsScheduledTaskFolderPowerShellCommand(params: Readonly<{
  taskFolder: string;
}>): string {
  const folderPath = `\\${String(params.taskFolder ?? '').split(/[\\/]+/u).filter(Boolean).join('\\')}`;
  return [
    '$ErrorActionPreference = "Stop"',
    '$scheduler = New-Object -ComObject Schedule.Service',
    '$scheduler.Connect()',
    `try { $folder = $scheduler.GetFolder(${psQuoted(folderPath)}) } catch [System.IO.FileNotFoundException] { "[]"; exit 0 }`,
    // TASK_ENUM_HIDDEN=1 so hidden tasks are listed too.
    'ConvertTo-Json -Compress -InputObject @(@($folder.GetTasks(1)) | ForEach-Object { [string]$_.Path })',
  ].join('; ');
}

export function parseWindowsScheduledTaskFolderPowerShellJson(text: string): readonly string[] | null {
  const trimmed = String(text ?? '').trim();
  // Missing and empty folders both produce explicit []; blank output cannot establish absence.
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
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
}>;

export function buildReadWindowsScheduledTaskStatusPowerShellCommand(params: Readonly<{
  taskName: string;
  taskPath?: string;
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
    '[pscustomobject]@{ exists = $true; enabled = $enabled; active = $active; stateLabel = $stateLabel; stateValue = $stateValue; lastRunTime = $lastRunTime; lastTaskResult = $lastTaskResult; taskToRun = $taskToRun } | ConvertTo-Json -Compress',
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

function quoteWindowsCommandLineArgument(value: string): string {
  const source = String(value ?? '');
  return `"${source.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/gu, '$1$1')}"`;
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
  const redirect = out || err ? ` 1>> ${psQuoted(out)} 2>> ${psQuoted(err)}` : '';

  return [
    '$ErrorActionPreference = "Stop"',
    // Setup failures (and a missing program) terminate before any redirect is in place;
    // record them where launch diagnostics look instead of only in the task's exit code.
    err ? `trap { $_ | Out-File -LiteralPath ${psQuoted(err)} -Append; exit 1 }` : '',
    wd ? `Set-Location -LiteralPath ${psQuoted(wd)}` : '',
    envLines,
    // Windows PowerShell 5.1 wraps each redirected native stderr line in an ErrorRecord, so
    // under "Stop" the first warning the program prints would terminate the wrapper (#539).
    cmd ? '$ErrorActionPreference = "Continue"' : '',
    cmd ? `${cmd}${redirect}` : '',
    cmd ? 'exit $LASTEXITCODE' : '',
    '',
  ]
    .filter(Boolean)
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
  /**
   * Whether Task Scheduler may run a *missed* scheduled start as soon as possible
   * (`-StartWhenAvailable`). Defaults to true, which is what a task with a real login/boot trigger
   * wants: a machine asleep at logon should still start it. Pass false for a task whose trigger is
   * deliberately in the past — catching that up is the one way such a trigger could ever fire.
   */
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
