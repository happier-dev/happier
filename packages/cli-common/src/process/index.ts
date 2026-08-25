export type { CommandInvocation } from './windows/resolveWindowsCommandInvocation.js';
export { closeStdioWhenCommandExits } from './closeStdioWhenCommandExits.js';
export { commandExistsOnPath } from './commandExists.js';
export {
  execFileWithDeadline,
  type ExecFileWithDeadlineOptions,
  type ExecFileWithDeadlineResult,
} from './execFileWithDeadline.js';
export {
  isPidPresent,
  isPidProvablyAbsent,
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
