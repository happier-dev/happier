import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import {
  buildPosixShellCommand,
  buildPosixShellEnvironmentAssignments,
} from '@happier-dev/agents/process/shellCommand';
import {
  parseHappierToolsShellBridgeCommand,
  type HappierToolsShellBridgeCommand,
} from '@happier-dev/protocol';
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

function buildCanonicalBridgeArgs(command: HappierToolsShellBridgeCommand): string[] {
  const args: string[] = [command.kind];
  if (command.sessionId) args.push('--session-id', command.sessionId);
  if (command.directory) args.push('--directory', command.directory);
  if (command.kind === 'call') {
    args.push('--source', command.source, '--tool', command.tool);
    if (command.argsJson != null) args.push('--args-json', command.argsJson);
  }
  if (command.json) args.push('--json');
  return args;
}

/**
 * Authorization-grade recognition for the shell bridge.
 *
 * Parsing proves that the command is one complete tools invocation. Exact
 * regeneration additionally constrains its launcher, arguments, and optional
 * environment to the canonical shape this CLI would generate. It does not prove
 * provenance, so authorization callers must still allowlist the parsed operation.
 */
export function parseTrustedHappierToolsShellBridgeCommand(
  command: string,
): HappierToolsShellBridgeCommand | null {
  const parsed = parseHappierToolsShellBridgeCommand(command);
  if (!parsed) return null;
  const expected = buildHappierToolsShellBridgeCommand(buildCanonicalBridgeArgs(parsed));
  return parsed.rawCommand === expected ? parsed : null;
}
