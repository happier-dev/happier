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

// Optional native Windows OS validation; credentials remain on the controller.
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
