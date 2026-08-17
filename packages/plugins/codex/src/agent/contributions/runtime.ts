import { join, resolve } from 'node:path';

import {
    parseCredentialRecord,
    type OauthCredentialRecord,
    type TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
  expandHomePath,
  resolveHomeDirFromEnvironment,
  writeAtomicJsonFile,
} from '@happier-dev/plugin-sdk/fs';
import { readTrimmedString as readString } from '@happier-dev/plugin-sdk';

import { readCodexEnvironmentAuthState } from '../cli/auth/environment.js';
import {
  CODEX_CLI_AUTH_STATUS_ARGS,
  resolveCodexCliAuthProbeTimeoutMs,
  resolveCodexCliAuthStatus,
} from '../cli/auth/spec.js';
import { codexCloudConnectDescriptor } from '../auth/services/openai/cloud/connect.js';
import {
  CodexChatGptAuthTokensRefreshSelectionSchema,
  CodexChatGptAuthTokensRefreshResponseSchema,
  type CodexChatGptAuthTokensRefreshSelection,
} from '../auth/services/openai/cloud/refreshBridge.js';
import { buildCodexCloudAuthFile } from '../auth/services/openai/cloud/authFile.js';
import {
  codexCliSessionCommandConfig,
  resolveCodexCliSessionExtraOptions,
} from '../cli/command.js';
import { codexChecklists } from '../cli/checklists.js';
import { supportsCodexVendorResume } from '../surfaces/sessions/resume/support.js';
import { codexStateSharingDescriptor } from '../auth/services/state/sharing/descriptor.js';
import { resolveCodexConfiguredSqliteHome } from '../auth/services/state/sharing/files.js';
import {
  createCodexSessionImportRoots,
  resolveCodexVendorResumeIdFromImportedSessionFile,
} from '../auth/services/home/sync/sessionFiles.js';
import { codexPreflightSessionControlsProbeConfig } from '../lifecycle/preflight/sessionControls.js';
import { resolveCodexSessionRuntimePreferences } from '../lifecycle/runtimePreferences.js';
import {
  resolveCodexSqliteStateEntryPattern,
  resolveCodexStateEntryNames,
} from '../auth/services/home/sync/stateEntries.js';
import { codexHandoffSurface } from '../surfaces/sessions/handoff/providerOps.js';
import {
  buildCodexAgentRuntimeDescriptorV1,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from '../../protocol/runtimeDescriptorV1.js';
import { openAiCodexQuotaFetcherDescriptor } from '../auth/services/quota/openaiFetcher.js';
import { createCodexConnectedServiceRuntimeAuthAdapter } from '../auth/services/runtime/control/runtimeAuthAdapter.js';
import { verifyResumeReachableCodex } from '../auth/services/runtime/control/verifyResumeReachable.js';
import {
  resolveCodexConnectedServiceCandidatePersistedSessionFile,
} from '../auth/services/runtime/control/candidateSessionFile.js';
import { resolveCodexCodingPromptBehaviorBlocks } from '../prompting/behavior.js';
import {
  resolveCodexLegacyRuntimeAuthFailureSourceRevision,
} from '../auth/services/runtime/auth/legacyFailureSource.js';
import {
  homeEntries as resolveCodexHomeEntries,
  resolveConfiguredCodexHomePath,
} from '../rollout/discovery/homeEntries.js';
import {
  CODEX_ACP_RUNTIME_INSTALLABLE_LAUNCH_HELPERS,
  hasCodexAcpRuntimeInstallableAdapterPolicy,
} from '../installables/codexAcp.js';

const CODEX_SUPPORTED_AUTH_SERVICE_IDS = Object.freeze([
  'openai-codex',
  'openai',
] as const);

const CODEX_STATE_SHARING_SERVICE_IDS = Object.freeze([
  'openai-codex',
] as const);

const CODEX_MATERIALIZED_HOME_CREDENTIAL_ENTRIES = Object.freeze([
  'auth.json',
  'accounts',
] as const);

type CodexSupportedAuthServiceId = typeof CODEX_SUPPORTED_AUTH_SERVICE_IDS[number];

function isCodexSupportedAuthServiceId(value: unknown): value is CodexSupportedAuthServiceId {
  return typeof value === 'string'
    && (CODEX_SUPPORTED_AUTH_SERVICE_IDS as readonly string[]).includes(value);
}

export function readCodexConnectedServiceId(selection: unknown): CodexSupportedAuthServiceId | null {
  if (isCodexSupportedAuthServiceId(selection)) return selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
  const serviceId = (selection as Readonly<Record<string, unknown>>).serviceId;
  return isCodexSupportedAuthServiceId(serviceId) ? serviceId : null;
}

export function createCodexAuthMaterializationInput<TRecord>(
  serviceId: CodexSupportedAuthServiceId,
  record: TRecord,
): Readonly<{
  openaiCodex: TRecord | null;
  openai: TRecord | null;
}> {
  return {
    openaiCodex: serviceId === 'openai-codex' ? record : null,
    openai: serviceId === 'openai' ? record : null,
  };
}

function expandHomeDirPath(value: string, env: NodeJS.ProcessEnv): string {
  return expandHomePath(value, resolveHomeDirFromEnvironment(env));
}

function resolveCodexHomeForAuthMaterialization(env: NodeJS.ProcessEnv): string {
  const override = readString(env.CODEX_HOME);
  return override ? expandHomeDirPath(override, env) : join(resolveHomeDirFromEnvironment(env), '.codex');
}

function resolveCodexSqliteHomeForStateSharing(params: Readonly<{
  env: NodeJS.ProcessEnv;
  sourceRoot: string;
}>): string {
  return resolve(resolveCodexConfiguredSqliteHome({
    codexSqliteHome: params.env.CODEX_SQLITE_HOME,
    fallbackCodexHome: params.sourceRoot,
    cwd: process.cwd(),
    expandHomePath: (rawPath) => expandHomeDirPath(rawPath, params.env),
  }));
}

function readRootDir(input: Readonly<Record<string, unknown>>): string {
  const rootDir = readString(input.rootDir);
  if (!rootDir) {
    throw new Error('Codex connected-service materialization requires a rootDir');
  }
  return rootDir;
}

function readCredentialRecord(value: unknown): OauthCredentialRecord | TokenCredentialRecord | null {
  const record = parseCredentialRecord(value);
  if (!record) return null;
  return record.kind === 'oauth' ? record : record;
}

function readCredentialRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^csr_[A-Za-z0-9_-]{22,64}$/u.test(value)) {
    throw new Error('Invalid connected-service credential revision');
  }
  return value;
}

function requireCodexOauthRecord(value: unknown): OauthCredentialRecord {
  const record = readCredentialRecord(value);
  if (!record || record.kind !== 'oauth' || record.serviceId !== 'openai-codex') {
    throw new Error('Codex connected-service materialization requires an openai-codex OAuth credential');
  }
  return record;
}

function requireOpenAiTokenRecord(value: unknown): TokenCredentialRecord {
  const record = readCredentialRecord(value);
  if (!record || record.kind !== 'token' || record.serviceId !== 'openai') {
    throw new Error('Codex API-key materialization requires an openai token credential');
  }
  return record;
}

async function resolveCodexPetDiscoveryHomeEntries(
  params: Parameters<typeof resolveCodexHomeEntries>[0],
): Promise<readonly Readonly<{ homePath: string }>[]> {
  const entries = await resolveCodexHomeEntries(params);
  return entries.map((entry) => ({ homePath: entry.codexHome }));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomicJsonFile({ path, value, mode: 0o600 });
}

type CodexConnectedAccountMaterializationAuthority =
  | 'qualified'
  | 'legacy_unfenced_one_shot';

function readConnectedAccountMaterializationAuthority(
  value: unknown,
): CodexConnectedAccountMaterializationAuthority {
  if (value === 'qualified' || value === 'legacy_unfenced_one_shot') {
    return value;
  }
  throw new Error('Codex connected-account materialization requires an exact materialization authority');
}

export async function materializeCodexAuthEnvironment(input: Readonly<Record<string, unknown>>): Promise<Readonly<{
  env: Readonly<Record<string, string>>;
}>> {
  const env: Record<string, string> = {};
  const materializationAuthority = readConnectedAccountMaterializationAuthority(
    input.connectedAccountMaterializationAuthority,
  );
  const acceptsLegacyRawCredential =
    materializationAuthority === 'legacy_unfenced_one_shot';
  if (
    acceptsLegacyRawCredential
    && input.requestAuth !== null
    && input.requestAuth !== undefined
  ) {
    throw new Error('Codex legacy one-shot materialization cannot receive request auth');
  }
  const openaiCodex = readCredentialRecord(input.openaiCodex);
  if (!acceptsLegacyRawCredential) {
    env.CODEX_HOME = readRootDir(input);
  } else if (openaiCodex) {
    const record = requireCodexOauthRecord(openaiCodex);
    const codexHome = readRootDir(input);
    await writeJson(join(codexHome, 'auth.json'), buildCodexCloudAuthFile({
      accessToken: record.oauth.accessToken,
      refreshToken: record.oauth.refreshToken,
      idToken: record.oauth.idToken,
      accountId: record.oauth.providerAccountId,
      lastRefreshIso: new Date().toISOString(),
    }));
    env.CODEX_HOME = codexHome;
  }

  const openai = readCredentialRecord(input.openai);
  if (openai && !openaiCodex && acceptsLegacyRawCredential) {
    env.OPENAI_API_KEY = requireOpenAiTokenRecord(openai).token.token;
  }

  return { env };
}

async function resolveCodexStateSharingStateEntryNames(params: Readonly<{
  sourceRoot: string;
  materializedRootDir: string;
  env: NodeJS.ProcessEnv;
  requestedStateMode: 'isolated' | 'shared';
}>): Promise<readonly string[]> {
  return await resolveCodexStateEntryNames({
    sourceSqliteHome: resolveCodexSqliteHomeForStateSharing({
      env: params.env,
      sourceRoot: params.sourceRoot,
    }),
    destinationCodexHome: params.materializedRootDir,
    stateMode: params.requestedStateMode,
  });
}

function resolveCodexStateSharingStateSourceRoot(params: Readonly<{
  entryName: string;
  sourceRoot: string;
  env: NodeJS.ProcessEnv;
}>): string {
  const sqlitePattern = resolveCodexSqliteStateEntryPattern();
  if (sqlitePattern?.test(params.entryName)) {
    return resolveCodexSqliteHomeForStateSharing({
      env: params.env,
      sourceRoot: params.sourceRoot,
    });
  }
  return params.sourceRoot;
}

export const CODEX_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'codex',
  builtInAcpCatalog: true,
  agentCliSystemTool: {
    toolId: 'codex-cli',
  },
  cloudConnect: codexCloudConnectDescriptor,
  cliAuth: {
    detectAuthStatus: async (params: Readonly<{
      env: NodeJS.ProcessEnv;
      runCommand: (
        args: readonly string[],
        options?: Readonly<{ timeoutMs?: number }>,
      ) => Promise<Readonly<{ ok: boolean; exitCode: number | null }>>;
    }>) => resolveCodexCliAuthStatus({
      commandStatus: await params.runCommand(CODEX_CLI_AUTH_STATUS_ARGS, {
        timeoutMs: resolveCodexCliAuthProbeTimeoutMs(params.env),
      }),
      environmentAuth: readCodexEnvironmentAuthState(params.env),
    }),
  },
  sessionRuntimePreferences: {
    resolve: resolveCodexSessionRuntimePreferences,
  },
  sessionStartup: {
    releasedOverridesCacheV1: true,
    shouldUseDeferredBootstrap: (params: Readonly<{
      startedBy: 'terminal' | 'daemon';
      startingMode: 'terminal' | 'remote' | 'local' | null;
      existingSessionId: string | null;
      sessionAttachFilePath: string | null;
      providerResumeId: string | null;
      hasExplicitPermissionMode: boolean;
      permissionModeSeedSource: 'explicit' | 'inferred' | 'account_default' | 'fallback' | 'released_cache_v1';
      hasTerminalTty: boolean;
    }>) => {
      const terminalLocal = params.startingMode === null
        || params.startingMode === 'terminal'
        || params.startingMode === 'local';
      return params.startedBy === 'terminal'
        && params.hasTerminalTty
        && terminalLocal
        && !params.existingSessionId
        && (
          !params.providerResumeId
          || params.hasExplicitPermissionMode
          || params.permissionModeSeedSource === 'released_cache_v1'
        );
    },
  },
  sessionHandoff: {
    surface: () => codexHandoffSurface,
  },
  codingPromptBehavior: {
    resolve: resolveCodexCodingPromptBehaviorBlocks,
  },
  vendorResumeSupport: {
    resolve: supportsCodexVendorResume,
  },
  checklists: codexChecklists,
  petDiscovery: {
    resolveHomePath: resolveConfiguredCodexHomePath,
    resolveHomeEntries: resolveCodexPetDiscoveryHomeEntries,
  },
  runtimeInstallableAdapter: {
    matchesDescriptor: hasCodexAcpRuntimeInstallableAdapterPolicy,
    resolveSpawnSpec: CODEX_ACP_RUNTIME_INSTALLABLE_LAUNCH_HELPERS.resolveSpawnSpec,
    validateAvailability: CODEX_ACP_RUNTIME_INSTALLABLE_LAUNCH_HELPERS.validateAvailability,
  },
  cliSessionCommand: {
    ...codexCliSessionCommandConfig,
    buildSessionOptions: (input: Readonly<{
      parsed: Readonly<{
        startingMode?: string;
        directory?: string;
        providerArgs: readonly string[];
      }>;
    }>) => resolveCodexCliSessionExtraOptions(input.parsed),
  },
  preflightSessionControls: codexPreflightSessionControlsProbeConfig,
  connectedServices: {
    serviceIds: CODEX_SUPPORTED_AUTH_SERVICE_IDS,
    stateSharingServiceIds: CODEX_STATE_SHARING_SERVICE_IDS,
    materializedRootSubdir: 'codex-home',
    materializedHomeCredentialEntries: CODEX_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
    resolveStateSharingSourceRoot: ({ env }: Readonly<{ env: NodeJS.ProcessEnv }>) =>
      resolveCodexHomeForAuthMaterialization(env),
    resolveStateSharingStateEntryNames: resolveCodexStateSharingStateEntryNames,
    resolveStateSharingStateSourceRoot: resolveCodexStateSharingStateSourceRoot,
    createStateSharingSessionImportRoots: ({
      materializedRootDir,
      sourceRoot,
    }: Readonly<{ materializedRootDir: string; sourceRoot: string }>) =>
      createCodexSessionImportRoots({
        destinationCodexHome: materializedRootDir,
        sourceCodexHome: sourceRoot,
      }),
    resolveVendorResumeIdFromImportedFile: resolveCodexVendorResumeIdFromImportedSessionFile,
    readConnectedServiceId: readCodexConnectedServiceId,
    createAuthMaterializationInput: createCodexAuthMaterializationInput,
    materializeAuthEnvironment: materializeCodexAuthEnvironment,
    stateSharingDescriptor: codexStateSharingDescriptor,
    runtimeAuthAdapter: createCodexConnectedServiceRuntimeAuthAdapter(),
    shouldRestartForServiceSwitch: (selection: unknown) =>
      readCodexConnectedServiceId(selection) !== null,
    unsupportedSwitchReason: (selection: unknown) =>
      readCodexConnectedServiceId(selection) === null
        ? 'unsupported_service'
        : 'codex_process_auth_restart_required',
    exactSameSelectionRequiresResumeReachability: false,
    sameAuthGroupRequiresResumeReachability: true,
    connectedSwitchSharedStateRequiredReason: 'codex_shared_state_required',
    nativeSwitchSharedStateRequiredReason: 'codex_shared_state_required',
    verifyResumeReachable: verifyResumeReachableCodex,
    resolveCandidatePersistedSessionFile: ({ metadata }: Readonly<{ metadata: unknown }>) =>
      resolveCodexConnectedServiceCandidatePersistedSessionFile({ metadata }),
    quotaFetcherDescriptor: openAiCodexQuotaFetcherDescriptor,
    daemonAuthBridge: {
      serviceIds: ['openai-codex'],
      refresh: async (input: Readonly<{
        serviceId: string;
        request: Readonly<Record<string, unknown>>;
        refreshCoordinator: Readonly<{
          refreshOpenAiCodexChatGptTokensForBridge(params: Readonly<{
            refreshAttemptId: string;
            selection: CodexChatGptAuthTokensRefreshSelection;
            chatgptPlanType: string | null;
            forceRefresh: boolean;
            failingAccessTokenFingerprint?: string | null;
            expectedCredentialRevision: string;
          }>): Promise<unknown>;
        }>;
      }>) => {
        if (input.serviceId !== 'openai-codex') {
          throw new Error(`Codex daemon auth bridge cannot refresh unsupported service '${input.serviceId}'`);
        }
        const result = await input.refreshCoordinator.refreshOpenAiCodexChatGptTokensForBridge({
          refreshAttemptId: typeof input.request.refreshAttemptId === 'string'
            && input.request.refreshAttemptId.trim().length > 0
            ? input.request.refreshAttemptId.trim()
            : (() => { throw new Error('connected_service_refresh_attempt_identity_unavailable'); })(),
          selection: CodexChatGptAuthTokensRefreshSelectionSchema.parse(input.request.selection),
          chatgptPlanType: typeof input.request.chatgptPlanType === 'string'
            ? input.request.chatgptPlanType
            : typeof input.request.planType === 'string'
              ? input.request.planType
              : null,
          forceRefresh: input.request.forceRefresh === true,
          ...(typeof input.request.failingAccessTokenFingerprint === 'string'
            ? { failingAccessTokenFingerprint: input.request.failingAccessTokenFingerprint }
            : {}),
          expectedCredentialRevision: readCredentialRevision(input.request.expectedCredentialRevision),
        });
        return {
          status: 'refreshed' as const,
          result: {
            ...CodexChatGptAuthTokensRefreshResponseSchema.parse(result),
            credentialRevision: readCredentialRevision(
              (result as Readonly<Record<string, unknown>>).credentialRevision,
            ),
          },
        };
      },
    },
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'supported' },
      sameAccountFanoutStrategy: 'provider_account_id',
      generationApplicationScope: 'per_session_runtime',
      runtimeAuthApply: {
        directLiveHotAuth: {
          supportsInTurnApply: true,
          requiresExactRuntimeIdentity: true,
          refreshSelectionResync: 'required',
          authMode: {
            kind: 'external_token_injection',
            surface: 'codex_chatgpt_auth_tokens',
          },
        },
      },
    },
    resolveLegacyRuntimeAuthFailureSourceRevision:
      resolveCodexLegacyRuntimeAuthFailureSourceRevision,
  },
} as const);

export {
  buildCodexAgentRuntimeDescriptorV1,
  readCanonicalCodexAgentRuntimeDescriptorV1,
};
