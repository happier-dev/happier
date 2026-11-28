export type { CommandInvocation } from './windows/resolveWindowsCommandInvocation.js';
export { readExecutablePlatform, type ExecutablePlatform } from './executablePlatform.js';
export { parseDaemonLockSnapshot, type DaemonLockRecord, type DaemonLockSnapshot } from './daemonLockRecord.js';
export { closeStdioWhenCommandExits } from './closeStdioWhenCommandExits.js';
export { readLocalHostIdentity, readPreferredHostName, readHomeHostFact } from './homeHostFact.js';
export { parseDarwinBatteryFacts, readLinuxBatteryFacts, type BatteryFacts } from './batteryFacts.js';
export { commandExistsOnPath } from './commandExists.js';
export {
  execFileWithDeadline,
  ExecFileTerminationError,
  type ExecFileChild,
  type ExecFileWithDeadlineOptions,
  type ExecFileWithDeadlineResult,
} from './execFileWithDeadline.js';
export {
  isPidPresent,
  isPidProvablyAbsent,
  probeProcessGroupLiveness,
  probeProcessLiveness,
  type ProcessLiveness,
  type ProcessSignalProbe,
} from './processLiveness.js';
export { runCommandStreaming } from './runCommandStreaming.js';
export { sanitizeDaemonSpawnEnv } from './sanitizeDaemonSpawnEnv.js';
export {
  isWindowsShellShimPath,
  resolveWindowsCommandInvocation,
  resolveWindowsCommandOnPath,
  resolveWindowsCommandPath,
} from './windows/resolveWindowsCommandInvocation.js';
export {
  requireWindowsSystemToolPath,
  resolveWindowsSystemToolPath,
  windowsSystemToolCommand,
  type WindowsSystemToolName,
} from './windows/windowsSystemToolPath.js';
export { spawnBackgroundSync } from './spawnBackgroundSync.js';
export {
  PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME,
  resolveProcessCustodySupportExecutable,
  resolveProcessCustodyTargetExecutable,
} from './processCustodySupportExecutable.js';

export { resolveExecutableCommand, resolveExecutableSearchPath } from './resolveExecutableCommand.js';
