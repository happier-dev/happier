import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import {
  buildPosixShellCommand,
  buildPosixShellEnvironmentAssignments,
} from '@happier-dev/agents/process/shellCommand';
import { parseHappierToolsShellBridgeCommand } from '@happier-dev/protocol/tools/happierToolsShellBridge';
import type { HappierToolsShellBridgeCommand } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { resolveHappierRuntimeContextEnvFromConfiguration } from '@/utils/env/resolveHappierRuntimeContextEnvFromConfiguration';
import { supportsSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';

/**
 * Build the POSIX shell command a shell_bridge provider runs to invoke
 * `happier tools ...`.
 *
 * POSIX inherits Session MCP context from its admitted Agent launch. Windows
 * keeps its existing opt-in, non-secret home/server context for current-user tools.
 *
 * `launchSpec.env` (e.g. TSX_TSCONFIG_PATH in dev) is the launch-mechanism env for
 * this specific CLI invocation.
 */
/**
 * Every command this module generates is run by an Agent's shell, never typed by
 * the operator, so the provenance marker belongs to the generated shape itself
 * rather than to each caller. Stamping it here keeps the producer, the exact
 * recognizer below and the `happier tools` dispatcher agreeing on one fact: the
 * invocation is Agent automation, including the retained Windows credentialed path.
 */
function withAgentBridgeMarker(args: readonly string[]): string[] {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return [];
  return [subcommand, '--agent-bridge', ...rest.filter((arg) => arg !== '--agent-bridge')];
}

export function buildHappierToolsShellBridgeCommand(args: readonly string[]): string {
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools', ...withAgentBridgeMarker(args)]);
  const command = buildPosixShellCommand([launchSpec.filePath, ...launchSpec.args]);
  const env = { ...resolveHappierToolsShellBridgeContextEnv(), ...(launchSpec.env ?? {}) };
  if (Object.keys(env).length === 0) return command;
  return `${buildPosixShellEnvironmentAssignments(env)} ${command}`;
}

function resolveHappierToolsShellBridgeContextEnv(): Record<string, string> {
  if (supportsSessionMcpLocalTransport() || configuration.shellBridgeContextEnvMode === 'off') return {};
  const context = resolveHappierRuntimeContextEnvFromConfiguration();
  if (configuration.shellBridgeContextEnvMode === 'full') return context;
  const homeDir = context.HAPPIER_HOME_DIR;
  return typeof homeDir === 'string' && homeDir.trim() ? { HAPPIER_HOME_DIR: homeDir } : {};
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
