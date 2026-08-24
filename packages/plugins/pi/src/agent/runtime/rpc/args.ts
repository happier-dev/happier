import { normalizePiThinkingLevel } from '../../../protocol/thinking.js';
import {
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  resolvePiRequestAuthExtensionPath,
} from '../../auth/services/requestAuth/index.js';
import { buildPiToolsForPermissionMode } from './permissions.js';
import type { PiPermissionMode } from './types.js';

const HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';

type PiConnectedServiceLaunchSelection = Readonly<{
  provider: string;
  startupModel: string;
  modelScope: string;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Pi's startup model for the Anthropic connected service.
 *
 * Sibling rows in the same table pin their provider's model the same way; this
 * is Pi's own launch choice, not a Happier-wide Claude policy. It is declared
 * here so the plugin needs no host workspace package: the plugin scaffold
 * binds an external author to the public toolchain packages only.
 */
const PI_ANTHROPIC_STARTUP_MODEL_ID = 'claude-opus-5';

function resolvePiLaunchSelectionForConnectedService(serviceId: string | null | undefined): PiConnectedServiceLaunchSelection | null {
  switch (serviceId) {
    case 'openai-codex':
      return { provider: 'openai-codex', startupModel: 'gpt-5.5', modelScope: 'openai-codex/*' };
    case 'openai':
      return { provider: 'openai', startupModel: 'gpt-5.4', modelScope: 'openai/*' };
    case 'claude-subscription':
    case 'anthropic':
      return { provider: 'anthropic', startupModel: PI_ANTHROPIC_STARTUP_MODEL_ID, modelScope: 'anthropic/*' };
    default:
      return null;
  }
}

export function readPiConnectedServiceIdFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const selections = Array.isArray(parsed) ? parsed : [];
  for (const selection of selections) {
    const serviceId = readString(readRecord(selection)?.serviceId);
    if (resolvePiLaunchSelectionForConnectedService(serviceId)) return serviceId;
  }
  return null;
}

function resolvePiRequestAuthExtensionArgs(env: Readonly<Record<string, string | undefined>> | undefined): readonly string[] {
  const agentDir = readString(env?.PI_CODING_AGENT_DIR);
  const capabilityPath = readString(env?.[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]);
  return agentDir && capabilityPath
    ? ['--extension', resolvePiRequestAuthExtensionPath(agentDir)]
    : [];
}

export function buildPiRpcArgs(opts?: Readonly<{
  permissionMode?: PiPermissionMode;
  thinkingLevel?: string | null;
  resumeSessionId?: string | null;
  connectedServiceId?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  happierToolsExtension?: Readonly<{ extensionPath: string; configPath: string }>;
}>): readonly string[] {
  const launchSelection = resolvePiLaunchSelectionForConnectedService(opts?.connectedServiceId);
  const tools = buildPiToolsForPermissionMode(opts?.permissionMode);
  const args: string[] = [
    ...resolvePiRequestAuthExtensionArgs(opts?.env),
    ...(opts?.happierToolsExtension
      ? [
          '--extension',
          opts.happierToolsExtension.extensionPath,
          '--happier-tools-config',
          opts.happierToolsExtension.configPath,
        ]
      : []),
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
    '--mode',
    'rpc',
  ];
  if (tools) args.push('--tools', tools.join(','));
  const thinking = normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  const resumeSessionId = typeof opts?.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
  if (resumeSessionId) args.push('--session', resumeSessionId);
  return args;
}
