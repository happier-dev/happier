import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import { AGENTS_CORE } from '@happier-dev/plugin-sdk/experimental/agents';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { HAPPIER_CLAUDE_CONFIG_DIR_ENV } from '@happier-dev/plugin-sdk/experimental/envConstants';

import {
  diagnoseClaudeCodeNativeAuthMaterialization,
  materializeClaudeCodeNativeAuth,
} from '../auth/services/native/materialize.js';
import { detectClaudeCliAuthStatus } from '../auth/services/cliAuth.js';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '../auth/services/native/scopes.js';
import { sanitizeRetainedClaudeMaterializedHome } from '../auth/services/native/retainedHomeHygiene.js';
import { materializeClaudeApiKeyAuth } from '../auth/services/apiKey.js';
import { createClaudeConnectedServiceRuntimeAuthAdapter } from '../auth/services/runtime/failure.js';
import {
  ClaudeSubscriptionAuthTokensRefreshSelectionSchema,
  computeClaudeSubscriptionAccessTokenFingerprint,
  type ClaudeSubscriptionAuthTokensRefreshSelection,
} from '../auth/services/cloud/refreshBridge.js';
import {
  readClaudeCodeNativeCredentialPayload,
  resolveClaudeCodeCredentialsFilePath,
} from '../auth/services/native/credentials.js';
import { claudeAuthStateSharingDescriptor } from '../auth/services/stateSharing.js';
import { projectClaudeWorkspaceTrust } from '../auth/services/workspaceTrust.js';
import {
  claudeCliSessionCommandConfig,
  resolveClaudeCliSessionOptions,
} from '../cli/command.js';
import { resolveClaudeSessionRuntimePreferences } from '../preferences/session.js';
import { clearClaudeGoal, getClaudeGoal, setClaudeGoal } from '../runtime/goalControl/control.js';
import { probeClaudePreflightModelsRaw } from '../preflight/models.js';
import { mapClaudeProviderFailureToUsageDetails } from '../runtime/issues/runtimeIssues.js';
import { resolveClaudeCodingPromptBehaviorBlocks } from '../prompting/behavior.js';
import { createClaudePromptSubmitVerificationPolicy } from '../runtime/terminal/unified/promptSubmitVerification.js';
import { claudeSubscriptionQuotaFetcherDescriptor } from '../auth/services/quota/subscriptionFetcher.js';

export const CLAUDE_SUPPORTED_AUTH_SERVICE_IDS = Object.freeze([
  'claude-subscription',
  'anthropic',
] as const);

const CLAUDE_MATERIALIZED_HOME_CREDENTIAL_ENTRIES = Object.freeze([
  '.claude.json',
  '.credentials.json',
  'credentials.json',
  'auth.json',
  'accounts',
] as const);

const CLAUDE_TRANSCRIPT_PROOF_MAX_BYTES = 64 * 1024;

type ClaudeSupportedAuthServiceId = typeof CLAUDE_SUPPORTED_AUTH_SERVICE_IDS[number];

function isClaudeSupportedAuthServiceId(value: unknown): value is ClaudeSupportedAuthServiceId {
  return typeof value === 'string'
    && (CLAUDE_SUPPORTED_AUTH_SERVICE_IDS as readonly string[]).includes(value);
}

function readOptionalSafeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readClaudeConnectedServiceId(selection: unknown): ClaudeSupportedAuthServiceId | null {
  if (isClaudeSupportedAuthServiceId(selection)) return selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
  const serviceId = (selection as Readonly<Record<string, unknown>>).serviceId;
  return isClaudeSupportedAuthServiceId(serviceId) ? serviceId : null;
}

export function createClaudeAuthMaterializationInput<TRecord>(
  serviceId: ClaudeSupportedAuthServiceId,
  record: TRecord,
): Readonly<{
  claudeSubscription: TRecord | null;
  anthropic: TRecord | null;
}> {
  return {
    claudeSubscription: serviceId === 'claude-subscription' ? record : null,
    anthropic: serviceId === 'anthropic' ? record : null,
  };
}

export function resolveClaudeVendorResumeIdFromImportedFile(detail: Readonly<{
  relativePath: string;
  sourcePath: string;
  destinationPath: string;
}>): string | null {
  for (const path of [detail.relativePath, detail.sourcePath, detail.destinationPath]) {
    const fileName = basename(path);
    if (!fileName.toLowerCase().endsWith('.jsonl')) continue;
    const candidate = fileName.replace(/\.jsonl$/i, '').trim();
    if (!candidate || candidate.includes('/') || candidate.includes('\\')) continue;
    return candidate;
  }
  return null;
}

export function normalizeClaudeSessionControlPermissionMode(mode: string): string {
  if (mode === 'yolo') return 'bypassPermissions';
  if (mode === 'safe-yolo') return 'acceptEdits';
  return mode;
}

export function ensureClaudeHeadlessTmuxRemoteStartingModeArgs(argv: string[]): string[] {
  const modeFlagIndexes: number[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--happy-starting-mode') {
      modeFlagIndexes.push(index);
    }
  }

  if (modeFlagIndexes.length === 0) {
    return [...argv, '--happy-starting-mode', 'remote'];
  }

  for (const index of modeFlagIndexes) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for --happy-starting-mode (expected "remote" or "local" for terminal mode)');
    }
    if (value === 'remote') continue;
    throw new Error('Headless tmux sessions require remote mode; terminal mode is not supported.');
  }

  return argv;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCredentialRecord(value: unknown): ConnectedServiceCredentialRecordV1 | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ConnectedServiceCredentialRecordV1
    : null;
}

function readExecRuntimeService(value: unknown): ExecRuntimeServiceV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ExecRuntimeServiceV1>;
  return typeof candidate.run === 'function'
    && typeof candidate.systemTools?.resolve === 'function'
    ? candidate as ExecRuntimeServiceV1
    : null;
}

function resolveClaudeConfigDirForAuthMaterialization(env: NodeJS.ProcessEnv): string {
  const explicitClaudeConfigDir = readString(env.CLAUDE_CONFIG_DIR);
  if (explicitClaudeConfigDir) return explicitClaudeConfigDir;
  const happierClaudeConfigDir = readString(env[HAPPIER_CLAUDE_CONFIG_DIR_ENV]);
  if (happierClaudeConfigDir) return happierClaudeConfigDir;
  const home =
    readString(env.HOME)
    ?? readString(env.USERPROFILE)
    ?? homedir();
  return join(home, '.claude');
}

function resolveClaudeConnectedServiceConfigSourceRoot(env: NodeJS.ProcessEnv): string {
  return resolveClaudeConfigDirForAuthMaterialization(env);
}

function readRootDir(input: Readonly<Record<string, unknown>>): string {
  const rootDir = readString(input.rootDir);
  if (!rootDir) {
    throw new Error('Claude connected-service materialization requires a rootDir');
  }
  return rootDir;
}

function readProcessEnv(value: unknown): NodeJS.ProcessEnv | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as NodeJS.ProcessEnv
    : null;
}

export async function materializeClaudeAuthEnvironment(input: Readonly<Record<string, unknown>>): Promise<Readonly<{
  env: Readonly<Record<string, string>>;
  diagnostics?: readonly unknown[];
}>> {
  const claudeConfigDir = readRootDir(input);
  await mkdir(claudeConfigDir, { recursive: true });
  // Carry an already-accepted workspace-trust decision for the session directory
  // into the materialized home so fresh homes never re-prompt the interactive
  // trust dialog (which hangs remote/headless sessions).
  await projectClaudeWorkspaceTrust({
    sourceEnv: readProcessEnv(input.processEnv) ?? process.env,
    targetDir: claudeConfigDir,
    sessionDirectory: readString(input.sessionDirectory),
  });

  const claudeSubscription = readCredentialRecord(input.claudeSubscription);
  if (claudeSubscription) {
    const diagnostics = diagnoseClaudeCodeNativeAuthMaterialization({ record: claudeSubscription });
    if (diagnostics.length > 0) {
      return {
        env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
        diagnostics,
      };
    }
    const materialized = await materializeClaudeCodeNativeAuth({
      exec: readExecRuntimeService(input.exec),
      record: claudeSubscription,
      claudeConfigDir,
    });
    return {
      env: materialized.env,
      diagnostics: materialized.diagnostics,
    };
  }

  const anthropic = readCredentialRecord(input.anthropic);
  if (!anthropic) {
    return { env: { CLAUDE_CONFIG_DIR: claudeConfigDir } };
  }

  return {
    env: {
      ...materializeClaudeApiKeyAuth({ record: anthropic }).env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  };
}

export async function isClaudeMaterializedHomeStale(input: Readonly<{
  serviceId: string;
  materializedRootDir: string;
  record: ConnectedServiceCredentialRecordV1;
  now: number;
  refreshWindowMs: number;
}>): Promise<boolean> {
  if (input.serviceId !== 'claude-subscription') return false;
  if (input.record.kind !== 'oauth') return false;
  const storeFingerprint = computeClaudeSubscriptionAccessTokenFingerprint(input.record.oauth.accessToken);
  if (!storeFingerprint) return false;
  try {
    const raw = await readFile(resolveClaudeCodeCredentialsFilePath(input.materializedRootDir), 'utf8');
    const payload = readClaudeCodeNativeCredentialPayload(JSON.parse(raw));
    if (!payload) return true;
    const homeFingerprint = computeClaudeSubscriptionAccessTokenFingerprint(payload.claudeAiOauth.accessToken);
    if (homeFingerprint !== storeFingerprint) return true;
    const homeExpiresAt = payload.claudeAiOauth.expiresAt;
    if (typeof homeExpiresAt !== 'number' || !Number.isFinite(homeExpiresAt)) return true;
    return homeExpiresAt - input.now <= input.refreshWindowMs;
  } catch {
    return true;
  }
}

function normalizeVendorResumeId(value: unknown): string | null {
  const vendorResumeId = readString(value);
  if (!vendorResumeId || vendorResumeId.includes('/') || vendorResumeId.includes('\\')) return null;
  return vendorResumeId;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readFirstFileChunk(path: string): Promise<Readonly<{ text: string; truncated: boolean }> | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(CLAUDE_TRANSCRIPT_PROOF_MAX_BYTES + 1);
    const result = await handle.read(buffer, 0, buffer.byteLength, 0);
    const truncated = result.bytesRead > CLAUDE_TRANSCRIPT_PROOF_MAX_BYTES;
    const readableBytes = truncated ? CLAUDE_TRANSCRIPT_PROOF_MAX_BYTES : result.bytesRead;
    return {
      text: buffer.toString('utf8', 0, readableBytes),
      truncated,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function readClaudeTranscriptRecordSessionId(record: Record<string, unknown>): string | null {
  if (record.type === 'system' && record.subtype === 'init') {
    return readString(record.session_id);
  }

  const sessionId = readString(record.sessionId);
  if (!sessionId) return null;

  switch (record.type) {
    case 'last-prompt':
    case 'mode':
    case 'permission-mode':
    case 'system':
    case 'user':
    case 'assistant':
      return sessionId;
    default:
      return null;
  }
}

async function readClaudeTranscriptProofSessionId(path: string): Promise<string | null> {
  const chunk = await readFirstFileChunk(path);
  if (!chunk?.text) return null;

  const lines = chunk.text.split(/\r?\n/u);
  if (chunk.truncated && !chunk.text.endsWith('\n') && !chunk.text.endsWith('\r')) {
    lines.pop();
  }
  let proofSessionId: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: Record<string, unknown> | null = null;
    try {
      record = readRecord(JSON.parse(line));
    } catch {
      return null;
    }
    if (!record) return null;
    const rowSessionId = readClaudeTranscriptRecordSessionId(record);
    if (!rowSessionId) continue;
    if (proofSessionId && proofSessionId !== rowSessionId) return null;
    proofSessionId = rowSessionId;
  }
  return proofSessionId;
}

export async function verifyClaudeResumeReachability(input: Readonly<{
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  vendorResumeId?: string | null;
}>): Promise<Readonly<{ ok: true; resolvedPath: string | null } | { ok: false; reason: string }>> {
  const vendorResumeId = normalizeVendorResumeId(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'claude_session_not_in_native_store' };
  }

  const claudeConfigDir = resolveClaudeConfigDirForAuthMaterialization(
    (input.targetMaterializedEnv as NodeJS.ProcessEnv | null | undefined) ?? process.env,
  );
  const projectsDir = join(claudeConfigDir, 'projects');
  let sawUnprovenCandidate = false;

  try {
    const projectEntries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of projectEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const sessionPath = join(projectsDir, String(entry.name), `${vendorResumeId}.jsonl`);
      try {
        const metadata = await stat(sessionPath);
        if (metadata.isFile()) {
          const proofSessionId = await readClaudeTranscriptProofSessionId(sessionPath);
          if (proofSessionId === vendorResumeId) {
            return { ok: true, resolvedPath: sessionPath };
          }
          sawUnprovenCandidate = true;
        }
      } catch {
        // Continue scanning other project folders.
      }
    }
  } catch {
    return { ok: false, reason: 'claude_native_store_unreachable' };
  }

  return {
    ok: false,
    reason: sawUnprovenCandidate
      ? 'claude_session_transcript_unproven'
      : 'claude_session_not_in_native_store',
  };
}

export const CLAUDE_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'claude',
  builtInAcpCatalog: true,
  cliAuth: {
    detectAuthStatus: ({ env }: Readonly<{ env: NodeJS.ProcessEnv }>) =>
      detectClaudeCliAuthStatus({ env }),
  },
  cloudConnect: {
    displayName: 'Claude',
    vendorDisplayName: 'Anthropic Claude',
    vendorKey: AGENTS_CORE.claude.cloudConnect?.vendorKey,
    status: AGENTS_CORE.claude.cloudConnect?.status,
    oauthAuthorizationCode: {
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      authorizeUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      redirectUri: 'https://platform.claude.com/oauth/code/callback',
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
    },
  },
  sessionControls: {
    normalizePermissionMode: normalizeClaudeSessionControlPermissionMode,
  },
  // Native `/goal` effector. The host resolves these into the session goal-control
  // adapter (`getSessionGoalControlAdapter`). For an ACTIVE session the goal router
  // prefers the live RPC (the unified-terminal native runtime injects `/goal`); for
  // an INACTIVE session these handlers seed/clear the goal item in metadata so it is
  // pursued on resume. The `goal_status` attachment remains the source of truth.
  runtimeControl: {
    goal: {
      getGoal: getClaudeGoal,
      setGoal: setClaudeGoal,
      clearGoal: clearClaudeGoal,
    },
  },
  sessionRuntimePreferences: {
    resolve: resolveClaudeSessionRuntimePreferences,
  },
  codingPromptBehavior: {
    resolve: resolveClaudeCodingPromptBehaviorBlocks,
  },
  terminal: {
    transformHeadlessTmuxArgv: ensureClaudeHeadlessTmuxRemoteStartingModeArgs,
    promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
  },
  preflightSessionControls: {
    failureCacheStrategy: 'cooldown',
    probeModelsRaw: probeClaudePreflightModelsRaw,
  },
  cliSessionCommand: {
    ...claudeCliSessionCommandConfig,
    buildSessionOptions: (input: Readonly<{
      args: readonly string[];
      parsed: Readonly<{
        startingMode?: string;
        directory?: string;
        resume?: string;
        providerArgs: readonly string[];
      }>;
    }>) => resolveClaudeCliSessionOptions(input),
  },
  connectedServices: {
    serviceIds: CLAUDE_SUPPORTED_AUTH_SERVICE_IDS,
    noRestartRequiredServiceIds: ['claude-subscription'],
    materializedRootSubdir: 'claude-config',
    materializedHomeCredentialEntries: CLAUDE_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
    resolveStateSharingSourceRoot: ({ env }: Readonly<{ env: NodeJS.ProcessEnv }>) =>
      resolveClaudeConnectedServiceConfigSourceRoot(env),
    runtimeAuthAdapter: createClaudeConnectedServiceRuntimeAuthAdapter(),
    resolveVendorResumeIdFromImportedFile: resolveClaudeVendorResumeIdFromImportedFile,
    readConnectedServiceId: readClaudeConnectedServiceId,
    createAuthMaterializationInput: createClaudeAuthMaterializationInput,
    materializeAuthEnvironment: materializeClaudeAuthEnvironment,
    isMaterializedHomeStale: isClaudeMaterializedHomeStale,
    sanitizeRetainedMaterializedHome: sanitizeRetainedClaudeMaterializedHome,
    stateSharingDescriptor: claudeAuthStateSharingDescriptor,
    quotaFetcherDescriptor: claudeSubscriptionQuotaFetcherDescriptor,
    daemonAuthBridge: {
      refresh: async (input: Readonly<{
        serviceId: string;
        request: Readonly<Record<string, unknown>>;
        refreshCoordinator: Readonly<{
          refreshClaudeSubscriptionTokensForBridge(params: Readonly<{
            selection: ClaudeSubscriptionAuthTokensRefreshSelection;
            forceRefresh: boolean;
            shouldAdoptCurrentAccessToken?: (accessToken: string) => boolean;
          }>): Promise<unknown>;
        }>;
      }>) => {
        if (input.serviceId !== 'claude-subscription') {
          throw new Error(`Claude daemon auth bridge cannot refresh unsupported service '${input.serviceId}'`);
        }
        const failingAccessTokenFingerprint = readOptionalSafeString(input.request.failingAccessTokenFingerprint);
        return await input.refreshCoordinator.refreshClaudeSubscriptionTokensForBridge({
          selection: ClaudeSubscriptionAuthTokensRefreshSelectionSchema.parse(input.request.selection),
          forceRefresh: input.request.forceRefresh === true,
          ...(failingAccessTokenFingerprint
            ? {
                shouldAdoptCurrentAccessToken: (accessToken: string) => {
                  const currentFingerprint = computeClaudeSubscriptionAccessTokenFingerprint(accessToken);
                  return Boolean(currentFingerprint && currentFingerprint !== failingAccessTokenFingerprint);
                },
              }
            : {}),
        });
      },
    },
    shouldRestartForServiceSwitch: (value: unknown) => readClaudeConnectedServiceId(value) !== null,
    restartRematerializeRequiredReason: 'claude_session_state_sharing_required',
    connectedSwitchSharedStateRequiredReason: 'claude_shared_state_required',
    nativeSwitchSharedStateRequiredReason: 'claude_session_state_sharing_required',
    sameAuthGroupRequiresResumeReachability: true,
    resolveResumeReachabilityUnsupported: verifyClaudeResumeReachability,
    classifyUsageLimitError: ({ error }: Readonly<{ error: unknown }>) =>
      mapClaudeProviderFailureToUsageDetails(error),
    usageLimitRecovery: {
      agentId: 'claude',
      issueProviderFilter: 'claude',
      defaultNativeServiceId: 'claude-subscription',
      fallbackBackoffEnvKey: 'HAPPIER_CLAUDE_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS',
      maxAttemptsEnvKey: 'HAPPIER_CLAUDE_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS',
      defaultFallbackBackoffMs: 600_000,
      defaultMaxAttempts: 3,
    },
    recoveryCapabilities: {
      predictiveSoftSwitch: {
        mode: 'supported',
        liveSessionRequirement: {
          kind: 'shared_group_auth_surface',
          serviceIds: ['claude-subscription'],
          authEnvKey: 'CLAUDE_CONFIG_DIR',
          authEnvSubpath: ['claude-config'],
        },
      },
      sameAccountFanoutStrategy: 'shared_group_auth_surface',
      runtimeAuthApply: {
        directLiveHotAuth: {
          supportsInTurnApply: false,
          requiresExactRuntimeIdentity: false,
          refreshSelectionResync: 'not_applicable',
          authMode: {
            kind: 'provider_owned',
            name: 'claude_shared_group_auth_surface',
          },
        },
      },
    },
  },
} as const);
