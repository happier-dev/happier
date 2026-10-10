import { runCaptureResult } from '../proc/proc.mjs';
import { buildRemotePowerShellCommand } from './remote_commands.mjs';

export const LINUX_WORKER_SLEEP_TARGETS = ['sleep.target', 'suspend.target', 'hibernate.target', 'hybrid-sleep.target', 'suspend-then-hibernate.target'];

const WINDOWS_POWER_SETTINGS = [
  ['29f6c1db-86da-48c5-9fdb-f2b67b1f44da', 'SUB_SLEEP', 'STANDBYIDLE', 'standby-timeout-'],
  ['9d7815a6-7ee4-497e-8888-515a05f02364', 'SUB_SLEEP', 'HIBERNATEIDLE', 'hibernate-timeout-'],
  ['7bc4a2f9-d8fc-4469-b07b-33eb785aaca0', 'SUB_SLEEP', 'UNATTENDSLEEP'],
  ['5ca83367-6e45-459f-a27b-476b1d01c936', 'SUB_BUTTONS', 'LIDACTION'],
];

function windowsPowerFunctions() {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Set-WorkerPowerSetting($guid, $index, $commandArgs) {
  # A machine policy already enforcing zero cannot be changed by powercfg.
  $policy = $null
  try { $policy = Get-ItemPropertyValue -LiteralPath ('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\' + $guid) -Name $index -ErrorAction Stop } catch {}
  if (($policy -is [int] -or $policy -is [uint32]) -and $policy -eq 0) { return }
  & powercfg.exe @commandArgs
  if ($LASTEXITCODE -ne 0) { throw ('powercfg failed: ' + ($commandArgs -join ' ')) }
}
function Set-WorkerPowerSettings {
$failures = @()
foreach ($supply in @('ac','dc')) {
  $index = if ($supply -eq 'ac') { 'ACSettingIndex' } else { 'DCSettingIndex' }
${WINDOWS_POWER_SETTINGS.map(([guid, group, alias, timeout]) => `  try { Set-WorkerPowerSetting '${guid}' $index ${timeout ? `@('/change',('${timeout}'+$supply),'0')` : `@(('/set'+$supply+'valueindex'),'SCHEME_CURRENT','${group}','${alias}','0')`} } catch { $failures += $_.Exception.Message }`).join('\n')}
}
& powercfg.exe /setactive SCHEME_CURRENT
if ($LASTEXITCODE -ne 0) { $failures += 'powercfg failed to activate the worker power settings' }
return $failures
}
function Test-WorkerPowerSettings {
  $failures = @()
  foreach ($setting in @(
${WINDOWS_POWER_SETTINGS.map(([guid, group, alias]) => `    ,@('${guid}','${group}','${alias}')`).join('\n')}
  )) {
    $output = & powercfg.exe /qh SCHEME_CURRENT $setting[1] $setting[0]
    if ($LASTEXITCODE -ne 0) { $failures += ('Cannot read '+$setting[2]); continue }
    # Only the two final hex-valued lines are the current AC/DC indices.
    # Labels are localized; their numeric representation is locale independent.
    $indices = @($output | ForEach-Object { if ($_ -match ':\\s*(0x[0-9a-fA-F]+)\\s*$') { [Convert]::ToUInt32($matches[1].Substring(2),16) } } | Select-Object -Last 2)
    if ($indices.Count -ne 2) { $failures += ('Invalid powercfg result for '+$setting[2]); continue }
    foreach ($supply in 0,1) {
      $index = if ($supply -eq 0) { 'ACSettingIndex' } else { 'DCSettingIndex' }
      $effective = $indices[$supply]
      try { $effective = Get-ItemPropertyValue -LiteralPath ('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\'+$setting[0]) -Name $index -ErrorAction Stop } catch {}
      if ($effective -ne 0) { $failures += ($setting[2]+' '+$index+'='+$effective) }
    }
  }
  return $failures
}
`;
}

function windowsKeepAwakeScript() {
  return windowsPowerFunctions() + `
$failures = @(Set-WorkerPowerSettings) + @(Test-WorkerPowerSettings)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class HappierWorkerPower {
  [StructLayout(LayoutKind.Sequential)] public struct DetailedReason {
    public IntPtr Module; public uint Id; public uint Count; public IntPtr Strings;
  }
  [StructLayout(LayoutKind.Explicit)] public struct ReasonText {
    [FieldOffset(0)] public IntPtr Simple;
    [FieldOffset(0)] public DetailedReason Detailed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Reason {
    public uint Version; public uint Flags; public ReasonText Text;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr PowerCreateRequest(ref Reason reason);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool PowerSetRequest(IntPtr request, int type);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool PowerClearRequest(IntPtr request, int type);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Hold() {
    var text = Marshal.StringToHGlobalUni("Happier worker no-sleep");
    IntPtr request;
    try { var reason = new Reason { Version=0, Flags=1, Text=new ReasonText { Simple=text } }; request=PowerCreateRequest(ref reason); }
    finally { Marshal.FreeHGlobal(text); }
    if (request == IntPtr.Zero || request == new IntPtr(-1)) throw new Win32Exception();
    if (!PowerSetRequest(request, 1)) { var error=Marshal.GetLastWin32Error(); CloseHandle(request); throw new Win32Exception(error); }
    return request;
  }
  public static void Release(IntPtr request) { PowerClearRequest(request, 1); CloseHandle(request); }
}
'@
$request = [HappierWorkerPower]::Hold()
try {
  # The request keeps Modern Standby workers available on AC without forcing
  # the display on. Windows limits requests on battery; explicit sleep wins.
  [ordered]@{ok=($failures.Count -eq 0);verifiedAt=[DateTime]::UtcNow.ToString('o');errors=$failures} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'status.json') -Encoding UTF8
  [Threading.Thread]::Sleep([Threading.Timeout]::Infinite)
} finally { [HappierWorkerPower]::Release($request) }
`;
}

export function buildWorkerPowerScript(platform, { action = 'configure' } = {}) {
  if (platform === 'windows') {
    if (action === 'install') {
      const encoded = Buffer.from(windowsKeepAwakeScript()).toString('base64');
      return windowsPowerFunctions() + `
$directory = Join-Path $env:ProgramData 'Happier/worker-power'
$file = Join-Path $directory 'keep-awake.ps1'
$program = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$changed = !(Test-Path -LiteralPath $file) -or [IO.File]::ReadAllText($file) -ne $program
New-Item -ItemType Directory -Path $directory -Force | Out-Null
# SYSTEM executes these bytes: only administrators and SYSTEM may write them.
& icacls.exe $directory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot secure worker power script directory' }
$taskName = 'Happier-Worker-Power'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($changed) {
  if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
  [IO.File]::WriteAllText($file,$program,(New-Object Text.UTF8Encoding($false)))
}
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$file+'"')
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$triggers = @(New-ScheduledTaskTrigger -AtStartup; New-ScheduledTaskTrigger -AtLogOn)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { Start-ScheduledTask -TaskName $taskName }
$failures = @(Set-WorkerPowerSettings) + @(Test-WorkerPowerSettings)
if ($failures.Count) { throw ($failures -join '; ') }
`;
    }
    if (action === 'inspect') return windowsPowerFunctions() + `
$failures = @(Test-WorkerPowerSettings)
$task = Get-ScheduledTask -TaskName 'Happier-Worker-Power' -ErrorAction SilentlyContinue
if (!$task -or $task.State -ne 'Running') { $failures += 'Happier-Worker-Power boot keep-awake task is not running' }
elseif (!@($task.Triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' -and $_.Enabled}).Count) { $failures += 'Worker power task has no enabled boot trigger' }
if ($task) {
  if ($task.Settings.ExecutionTimeLimit -notin @('PT0S',[TimeSpan]::Zero) -or $task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries) { $failures += 'Worker power task can expire or stop on battery' }
  if ($task.Principal.UserId -notmatch '^(SYSTEM|S-1-5-18|NT AUTHORITY\\\\SYSTEM)$' -or [string]$task.Principal.RunLevel -ne 'Highest') { $failures += 'Worker power task must run as elevated SYSTEM' }
}
$requests = & powercfg.exe /requests
if ($LASTEXITCODE -ne 0 -or ($requests -join '\n') -notmatch 'Happier worker no-sleep') { $failures += 'Worker system power request is not active' }
Write-Output ('__HAPPIER_WORKER_POWER__='+([ordered]@{ok=($failures.Count -eq 0);detail=($failures -join '; ')} | ConvertTo-Json -Compress))
`;
    return windowsPowerFunctions() + `
$failures = @(Set-WorkerPowerSettings)
if ($failures.Count) { throw ($failures -join '; ') }
`;
  }
  const linuxPowerCheck = `
linux_power_healthy() {
  for unit in ${LINUX_WORKER_SLEEP_TARGETS.join(' ')}; do
    state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
    [ "$state" = masked ] || return 1
  done
}
`;
  if (action === 'inspect') return `
set -eu
${linuxPowerCheck}
case "$(uname -s)" in
  Darwin)
    policy=$(pmset -g custom)
    if printf '%s\\n' "$policy" | awk '$1 == "sleep" { found++; if ($2 != 0) bad=1 } END { exit (!found || bad) }'; then
      printf '%s\\n' '__HAPPIER_WORKER_POWER__={"ok":true,"detail":"idle system sleep disabled"}'
    else
      printf '%s\\n' '__HAPPIER_WORKER_POWER__={"ok":false,"detail":"idle system sleep enabled; run sudo pmset -a sleep 0 once on this host"}'
    fi ;;
  Linux)
    healthy=true
    linux_power_healthy || healthy=false
    printf '__HAPPIER_WORKER_POWER__={"ok":%s,"detail":"systemd sleep targets must all be masked"}\\n' "$healthy" ;;
  *) printf '%s\\n' '__HAPPIER_WORKER_POWER__={"ok":false,"detail":"unsupported operating system"}' ;;
esac
`;
  return `
set -eu
${linuxPowerCheck}
root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}
case "$(uname -s)" in
  Darwin) root pmset -a sleep 0 ;;
  Linux) linux_power_healthy || root systemctl mask ${LINUX_WORKER_SLEEP_TARGETS.join(' ')} ;;
  *) echo 'Worker sleep configuration is unsupported on this operating system' >&2; exit 1 ;;
esac
`;
}

export function buildRemoteWorkerPowerCommand(target, { action = 'configure' } = {}) {
  const script = buildWorkerPowerScript(target.platform, { action: target.platform === 'windows' && action === 'configure' ? 'install' : action });
  return target.platform === 'windows' ? buildRemotePowerShellCommand(script)
    : "sh -c '" + script.replaceAll("'", "'\"'\"'") + "'";
}

function powerConnections(target) {
  const runtime = target.managedRuntime;
  const connections = [];
  if (runtime?.host?.kind === 'ssh') connections.push({ ...runtime.host, platform: runtime.kind === 'wsl' ? 'windows' : 'posix', role: 'host' });
  connections.push({ ...target, role: 'guest' });
  return connections;
}

async function runPowerOperation(connection, action, env, capture) {
  // Stream every Windows operation through the same boundary: even inspection
  // exceeds cmd.exe's command-line limit after UTF-16 base64 encoding.
  const windows = connection.platform === 'windows';
  const command = windows ? buildRemotePowerShellCommand('& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))') : buildRemoteWorkerPowerCommand(connection, { action });
  return await capture('ssh', ['-T', ...(connection.sshConfigFile ? ['-F', connection.sshConfigFile] : []), connection.ssh, command], {
    env,
    ...(windows ? { input: Buffer.from(buildWorkerPowerScript('windows', { action: action === 'configure' ? 'install' : action })).toString('base64') + '\n' } : {}),
  });
}

export async function configureDevTargetPower({ target, env = process.env }, { capture = runCaptureResult } = {}) {
  const results = [];
  for (const connection of powerConnections(target)) {
    const result = await runPowerOperation(connection, 'configure', env, capture);
    results.push({ role: connection.role, ok: result.exitCode === 0, detail: String(result.err || result.out || '').trim() });
  }
  return results;
}

export async function inspectDevTargetPower({ target, env = process.env }, { capture = runCaptureResult } = {}) {
  const results = await Promise.all(powerConnections(target).map(async connection => {
    try {
      const result = await runPowerOperation(connection, 'inspect', env, capture);
      const marker = String(result.out ?? '').match(/^__HAPPIER_WORKER_POWER__=(.+)$/m);
      const observed = marker ? JSON.parse(marker[1]) : null;
      if (result.exitCode !== 0 || typeof observed?.ok !== 'boolean' || typeof observed?.detail !== 'string') {
        return { role: connection.role, ok: false, detail: String(result.err || result.out || 'power health observation unavailable').trim() };
      }
      return { role: connection.role, ok: observed.ok, detail: observed.detail };
    } catch (error) { return { role: connection.role, ok: false, detail: String(error?.message ?? error) }; }
  }));
  return { ok: results.every(result => result.ok), results };
}
