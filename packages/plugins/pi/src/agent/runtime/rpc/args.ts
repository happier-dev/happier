import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import { PI_PROVIDER_ID, PI_PROVIDER_MODELS_FILE } from '../../providerBinding.js';
import { PI_SESSION_FILE_STORE_DESCRIPTOR_V1, resolvePiSessionDirectoryName } from '../../sessionFileStoreDescriptor.js';
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

export async function resolvePiRpcSessionDirectory(params: Readonly<{
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  unsetEnvKeys?: readonly string[];
  readEnvironment?: (keys: readonly string[]) => Readonly<Record<string, string>>;
}>): Promise<string | undefined> {
  const product = PI_SESSION_FILE_STORE_DESCRIPTOR_V1;
  const directory = resolvePiSessionDirectoryName(params.cwd);
  if (!directory.requiresOverride) return undefined;

  const keys = [product.agentDirEnvVar, ...product.legacySessionDirEnvVars, 'HOME'];
  const env = { ...params.readEnvironment?.(keys), ...params.env };
  for (const key of params.unsetEnvKeys ?? []) delete env[key];
  if (product.legacySessionDirEnvVars.some(key => Boolean(env[key]))) return undefined;

  const homeDir = resolveHomeDirFromEnvironment(env);
  const configuredAgentDir = env[product.agentDirEnvVar];
  // Older hosts may expose only the launch overlay. Never redirect a member's
  // Session files into the host process's home on missing environment evidence.
  if (!configuredAgentDir && !env.HOME) return undefined;
  const agentDir = configuredAgentDir
    ? resolve(params.cwd, expandHomePath(configuredAgentDir, homeDir))
    : join(homeDir, ...product.defaultAgentDirSegments);
  // Leave explicit storage settings with Pi. We only replace its impossible
  // default and leave resolution of the configured path to the native CLI.
  for (const dir of [agentDir, join(params.cwd, product.configDirName)]) {
    try {
      const settings = readRecord(JSON.parse((await readFile(join(dir, 'settings.json'), 'utf8')).replace(/^\uFEFF/, '')));
      if (readString(settings?.sessionDir)) return undefined;
    } catch {
      // A missing or invalid settings file supplies no storage override.
    }
  }
  return join(agentDir, 'sessions', directory.name);
}

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
  sessionDirectory?: string;
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
  if (opts?.sessionDirectory) args.push('--session-dir', opts.sessionDirectory);
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
