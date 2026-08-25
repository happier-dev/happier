import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { PermissionMode } from '@/api/types';
import type { PiBridgeSessionConfig } from '@/backends/pi/bridgeExtension';
import {
  PI_BROKER_PROVIDERS,
  PI_BROKER_SELECTIONS_ENV,
  parsePiBrokerSelections,
  resolvePiBrokerExtensionPath,
} from '@/backends/pi/brokerExtension';
import { PiRpcBackend } from '@/backends/pi/rpc/PiRpcBackend';
import { readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { providers } from '@happier-dev/agents';

export interface PiBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionMode?: PermissionMode;
  happierSessionId?: string | null;
  /**
   * Complete Happier prompt fallback used only when the native tools bridge cannot bind.
   * Applied once at process startup (pi has no runtime RPC command to change it
   * mid-session) and delivered as a protected temporary file passed to
   * `--append-system-prompt` (pi re-reads an existing path on resource reload): literal
   * argv would be process-list-visible and unbounded.
   */
  appendSystemPromptText?: string;
  permissionHandler?: AcpPermissionHandler;
  /**
   * Tools-bridge extension binding for this session. When present (together with
   * `happierSessionId`), the launcher passes `--extension <path>` plus the
   * protected config binding. The extension derives both its registered tools and the
   * complete ordered Happier system-prompt addition from that config, so tool inventory
   * and prompt guidance cannot drift or be reordered by Pi's append-prompt lifecycle.
   */
  happyToolsBridge?: Readonly<{
    extensionPath: string;
    sessionConfig: PiBridgeSessionConfig;
  }>;
}

// `null` means Happier must not override Pi's native tool catalog. Passing
// `--tools` would also filter extension and custom tools in current Pi releases.
export function buildPiToolsForPermissionMode(permissionMode?: PermissionMode): string[] | null {
  const rawMode = typeof permissionMode === 'string' ? permissionMode : 'default';

  // Normalize legacy aliases into canonical permission intents.
  const mode = rawMode === 'acceptEdits'
    ? 'safe-yolo'
    : rawMode === 'bypassPermissions'
      ? 'yolo'
      : rawMode;

  if (mode === 'plan' || mode === 'read-only') {
    return ['read', 'grep', 'find', 'ls'];
  }
  if (mode === 'safe-yolo') {
    return ['read', 'edit', 'write', 'grep', 'find', 'ls'];
  }
  if (mode === 'default' || mode === 'yolo') {
    return null;
  }
  return ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
}

export function buildPiRpcArgs(opts?: Readonly<{
  permissionMode?: PermissionMode;
  thinkingLevel?: string | null;
  extensionToolNames?: readonly string[];
}>): string[] {
  const permissionMode = opts?.permissionMode;
  const restrictedTools = buildPiToolsForPermissionMode(permissionMode);
  const tools = restrictedTools
    ? [...new Set([...restrictedTools, ...(opts?.extensionToolNames ?? [])])]
    : null;
  const args: string[] = ['--mode', 'rpc'];
  if (tools) args.push('--tools', tools.join(','));
  const thinking = providers.pi.normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  return args;
}

type PiConnectedServiceLaunchSelection = Readonly<{
  provider: string;
  startupModel: string;
  modelScope: string;
}>;

function resolvePiLaunchSelectionForConnectedService(serviceId: string): PiConnectedServiceLaunchSelection | null {
  switch (serviceId) {
    case 'openai-codex':
      return { provider: 'openai-codex', startupModel: 'gpt-5.5', modelScope: 'openai-codex/*' };
    case 'openai':
      return { provider: 'openai', startupModel: 'gpt-5.4', modelScope: 'openai/*' };
    case 'claude-subscription':
    case 'anthropic':
      return { provider: 'anthropic', startupModel: providers.claude.CURRENT_FLAGSHIP_CLAUDE_MODEL_ID, modelScope: 'anthropic/*' };
    default:
      return null;
  }
}

function resolvePiLaunchSelectionFromConnectedServiceSelection(
  env: Readonly<Record<string, string>>,
): PiConnectedServiceLaunchSelection | null {
  for (const selection of readConnectedServiceChildSelectionsFromEnv(env)) {
    const launchSelection = resolvePiLaunchSelectionForConnectedService(selection.serviceId);
    if (launchSelection) return launchSelection;
  }
  return null;
}

function resolvePiBrokerExtensionArgs(env: Readonly<Record<string, string>>): string[] {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  if (!agentDir) return [];

  const selections = parsePiBrokerSelections(env[PI_BROKER_SELECTIONS_ENV]);
  const hasBrokeredProvider = PI_BROKER_PROVIDERS.some((provider) => selections[provider]);
  if (!hasBrokeredProvider) return [];

  return ['--extension', resolvePiBrokerExtensionPath(agentDir)];
}

/**
 * Tools-bridge extension arguments. Both-or-neither with the Happier session binding:
 * the binding flag is only ever passed together with `--extension`, and the extension
 * registers nothing without the binding, so neither works alone.
 *
 * Config flags follow the extension's absent-means-disabled contract: each flag is
 * passed only in its enabled state, never with a disabling value.
 */
export function resolveHappyBridgeExtensionArgs(opts?: Readonly<{
  happyToolsBridge?: PiBackendOptions['happyToolsBridge'];
}>): string[] {
  const bridge = opts?.happyToolsBridge;
  return bridge ? ['--extension', bridge.extensionPath] : [];
}

export function createPiBackend(options: PiBackendOptions): AgentBackend {
  const env = Object.fromEntries(
    Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const processEnv = { ...process.env, ...env };
  const thinkingLevel = providers.pi.resolvePiThinkingLevelFromEnv(env);
  const launchSelection = resolvePiLaunchSelectionFromConnectedServiceSelection(env);
  const launch = requireProviderCliLaunchSpec('pi', { processEnv });
  return new PiRpcBackend({
    cwd: options.cwd,
    command: launch.command,
    args: [
      ...launch.args,
      ...resolvePiBrokerExtensionArgs(env),
      ...resolveHappyBridgeExtensionArgs({
        happyToolsBridge: options.happyToolsBridge,
      }),
      ...(launchSelection
        ? [
          '--provider',
          launchSelection.provider,
          '--model',
          launchSelection.startupModel,
          '--models',
          launchSelection.modelScope,
        ]
        : []),
      ...buildPiRpcArgs({
        permissionMode: options.permissionMode,
        thinkingLevel,
        extensionToolNames: options.happyToolsBridge?.sessionConfig.directTools.map((tool) => tool.name),
      }),
    ],
    happierSessionId: options.happierSessionId ?? null,
    toolsBridgeConfigText: options.happyToolsBridge
      ? JSON.stringify(options.happyToolsBridge.sessionConfig)
      : null,
    // The append text is delivered as a protected temp file by the backend itself; the
    // args above must never carry the literal prompt content.
    appendSystemPromptText: options.appendSystemPromptText ?? null,
    permissionHandler: options.permissionHandler,
    env: {
      ...env,
      NODE_ENV: 'production',
      DEBUG: '',
      CI: '1',
    },
  });
}
