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
  type ConnectedServiceOauthCredentialRecordWithExpiryV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { writeAtomicJsonFile } from '@happier-dev/plugin-sdk/experimental/fs';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import { formatPiSessionDirectoryForCwd } from '../../sessionFiles.js';
import {
  PI_BROKER_DAEMON_STATE_PATH_ENV,
  PI_BROKER_EXTENSION_VERSION,
  PI_BROKER_EXTENSION_VERSION_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  applyPiBrokerRefreshTokenEnv,
  buildPiBrokerMarker,
  ensurePiBrokerExtensionAsset,
  piBrokerServiceId,
  piRegisterProviderId,
  serializePiBrokerSelections,
  type PiBrokerProvider,
  type PiBrokerProviderSelection,
  type PiRegisterProviderId,
} from './broker/index.js';

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

/**
 * Build the BROKERED Pi OAuth credential entry written to `auth.json`.
 *
 * CRITICAL (no-leak / dual-refresher fix): unlike the legacy path (which embedded the real
 * `{access, refresh, expires}` via `buildConnectedServiceOauthAuthEntry`, letting Pi self-refresh
 * against the provider and race the daemon), this writes a credential whose `refresh` is a NON-secret
 * Happier marker — never the provider's single-use refresh token. Pi's broker extension overrides the
 * provider's OAuth so `refreshToken` hits the Happier daemon bridge instead of the provider. The daemon
 * is therefore the SOLE refresher; Pi never holds (and never can rotate) a usable refresh token. Pi's
 * current provider API can call `getApiKey` synchronously on first use, so the materialized credential
 * includes the current short-lived access token and its real expiry. Subsequent refreshes still flow
 * through the broker marker + daemon bridge.
 */
function buildPiBrokeredOauthAuthEntry(
  registerProviderId: PiRegisterProviderId,
  record: ConnectedServiceOauthCredentialRecordWithExpiryV1,
): Record<string, unknown> {
  return {
    type: 'oauth',
    // NON-secret marker, NOT the provider refresh token. The broker recognises it and re-brokers.
    refresh: buildPiBrokerMarker(registerProviderId, PI_BROKER_EXTENSION_VERSION),
    // Short-lived access only. This lets Pi's synchronous getApiKey path satisfy the first request while
    // keeping provider refresh authority exclusively in the daemon.
    access: record.oauth.accessToken,
    expires: record.expiresAt,
    ...(record.oauth.providerAccountId ? { accountId: record.oauth.providerAccountId } : {}),
  };
}

function readGroupIdsByServiceId(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: Record<string, string> = {};
  for (const [serviceId, groupId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof groupId === 'string' && groupId.trim().length > 0) {
      entries[serviceId] = groupId.trim();
    }
  }
  return entries;
}

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

  // Brokered OAuth providers (NO real refresh token reaches Pi). Each present here both writes a marker
  // OAuth cred to auth.json AND contributes a broker selection + identity fragment. `provider` is the
  // SHARED bridge tag (openai/anthropic), keying the selections + identity to match the OpenCode broker
  // + shared bridge-call source; the `auth.json` entry + marker use Pi's own provider id.
  const brokerSelections: { -readonly [K in PiBrokerProvider]?: PiBrokerProviderSelection } = {};
  const brokeredProviders: PiBrokerProvider[] = [];
  const identityFragments: string[] = [];
  // R4-4/F3: serviceId → groupId for GROUP-bound selections (host-provided). Scopes the identity by
  // pool WITHOUT generation: two pools sharing one active profile never collapse to one identity,
  // while a generation-only bump keeps the identity stable (consumers treat it as an opaque key).
  const groupIdsByServiceId = readGroupIdsByServiceId(input.connectedServiceGroupIdsByServiceId);

  const brokerProvider = (
    provider: PiBrokerProvider,
    record: ConnectedServiceOauthCredentialRecordWithExpiryV1,
  ): void => {
    const registerProviderId = piRegisterProviderId(provider);
    auth[registerProviderId] = buildPiBrokeredOauthAuthEntry(registerProviderId, record);
    brokerSelections[provider] = {
      serviceId: piBrokerServiceId(provider),
      profileId: record.profileId,
      accountId: record.oauth.providerAccountId ?? null,
      planType: null,
    };
    brokeredProviders.push(provider);
    const groupId = groupIdsByServiceId[piBrokerServiceId(provider)];
    identityFragments.push(
      `${provider}:${record.profileId}:${record.oauth.providerAccountId ?? ''}${groupId ? `:group:${groupId}` : ''}`,
    );
  };

  // OpenAI: Codex subscription is OAuth-only ⇒ always brokered. A platform API key is direct.
  if (openaiCodex) {
    brokerProvider('openai', requireConnectedServiceOauthCredentialRecordWithExpiry(openaiCodex));
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

  // Anthropic: Claude subscription OAuth ⇒ brokered; setup-token ⇒ direct api_key. A Console API key
  // (anthropic service) ⇒ direct api_key. Anthropic-service OAuth remains rejected.
  if (claudeSubscription) {
    if (claudeSubscription.kind === 'oauth') {
      brokerProvider('anthropic', requireConnectedServiceOauthCredentialRecordWithExpiry(claudeSubscription));
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

  await writeAtomicJsonFile({ path: join(agentDir, 'auth.json'), value: auth, mode: 0o600 });

  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: agentDir,
  };

  // Brokered sessions: write the broker extension + emit the broker env (selections, daemon-state path,
  // version, stable selection identity, and the SCOPED refresh token). Direct-API-key / native Pi
  // sessions skip all of this, so their agent dirs + env stay free of the broker.
  if (brokeredProviders.length > 0) {
    await ensurePiBrokerExtensionAsset(agentDir);
    env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections(brokerSelections);
    const daemonStateFilePath = readString(input.daemonStateFilePath);
    if (daemonStateFilePath) {
      env[PI_BROKER_DAEMON_STATE_PATH_ENV] = daemonStateFilePath;
    }
    env[PI_BROKER_EXTENSION_VERSION_ENV] = PI_BROKER_EXTENSION_VERSION;
    // Stable selection identity (keys the broker load handshake + preflight match).
    env[PI_BROKER_SELECTION_IDENTITY_ENV] = [
      'pi',
      'connected',
      `broker:${PI_BROKER_EXTENSION_VERSION}`,
      ...identityFragments.slice().sort(),
    ].join('|');
    // Inject ONLY the derived scoped broker-refresh token (never the master control token). Fail-closed:
    // if the control token is unavailable the token is not injected and the preflight reports it.
    applyPiBrokerRefreshTokenEnv(env, readString(input.daemonControlToken));
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

  return {
    env,
  };
}
