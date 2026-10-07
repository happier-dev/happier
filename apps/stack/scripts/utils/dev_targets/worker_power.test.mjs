import { runCaptureResult } from '../proc/proc.mjs';
import { buildRemotePowerShellCommand } from './remote_commands.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildWorkerPowerScript, buildRemoteWorkerPowerCommand } from './worker_power.mjs';
const execute = promisify(execFile);

for (const os of ['Darwin', 'Linux']) {
  test(`worker power configuration prevents system sleep on ${os}`, { skip: process.platform === 'win32' }, async (t) => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-worker-power-' });
    const bin = fixture.path('bin'); const state = fixture.path('power');
    await mkdir(bin);
    await writeFile(state, 'sleep=1');
    // Genuine OS boundaries only; execute the real worker power program.
    const commands = {
      uname: `printf '%s\\n' '${os}'`, id: 'printf 0',
      pmset: `[ "$*" = '-a sleep 0' ] || exit 9; printf 'sleep=0' > "$POWER_STATE"`,
      systemctl: `case "$1" in mask) printf '%s\\n' "$*" > "$POWER_STATE" ;; *) exit 9 ;; esac`,
    };
    for (const [name, body] of Object.entries(commands)) {
      const path = join(bin, name); await writeFile(path, '#!/bin/sh\n' + body + '\n'); await chmod(path, 0o755);
    }
    await execute('sh', ['-c', buildRemoteWorkerPowerCommand({ platform: 'posix' })], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, POWER_STATE: state } });
    const actual = await readFile(state, 'utf8');
    if (os === 'Darwin') assert.equal(actual, 'sleep=0');
    else { assert.match(actual, /(?:^| )sleep\.target(?: |$)/); assert.match(actual, /(?:^| )suspend\.target(?: |$)/); assert.match(actual, /(?:^| )hibernate\.target(?: |$)/); }
  });
}

test('power inspection reads macOS policy without changing it and rejects battery sleep', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-worker-power-health-' });
  const bin = fixture.path('bin'); await mkdir(bin);
  for (const [name, body] of Object.entries({
    uname: 'printf Darwin',
    pmset: '[ "$*" = "-g custom" ] || exit 9; printf "Battery Power:\\n sleep %s\\nAC Power:\\n sleep 0\\n" "$BATTERY_SLEEP"',
  })) {
    const path = join(bin, name); await writeFile(path, '#!/bin/sh\n' + body + '\n'); await chmod(path, 0o755);
  }
  const probe = () => execute('sh', ['-c', buildRemoteWorkerPowerCommand({ platform: 'posix' }, { action: 'inspect' })],
    { env: { ...process.env, PATH: bin + ':' + process.env.PATH, BATTERY_SLEEP: '1' } });
  const result = await probe();
  assert.match(result.stdout, /__HAPPIER_WORKER_POWER__=/);
  const health = JSON.parse(result.stdout.match(/__HAPPIER_WORKER_POWER__=(.+)/)[1]);
  assert.equal(health.ok, false);
  assert.match(health.detail, /sudo pmset -a sleep 0/);
  const healthy = await execute('sh', ['-c', buildRemoteWorkerPowerCommand({ platform: 'posix' }, { action: 'inspect' })],
    { env: { ...process.env, PATH: bin + ':' + process.env.PATH, BATTERY_SLEEP: '0' } });
  assert.equal(JSON.parse(healthy.stdout.match(/__HAPPIER_WORKER_POWER__=(.+)/)[1]).ok, true);
});

// Optional native Windows OS validation; credentials remain on the controller.
test('Windows worker power persists one boot and logon task with an unlimited keep-awake request', {
  skip: !process.env.HAPPIER_STACK_TEST_WINDOWS_SSH_CONFIG,
}, async () => {
  const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$fixture=Join-Path $env:TEMP ('happier-power-test-'+[guid]::NewGuid().ToString())
$env:ProgramData=$fixture
$script:tasks=@{}
$script:starts=0
function powercfg.exe { $global:LASTEXITCODE=0; if ($args[0] -in @('/query','/qh') -and ($args[0] -eq '/qh' -or $args[3] -notin @('7bc4a2f9-d8fc-4469-b07b-33eb785aaca0','5ca83367-6e45-459f-a27b-476b1d01c936'))) { 'Minimum: 0x00000000'; 'Maximum: 0xffffffff'; 'Current AC: 0x00000000'; 'Current DC: 0x00000000' }; if ($args[0] -eq '/requests') { $script:requestReason } }
function icacls.exe { $global:LASTEXITCODE=0 }
function New-ScheduledTaskAction { param($Execute,$Argument) return @{Execute=$Execute;Arguments=$Argument} }
function New-ScheduledTaskTrigger { param([switch]$AtStartup,[switch]$AtLogOn) return @{Enabled=$true;Kind=$(if($AtStartup){'boot'}else{'logon'});CimClass=@{CimClassName=$(if($AtStartup){'MSFT_TaskBootTrigger'}else{'MSFT_TaskLogonTrigger'})}} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) return @{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel} }
function New-ScheduledTaskSettingsSet { param($ExecutionTimeLimit,[switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$MultipleInstances) return @{ExecutionTimeLimit=$ExecutionTimeLimit;StartWhenAvailable=[bool]$StartWhenAvailable;AllowStartIfOnBatteries=[bool]$AllowStartIfOnBatteries;DontStopIfGoingOnBatteries=[bool]$DontStopIfGoingOnBatteries;MultipleInstances=$MultipleInstances} }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force) $state=if($script:tasks[$TaskName]){$script:tasks[$TaskName].State}else{'Ready'}; $script:tasks[$TaskName]=@{State=$state;Actions=@($Action);Triggers=@($Trigger);Principal=$Principal;Settings=$Settings} }
function Get-ScheduledTask { param($TaskName,$ErrorAction) return $script:tasks[$TaskName] }
function Start-ScheduledTask { param($TaskName) $script:tasks[$TaskName].State='Running';$script:starts++ }
function Stop-ScheduledTask { param($TaskName) $script:tasks[$TaskName].State='Ready' }
try {
  $program={ ${buildWorkerPowerScript('windows', { action: 'install' })} }
  & $program
  & $program
  if ($script:tasks.Count -ne 1) { throw 'No persistent worker power task was installed' }
  $task=$script:tasks['Happier-Worker-Power']
  if ($task.State -ne 'Running' -or $script:starts -ne 1) { throw 'Repeated setup restarted or failed to start the owned task' }
  if ($task.Principal.UserId -ne 'SYSTEM' -or $task.Principal.RunLevel -ne 'Highest') { throw 'Power task cannot run unattended at boot' }
  if (@($task.Triggers | Where-Object {$_.Kind -eq 'boot'}).Count -ne 1 -or @($task.Triggers | Where-Object {$_.Kind -eq 'logon'}).Count -ne 1) { throw 'Power task lacks boot/logon triggers' }
  if ($task.Settings.ExecutionTimeLimit -ne [TimeSpan]::Zero -or !$task.Settings.AllowStartIfOnBatteries -or !$task.Settings.DontStopIfGoingOnBatteries) { throw 'Scheduler can terminate the no-sleep request' }
  $installed=Get-Content -Raw -LiteralPath (Join-Path $fixture 'Happier/worker-power/keep-awake.ps1')
  if ($installed -notmatch 'PowerSetRequest' -or $installed -notmatch 'Set-WorkerPowerSetting' -or $installed -notmatch 'Test-WorkerPowerSettings') { throw 'Boot task does not reapply, verify and hold the power policy' }
  $probe={ ${buildWorkerPowerScript('windows', { action: 'inspect' })} }
  $script:requestReason='None.'
  $missing=(& $probe) -replace '^__HAPPIER_WORKER_POWER__=','' | ConvertFrom-Json
  if ($missing.ok) { throw 'Running task without a power request was reported healthy' }
  $script:requestReason='Happier worker no-sleep'
  $healthy=(& $probe) -replace '^__HAPPIER_WORKER_POWER__=','' | ConvertFrom-Json
  if (!$healthy.ok) { throw ('Held boot request was reported unhealthy: '+$healthy.detail) }
  $task.Settings.ExecutionTimeLimit='PT72H'
  $expiring=(& $probe) -replace '^__HAPPIER_WORKER_POWER__=','' | ConvertFrom-Json
  if ($expiring.ok) { throw 'A keep-awake task with a scheduler deadline was reported healthy' }
  Write-Output 'WINDOWS_BOOT_POWER_CONTRACT_PASSED'
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
`;
  const command = buildRemotePowerShellCommand('& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))');
  const result = await runCaptureResult('ssh', ['-T', '-F', process.env.HAPPIER_STACK_TEST_WINDOWS_SSH_CONFIG, process.env.HAPPIER_STACK_TEST_WINDOWS_SSH_ALIAS, command], { input: Buffer.from(script).toString('base64') + '\n' });
  assert.equal(result.exitCode, 0, result.err);
  assert.match(result.out, /WINDOWS_BOOT_POWER_CONTRACT_PASSED/);
});

test('Windows worker power configuration disables idle, unattended and lid sleep', {
  skip: !process.env.HAPPIER_STACK_TEST_WINDOWS_SSH_CONFIG,
}, async () => {
  const script = `
$ErrorActionPreference='Stop'
$settings=@{}
$workerProgram = { ${buildWorkerPowerScript('windows')} }
function powercfg.exe {
  if ($args[0] -eq '/change') { $settings[$args[1]]=[int]$args[2] }
  elseif ($args[0] -in @('/setacvalueindex','/setdcvalueindex')) { $settings[($args[0]+'/'+$args[2]+'/'+$args[3])]=[int]$args[4] }
  elseif ($args[0] -ne '/setactive') { throw 'Unexpected OS power command' }
  $global:LASTEXITCODE=0
}
& $workerProgram
foreach ($key in @('standby-timeout-ac','standby-timeout-dc','hibernate-timeout-ac','hibernate-timeout-dc','/setacvalueindex/SUB_SLEEP/UNATTENDSLEEP','/setdcvalueindex/SUB_SLEEP/UNATTENDSLEEP','/setacvalueindex/SUB_BUTTONS/LIDACTION','/setdcvalueindex/SUB_BUTTONS/LIDACTION')) {
  if (!$settings.ContainsKey($key) -or $settings[$key] -ne 0) { throw ('Worker sleep remains enabled: '+$key) }
}

# Native registry and powercfg boundaries: an enforced policy is authoritative.
$policyGuids=@('29f6c1db-86da-48c5-9fdb-f2b67b1f44da','9d7815a6-7ee4-497e-8888-515a05f02364','7bc4a2f9-d8fc-4469-b07b-33eb785aaca0','5ca83367-6e45-459f-a27b-476b1d01c936')
$script:policyValue=0
function Get-ItemPropertyValue {
  param($LiteralPath,$Name,$ErrorAction)
  $guid=Split-Path -Leaf $LiteralPath
  if ($guid -notin $policyGuids -or $Name -notin @('ACSettingIndex','DCSettingIndex') -or $LiteralPath.Replace([char]92,'/') -ne ('HKLM:/SOFTWARE/Policies/Microsoft/Power/PowerSettings/'+$guid)) { throw 'Invalid Windows power policy boundary' }
  return $script:policyValue
}
function powercfg.exe { $global:LASTEXITCODE=if ($args[0] -eq '/setactive') { 0 } else { 1 } }
& $workerProgram
$script:policyValue=7200
$refused=$false
try { & $workerProgram } catch { $refused=$true }
if (!$refused) { throw 'Conflicting machine power policy was silently accepted' }
Write-Output 'WINDOWS_POWER_CONTRACT_PASSED'

`;
  const command = buildRemotePowerShellCommand('& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))');
  const result = await runCaptureResult('ssh', ['-T', '-F', process.env.HAPPIER_STACK_TEST_WINDOWS_SSH_CONFIG, process.env.HAPPIER_STACK_TEST_WINDOWS_SSH_ALIAS, command], { input: Buffer.from(script).toString('base64') + '\n' });
  assert.equal(result.exitCode, 0, result.err);
  assert.match(result.out, /WINDOWS_POWER_CONTRACT_PASSED/);
});
