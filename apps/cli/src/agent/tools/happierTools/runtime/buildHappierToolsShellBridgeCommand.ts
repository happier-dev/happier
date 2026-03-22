import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { buildPosixShellCommand, buildPosixShellEnvironmentAssignments } from '@/utils/posixShellCommand';

export function buildHappierToolsShellBridgeCommand(args: readonly string[]): string {
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools', ...args]);
  const command = buildPosixShellCommand([launchSpec.filePath, ...launchSpec.args]);
  if (!launchSpec.env || Object.keys(launchSpec.env).length === 0) return command;
  return `${buildPosixShellEnvironmentAssignments(launchSpec.env)} ${command}`;
}
