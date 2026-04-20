function psDoubleQuote(s: string): string {
  // PowerShell double-quoted string escape: `"
  return String(s ?? '').replaceAll('`', '``').replaceAll('"', '`"');
}

function psQuoted(s: string): string {
  return `"${psDoubleQuote(s)}"`;
}

export type WindowsScheduledTaskStatusSnapshot = Readonly<{
  exists: boolean;
  enabled: boolean;
  active: boolean;
  stateLabel: string;
  stateValue: number | null;
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
    '  [pscustomobject]@{ exists = $false; enabled = $false; active = $false; stateLabel = "not_installed"; stateValue = $null } | ConvertTo-Json -Compress',
    '  exit 0',
    '}',
    '$taskInfo = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop',
    '$stateLabel = if ($null -ne $taskInfo.State) { $taskInfo.State.ToString() } else { "" }',
    '$stateValue = if ($null -ne $taskInfo.State) { [int]$taskInfo.State } else { $null }',
    '$enabled = if ($null -ne $task.Settings) { [bool]$task.Settings.Enabled } else { $false }',
    '$active = $stateValue -eq 4',
    '[pscustomobject]@{ exists = $true; enabled = $enabled; active = $active; stateLabel = $stateLabel; stateValue = $stateValue } | ConvertTo-Json -Compress',
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
    };
    const stateValue = typeof parsed.stateValue === 'number' && Number.isInteger(parsed.stateValue)
      ? parsed.stateValue
      : null;
    return {
      exists: parsed.exists === true,
      enabled: parsed.enabled === true,
      active: parsed.active === true || stateValue === 4,
      stateLabel: typeof parsed.stateLabel === 'string' ? parsed.stateLabel.trim() : '',
      stateValue,
    };
  } catch {
    return null;
  }
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
    wd ? `Set-Location -LiteralPath ${psQuoted(wd)}` : '',
    envLines,
    cmd ? `${cmd}${redirect}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}
