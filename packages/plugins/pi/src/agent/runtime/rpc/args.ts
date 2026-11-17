import { join } from 'node:path';

import { PI_PROVIDER_ID, PI_PROVIDER_MODELS_FILE } from '../../providerBinding.js';
import { PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES } from '../../auth/services/qualifiedPurposes.js';
import { PI_CONNECTED_ACCOUNT_MODEL_ENV } from '../../launchEnvironment.js';
import { normalizePiThinkingLevel } from '../../../protocol/thinking.js';
import { parsePiModelId } from '../../models/catalog.js';
import {
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  resolvePiRequestAuthExtensionPath,
} from '../../auth/services/requestAuth/index.js';
import { buildPiToolsForPermissionMode } from './permissions.js';
import type { PiPermissionMode } from './types.js';

const HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';

type PiConnectedServiceLaunchSelection = Readonly<{
  provider: string;
  startupModel?: string;
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
  const row = PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.find((row) => row.service.localId === serviceId);
  return row ? { provider: row.native.providerId,
    ...('startupModel' in row.native ? { startupModel: row.native.startupModel } : {}), modelScope: row.native.modelScope } : null;
}

function readPreparedConnectedAccountModel(env: Readonly<Record<string, string | undefined>> | undefined): PiConnectedServiceLaunchSelection | null {
  const model = env?.[PI_CONNECTED_ACCOUNT_MODEL_ENV];
  if (!model) return null;
  const selection = parsePiModelId(model);
  return { provider: selection.provider, startupModel: selection.modelId, modelScope: `${selection.provider}/*` };
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

type PiRpcArgsOptions = Readonly<{
  skillsRoot?: string;
  modelDiscoveryExtensionPath?: string;
  permissionMode?: PiPermissionMode;
  thinkingLevel?: string | null;
  resumeSessionId?: string | null;
  connectedServiceId?: string | null;
  providerModelId?: string;
  env?: Readonly<Record<string, string | undefined>>;
  happierToolsExtension?: Readonly<{
    extensionPath: string;
    configPath: string;
    toolNames?: readonly string[];
    nativeToolSelection?: readonly string[] | null;
  }>;
}>;

/** Arguments and their transient file dependencies have one owner. */
export function buildPiRpcLaunch(opts?: PiRpcArgsOptions): Readonly<{ args: readonly string[]; requiredFiles: readonly string[] }> {
  const requestAuthArgs = resolvePiRequestAuthExtensionArgs(opts?.env);
  const launchSelection = opts?.providerModelId
    ? { provider: PI_PROVIDER_ID, startupModel: opts.providerModelId, modelScope: `${PI_PROVIDER_ID}/*` }
    : readPreparedConnectedAccountModel(opts?.env) ?? resolvePiLaunchSelectionForConnectedService(opts?.connectedServiceId);
  // A prepared extension applies the canonical selection after native MCP discovery.
  // Pi's CLI allowlist would permanently exclude those dynamically registered names.
  const restrictedTools = opts?.happierToolsExtension?.nativeToolSelection !== undefined
    ? null : buildPiToolsForPermissionMode(opts?.permissionMode);
  const tools = restrictedTools
    ? [...new Set([...restrictedTools, ...(opts?.happierToolsExtension?.toolNames ?? [])])]
    : null;
  const args: string[] = [
    ...requestAuthArgs,
    ...(opts?.modelDiscoveryExtensionPath ? ['--extension', opts.modelDiscoveryExtensionPath] : []),
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
        ...(launchSelection.startupModel ? ['--model', launchSelection.startupModel] : []),
        '--models',
        launchSelection.modelScope,
      ]
      : []),
    '--mode',
    'rpc',
    '--approve',
  ];
  if (opts?.skillsRoot) args.push('--skill', opts.skillsRoot);
  if (tools) args.push('--tools', tools.join(','));
  const thinking = normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  // Pi minted this id; the operand carries its exact bytes.
  const resumeSessionId = typeof opts?.resumeSessionId === 'string' && opts.resumeSessionId.trim().length > 0
    ? opts.resumeSessionId
    : '';
  if (resumeSessionId) args.push('--session', resumeSessionId);
  return { args, requiredFiles: [
    // The bound Provider is registered by this private native catalog, including
    // brokered relay bindings prepared after the member's home snapshot.
    ...(opts?.providerModelId && opts.env?.PI_CODING_AGENT_DIR
      ? [join(opts.env.PI_CODING_AGENT_DIR, PI_PROVIDER_MODELS_FILE)] : []),
    ...(requestAuthArgs[1] ? [requestAuthArgs[1]] : []),
    ...(opts?.modelDiscoveryExtensionPath ? [opts.modelDiscoveryExtensionPath] : []),
    ...(opts?.happierToolsExtension ? [opts.happierToolsExtension.extensionPath, opts.happierToolsExtension.configPath] : []),
  ] };
}

export function buildPiRpcArgs(opts?: PiRpcArgsOptions): readonly string[] {
  return buildPiRpcLaunch(opts).args;
}
