import { runCaptureResult } from '../proc/proc.mjs';
import { buildRemotePowerShellCommand } from './remote_commands.mjs';

export function buildWorkerPowerScript(platform) {
  if (platform === 'windows') return `
$ErrorActionPreference = 'Stop'
function Set-WorkerPowerSetting($guid, $index, $commandArgs) {
  # A machine policy already enforcing zero cannot be changed by powercfg.
  $policy = $null
  try { $policy = Get-ItemPropertyValue -LiteralPath ('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\' + $guid) -Name $index -ErrorAction Stop } catch {}
  if (($policy -is [int] -or $policy -is [uint32]) -and $policy -eq 0) { return }
  & powercfg.exe @commandArgs
  if ($LASTEXITCODE -ne 0) { throw ('powercfg failed: ' + ($commandArgs -join ' ')) }
}
foreach ($supply in @('ac','dc')) {
  $index = if ($supply -eq 'ac') { 'ACSettingIndex' } else { 'DCSettingIndex' }
  Set-WorkerPowerSetting '29f6c1db-86da-48c5-9fdb-f2b67b1f44da' $index @('/change',('standby-timeout-'+$supply),'0')
  Set-WorkerPowerSetting '9d7815a6-7ee4-497e-8888-515a05f02364' $index @('/change',('hibernate-timeout-'+$supply),'0')
  Set-WorkerPowerSetting '7bc4a2f9-d8fc-4469-b07b-33eb785aaca0' $index @(('/set'+$supply+'valueindex'),'SCHEME_CURRENT','SUB_SLEEP','UNATTENDSLEEP','0')
  Set-WorkerPowerSetting '5ca83367-6e45-459f-a27b-476b1d01c936' $index @(('/set'+$supply+'valueindex'),'SCHEME_CURRENT','SUB_BUTTONS','LIDACTION','0')
}
& powercfg.exe /setactive SCHEME_CURRENT
if ($LASTEXITCODE -ne 0) { throw 'powercfg failed to activate the worker power settings' }

`;
  return `
set -eu
root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}
case "$(uname -s)" in
  Darwin) root pmset -a sleep 0 ;;
  Linux) root systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target ;;
  *) echo 'Worker sleep configuration is unsupported on this operating system' >&2; exit 1 ;;
esac
`;
}

export function buildRemoteWorkerPowerCommand(target) {
  const script = buildWorkerPowerScript(target.platform);
  return target.platform === 'windows' ? buildRemotePowerShellCommand(script)
    : "sh -c '" + script.replaceAll("'", "'\"'\"'") + "'";
}

export async function configureDevTargetPower({ target, env = process.env }, { capture = runCaptureResult } = {}) {
  const runtime = target.managedRuntime;
  const connections = [];
  if (runtime?.host?.kind === 'ssh') connections.push({ ...runtime.host, platform: runtime.kind === 'wsl' ? 'windows' : 'posix', role: 'host' });
  connections.push({ ...target, role: 'guest' });
  const results = [];
  for (const connection of connections) {
    const args = ['-T', ...(connection.sshConfigFile ? ['-F', connection.sshConfigFile] : []), connection.ssh, buildRemoteWorkerPowerCommand(connection)];
    const result = await capture('ssh', args, { env });
    results.push({ role: connection.role, ok: result.exitCode === 0, detail: String(result.err ?? result.out ?? '').trim() });
  }
  return results;
}
