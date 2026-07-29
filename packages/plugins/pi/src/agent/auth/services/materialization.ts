import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  defineConnectedServiceAuthMaterialization,
  readConnectedServiceCredentialRecord,
  requireConnectedServiceOauthCredentialRecordWithExpiry,
  requireConnectedServiceTokenCredentialRecord,
  resolveConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { writeAtomicJsonFile } from '@happier-dev/plugin-sdk/experimental/fs';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import { formatPiSessionDirectoryForCwd } from '../../sessionFiles.js';
import { PI_DIRECT_AUTH_ENV_KEYS } from '../../launchEnvironment.js';
import {
  ensurePiRequestAuthExtensionAsset,
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  readPiRequestAuthMaterialization,
  retireLegacyPiRequestAuthAssets,
  type PiRequestAuthMaterialization,
  type PiRequestAuthProviderId,
  type PiRequestAuthPurposeMap,
} from './requestAuth/index.js';

const piAuthMaterialization = defineConnectedServiceAuthMaterialization([
  { serviceId: 'openai-codex', inputKey: 'openaiCodex' },
  { serviceId: 'openai', inputKey: 'openai' },
  { serviceId: 'claude-subscription', inputKey: 'claudeSubscription' },
  { serviceId: 'anthropic', inputKey: 'anthropic' },
] as const);

export const PI_SUPPORTED_CONNECTED_SERVICE_IDS = piAuthMaterialization.serviceIds;
type PiConnectedServiceId = typeof PI_SUPPORTED_CONNECTED_SERVICE_IDS[number];

export const PI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES = Object.freeze([
  'pi-agent-dir/auth.json',
] as const);

// Exact retired Pi broker generations plus the current request-auth path whose
// inherited value must be cleared before an inactive/direct launch.
export const PI_AUTH_ENV_KEYS_TO_NEUTRALIZE = Object.freeze([
  'HAPPIER_PI_BROKER_SELECTIONS',
  'HAPPIER_PI_BROKER_DAEMON_STATE_PATH',
  'HAPPIER_PI_BROKER_STATE_PATH',
  'HAPPIER_PI_BROKER_EXTENSION_VERSION',
  'HAPPIER_PI_CONNECTED_SERVICE_SELECTION_IDENTITY',
  'HAPPIER_PI_BROKER_LOAD_NONCE',
  'HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH',
  'HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN',
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
] as const);

function resolvePiStateSharingMode(settingsLike: unknown): 'isolated' | 'shared' {
  const record = isRecord(settingsLike) ? settingsLike : null;
  return resolveConnectedServicesProviderStateSharingPolicyV1(
    record?.connectedServicesProviderStateSharingSettingsV1,
    'pi',
  ).stateMode;
}

type SessionFileImportRoot = Readonly<{
  sourceRoot: string;
  destinationRoot: string;
  includeFile?: (relativePath: string) => boolean;
}>;

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.startsWith('\\') && !path.split('/').includes('..');
}

async function listFiles(root: string): Promise<readonly string[]> {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }

  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir) break;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

async function copySessionFile(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  try {
    const [source, destination] = await Promise.all([
      readFile(sourcePath),
      readFile(destinationPath),
    ]);
    if (source.equals(destination)) return;
    const extensionIndex = destinationPath.lastIndexOf('.');
    const conflictPath = extensionIndex > 0
      ? `${destinationPath.slice(0, extensionIndex)}.${hashBuffer(source)}${destinationPath.slice(extensionIndex)}`
      : `${destinationPath}.${hashBuffer(source)}`;
    await copyFile(sourcePath, conflictPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  await copyFile(sourcePath, destinationPath);
}

async function importSessionFiles(roots: readonly SessionFileImportRoot[]): Promise<void> {
  for (const root of roots) {
    const sourceRoot = resolve(root.sourceRoot);
    const destinationRoot = resolve(root.destinationRoot);
    for (const sourcePath of await listFiles(sourceRoot)) {
      const relativePath = normalizeRelativePath(relative(sourceRoot, sourcePath));
      if (!isSafeRelativePath(relativePath)) continue;
      if (root.includeFile && !root.includeFile(relativePath)) continue;
      await copySessionFile(sourcePath, join(destinationRoot, ...relativePath.split('/')));
    }
  }
}

function buildPiSessionImportRoots(params: Readonly<{
  rootDir: string;
  sourceEnv: Readonly<Record<string, string | undefined>>;
  encodedCwdDir: string;
  targetSessionsRoot: string;
  targetEncodedSessionsRoot: string;
}>): readonly SessionFileImportRoot[] {
  const legacySessionsEnv = readString(params.sourceEnv.PI_CODING_AGENT_SESSION_DIR);
  const sourceAgentDir = readString(params.sourceEnv.PI_CODING_AGENT_DIR);
  const legacySessionsRoot = join(params.rootDir, 'pi-sessions');

  const roots: SessionFileImportRoot[] = [
    ...(legacySessionsEnv ? [{
      sourceRoot: join(legacySessionsEnv, '--workdir--'),
      destinationRoot: params.targetEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
    }, {
      sourceRoot: legacySessionsEnv,
      destinationRoot: params.targetEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl') && !relativePath.includes('/'),
    }] : []),
    ...(sourceAgentDir ? [{
      sourceRoot: join(sourceAgentDir, 'sessions'),
      destinationRoot: params.targetSessionsRoot,
      includeFile: (relativePath: string) =>
        relativePath.toLowerCase().endsWith('.jsonl') && relativePath.startsWith(`${params.encodedCwdDir}/`),
    }] : []),
    {
      sourceRoot: join(homedir(), '.pi', 'agent', 'sessions'),
      destinationRoot: params.targetSessionsRoot,
      includeFile: (relativePath: string) =>
        relativePath.toLowerCase().endsWith('.jsonl') && relativePath.startsWith(`${params.encodedCwdDir}/`),
    },
    {
      sourceRoot: join(legacySessionsRoot, '--workdir--'),
      destinationRoot: params.targetEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
    },
    {
      sourceRoot: legacySessionsRoot,
      destinationRoot: params.targetEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl') && !relativePath.includes('/'),
    },
  ];

  return Array.from(new Map(
    roots.map((root) => [`${root.sourceRoot}:::${root.destinationRoot}`, root]),
  ).values());
}

export const readPiConnectedServiceId:
  (selection: unknown) => PiConnectedServiceId | null = piAuthMaterialization.readConnectedServiceId;
export const createPiAuthMaterializationInput = piAuthMaterialization.createAuthMaterializationInput;

export async function materializePiAuthEnvironment(input: Readonly<Record<string, unknown>>): Promise<Readonly<{
  env: Readonly<Record<string, string>>;
}>> {
  const rootDir = readString(input.rootDir);
  if (!rootDir) {
    throw new Error('Pi connected-service materialization requires a rootDir');
  }

  const agentDir = join(rootDir, 'pi-agent-dir');
  const auth: Record<string, unknown> = {};
  const openaiCodex = readConnectedServiceCredentialRecord(input.openaiCodex);
  const openai = readConnectedServiceCredentialRecord(input.openai);
  const claudeSubscription = readConnectedServiceCredentialRecord(input.claudeSubscription);
  const anthropic = readConnectedServiceCredentialRecord(input.anthropic);
  const projectedRequestAuth = readPiRequestAuthMaterialization(input.requestAuth);
  const requestAuthPurposes: {
    -readonly [K in PiRequestAuthProviderId]?: NonNullable<PiRequestAuthPurposeMap[K]>;
  } = {};

  const requireRequestAuthProvider = (providerId: PiRequestAuthProviderId): void => {
    const purpose = projectedRequestAuth?.purposesByProviderId[providerId];
    if (!purpose) {
      throw new Error(`Pi request-auth materialization requires the exact declared ${providerId} purpose`);
    }
    requestAuthPurposes[providerId] = purpose;
  };

  // OAuth credentials never enter Pi. The host projects a scoped child request-auth capability and
  // the extension performs a fresh lookup immediately before each independently submitted request.
  if (projectedRequestAuth?.purposesByProviderId['openai-codex']) {
    requireRequestAuthProvider('openai-codex');
  }
  if (openaiCodex) {
    requireConnectedServiceOauthCredentialRecordWithExpiry(openaiCodex);
    requireRequestAuthProvider('openai-codex');
  }

  if (openai) {
    const record = requireConnectedServiceTokenCredentialRecord(openai, {
      message: 'OpenAI OAuth credentials are not supported. Reconnect using an API key or setup-token.',
    });
    auth.openai = {
      type: 'api_key',
      key: record.token.token,
    };
  }

  // Claude subscription OAuth uses request-auth; setup-token and Console API keys remain direct.
  if (projectedRequestAuth?.purposesByProviderId.anthropic) {
    if (claudeSubscription) {
      requireConnectedServiceOauthCredentialRecordWithExpiry(
        claudeSubscription,
      );
    }
    requireRequestAuthProvider('anthropic');
  } else if (claudeSubscription) {
    if (claudeSubscription.kind === 'oauth') {
      requireConnectedServiceOauthCredentialRecordWithExpiry(claudeSubscription);
      requireRequestAuthProvider('anthropic');
    } else {
      const record = requireConnectedServiceTokenCredentialRecord(claudeSubscription, {
        message: 'Claude subscription OAuth credentials are not supported. Reconnect using an API key or setup-token.',
      });
      auth.anthropic = {
        type: 'api_key',
        key: record.token.token,
      };
    }
  } else if (anthropic) {
    const record = requireConnectedServiceTokenCredentialRecord(anthropic, {
      message: 'Anthropic OAuth credentials are not supported. Reconnect using an API key or setup-token.',
    });
    auth.anthropic = {
      type: 'api_key',
      key: record.token.token,
    };
  }

  const requestAuthEnabled = Object.keys(requestAuthPurposes).length > 0;
  await retireLegacyPiRequestAuthAssets({
    rootDir,
    agentDir,
    retainCurrent: requestAuthEnabled,
  });
  await writeAtomicJsonFile({ path: join(agentDir, 'auth.json'), value: auth, mode: 0o600 });

  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: agentDir,
  };
  // Empty child overlays replace obsolete/inactive values inherited by a retained
  // runner without restoring them as a current launch contract.
  for (const key of PI_AUTH_ENV_KEYS_TO_NEUTRALIZE) env[key] = '';

  if (requestAuthEnabled) {
    if (!projectedRequestAuth) {
      throw new Error('Pi request-auth materialization requires a child capability');
    }
    await ensurePiRequestAuthExtensionAsset(agentDir, requestAuthPurposes);
    env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV] = projectedRequestAuth.capabilityPath;
    // Connected OAuth must not inherit a shell/profile API key as a second credential authority.
    // Empty explicit overlays replace any inherited values in the host's child-environment merge.
    for (const key of PI_DIRECT_AUTH_ENV_KEYS) env[key] = '';
  }

  const requestedStateMode = resolvePiStateSharingMode(input.accountSettings);
  const cwd = readString(input.sessionDirectory);
  if (requestedStateMode === 'shared' && cwd) {
    const sourceEnv = isRecord(input.processEnv)
      ? input.processEnv as Readonly<Record<string, string | undefined>>
      : null;
    const encodedCwdDir = formatPiSessionDirectoryForCwd(cwd);
    const targetSessionsRoot = join(agentDir, 'sessions');
    const targetEncodedSessionsRoot = join(targetSessionsRoot, encodedCwdDir);
    await importSessionFiles(buildPiSessionImportRoots({
      rootDir,
      sourceEnv: sourceEnv ?? process.env,
      encodedCwdDir,
      targetSessionsRoot,
      targetEncodedSessionsRoot,
    }));
  }

  return { env };
}
