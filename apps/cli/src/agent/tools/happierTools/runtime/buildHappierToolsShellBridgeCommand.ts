import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { buildPosixShellCommand, buildPosixShellEnvironmentAssignments } from '@/utils/posixShellCommand';

function readInheritedHappierBridgeEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  const happyHomeDir = typeof process.env.HAPPIER_HOME_DIR === 'string' ? process.env.HAPPIER_HOME_DIR.trim() : '';
  const serverUrl = typeof process.env.HAPPIER_SERVER_URL === 'string' ? process.env.HAPPIER_SERVER_URL.trim() : '';
  if (happyHomeDir.length > 0) {
    inherited.HAPPIER_HOME_DIR = happyHomeDir;
  }
  if (serverUrl.length > 0) {
    inherited.HAPPIER_SERVER_URL = serverUrl;
  }
  return inherited;
}

export function buildHappierToolsShellBridgeCommand(args: readonly string[]): string {
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools', ...args]);
  const command = buildPosixShellCommand([launchSpec.filePath, ...launchSpec.args]);
  const env = {
    ...readInheritedHappierBridgeEnv(),
    ...(launchSpec.env ?? {}),
  };
  if (Object.keys(env).length === 0) return command;
  return `${buildPosixShellEnvironmentAssignments(env)} ${command}`;
}
