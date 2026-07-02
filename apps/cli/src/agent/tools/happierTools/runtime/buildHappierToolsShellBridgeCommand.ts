import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { buildPosixShellCommand, buildPosixShellEnvironmentAssignments } from '@/utils/posixShellCommand';
import { resolveHappierToolsShellBridgeContextEnv } from './resolveHappierToolsShellBridgeContextEnv';

/**
 * Build the POSIX shell command a shell_bridge provider runs to invoke
 * `happier tools ...`.
 *
 * By default this command stays clean and relies on the provider shell's inherited
 * environment. Set HAPPIER_SHELL_BRIDGE_CONTEXT_ENV=home or full to inline the
 * non-secret Happier runtime context for environments whose shell startup files
 * clobber the inherited Happier home/server selection.
 *
 * `launchSpec.env` (e.g. TSX_TSCONFIG_PATH in dev) is the launch-mechanism env for
 * this specific CLI invocation and is merged after the context.
 */
export function buildHappierToolsShellBridgeCommand(args: readonly string[]): string {
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools', ...args]);
  const command = buildPosixShellCommand([launchSpec.filePath, ...launchSpec.args]);
  const env = {
    ...resolveHappierToolsShellBridgeContextEnv(),
    ...(launchSpec.env ?? {}),
  };
  if (Object.keys(env).length === 0) return command;
  return `${buildPosixShellEnvironmentAssignments(env)} ${command}`;
}
