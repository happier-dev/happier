import { normalizePiThinkingLevel } from '../../../protocol/thinking.js';
import {
  PI_BROKER_PROVIDERS,
  PI_BROKER_SELECTIONS_ENV,
  parsePiBrokerSelections,
  resolvePiBrokerExtensionPath,
} from '../../auth/services/broker/index.js';
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

function resolvePiLaunchSelectionForConnectedService(serviceId: string | null | undefined): PiConnectedServiceLaunchSelection | null {
  switch (serviceId) {
    case 'openai-codex':
      return { provider: 'openai-codex', startupModel: 'gpt-5.5', modelScope: 'openai-codex/*' };
    case 'openai':
      return { provider: 'openai', startupModel: 'gpt-5.4', modelScope: 'openai/*' };
    case 'claude-subscription':
    case 'anthropic':
      return { provider: 'anthropic', startupModel: 'claude-opus-4-8', modelScope: 'anthropic/*' };
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

function resolvePiBrokerExtensionArgs(env: Readonly<Record<string, string | undefined>> | undefined): readonly string[] {
  const agentDir = readString(env?.PI_CODING_AGENT_DIR);
  if (!agentDir) return [];
  const selections = parsePiBrokerSelections(env?.[PI_BROKER_SELECTIONS_ENV]);
  const hasBrokeredProvider = PI_BROKER_PROVIDERS.some((provider) => selections[provider]);
  return hasBrokeredProvider ? ['--extension', resolvePiBrokerExtensionPath(agentDir)] : [];
}

export function buildPiRpcArgs(opts?: Readonly<{
  permissionMode?: PiPermissionMode;
  thinkingLevel?: string | null;
  resumeSessionId?: string | null;
  connectedServiceId?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
}>): readonly string[] {
  const launchSelection = resolvePiLaunchSelectionForConnectedService(opts?.connectedServiceId);
  const args: string[] = [
    ...resolvePiBrokerExtensionArgs(opts?.env),
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
    '--tools',
    buildPiToolsForPermissionMode(opts?.permissionMode).join(','),
  ];
  const thinking = normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  const resumeSessionId = typeof opts?.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
  if (resumeSessionId) args.push('--session', resumeSessionId);
  return args;
}
