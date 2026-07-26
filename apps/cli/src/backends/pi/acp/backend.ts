import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
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
   * System prompt text appended to pi's default system prompt via the
   * `--append-system-prompt` spawn flag. Applied once at process startup
   * (pi has no runtime RPC command to change it mid-session).
   */
  appendSystemPromptText?: string;
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

export function buildPiRpcArgs(opts?: Readonly<{ permissionMode?: PermissionMode; thinkingLevel?: string | null; appendSystemPromptText?: string | null }>): string[] {
  const permissionMode = opts?.permissionMode;
  const tools = buildPiToolsForPermissionMode(permissionMode);
  const args: string[] = ['--mode', 'rpc'];
  if (tools) args.push('--tools', tools.join(','));
  const thinking = providers.pi.normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  const appendSystemPromptText = typeof opts?.appendSystemPromptText === 'string' ? opts.appendSystemPromptText.trim() : '';
  if (appendSystemPromptText) args.push('--append-system-prompt', appendSystemPromptText);
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
      ...buildPiRpcArgs({ permissionMode: options.permissionMode, thinkingLevel, appendSystemPromptText: options.appendSystemPromptText }),
    ],
    happierSessionId: options.happierSessionId ?? null,
    env: {
      ...env,
      NODE_ENV: 'production',
      DEBUG: '',
      CI: '1',
    },
  });
}
