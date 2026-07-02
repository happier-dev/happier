import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { AGENTS_CORE } from '@happier-dev/agents';
import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import {
  diagnoseClaudeCodeNativeAuthMaterialization,
  materializeClaudeCodeNativeAuth,
} from '../auth/services/native/materialize.js';
import { detectClaudeCliAuthStatus } from '../auth/services/cliAuth.js';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '../auth/services/native/scopes.js';
import { materializeClaudeApiKeyAuth } from '../auth/services/apiKey.js';
import { claudeAuthStateSharingDescriptor } from '../auth/services/stateSharing.js';
import { projectClaudeWorkspaceTrust } from '../auth/services/workspaceTrust.js';
import {
  claudeCliSessionCommandConfig,
  resolveClaudeCliSessionOptions,
} from '../cli/command.js';
import { probeClaudePreflightModels } from '../preflight/models.js';
import { mapClaudeProviderFailureToUsageDetails } from '../runtime/issues/runtimeIssues.js';

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

type ClaudeSupportedAuthServiceId = typeof CLAUDE_SUPPORTED_AUTH_SERVICE_IDS[number];

function isClaudeSupportedAuthServiceId(value: unknown): value is ClaudeSupportedAuthServiceId {
  return typeof value === 'string'
    && (CLAUDE_SUPPORTED_AUTH_SERVICE_IDS as readonly string[]).includes(value);
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

export async function probeClaudePreflightModelsFromCommandOutput(params: Readonly<{
  output: string;
  cwd: string;
  timeoutMs: number;
}>): Promise<Awaited<ReturnType<typeof probeClaudePreflightModels>>> {
  return await probeClaudePreflightModels({
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    probeHelpText: async () => params.output,
  });
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
  const happierClaudeConfigDir = readString(env.HAPPIER_CLAUDE_CONFIG_DIR);
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

function normalizeVendorResumeId(value: unknown): string | null {
  const vendorResumeId = readString(value);
  if (!vendorResumeId || vendorResumeId.includes('/') || vendorResumeId.includes('\\')) return null;
  return vendorResumeId;
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

  try {
    const projectEntries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of projectEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const sessionPath = join(projectsDir, String(entry.name), `${vendorResumeId}.jsonl`);
      try {
        const metadata = await stat(sessionPath);
        if (metadata.isFile()) {
          return { ok: true, resolvedPath: sessionPath };
        }
      } catch {
        // Continue scanning other project folders.
      }
    }
  } catch {
    return { ok: false, reason: 'claude_native_store_unreachable' };
  }

  return { ok: false, reason: 'claude_session_not_in_native_store' };
}

export const CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION = Object.freeze({
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
  terminal: {
    transformHeadlessTmuxArgv: ensureClaudeHeadlessTmuxRemoteStartingModeArgs,
  },
  preflightSessionControls: {
    failureCacheStrategy: 'cooldown',
    probeModelsCommandArgs: ['--help'],
    probeModelsFromCommandOutput: probeClaudePreflightModelsFromCommandOutput,
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
    materializedRootSubdir: 'claude-config',
    materializedHomeCredentialEntries: CLAUDE_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
    resolveStateSharingSourceRoot: ({ env }: Readonly<{ env: NodeJS.ProcessEnv }>) =>
      resolveClaudeConnectedServiceConfigSourceRoot(env),
    resolveVendorResumeIdFromImportedFile: resolveClaudeVendorResumeIdFromImportedFile,
    readConnectedServiceId: readClaudeConnectedServiceId,
    createAuthMaterializationInput: createClaudeAuthMaterializationInput,
    materializeAuthEnvironment: materializeClaudeAuthEnvironment,
    stateSharingDescriptor: claudeAuthStateSharingDescriptor,
    shouldRestartForServiceSwitch: readClaudeConnectedServiceId,
    restartRematerializeRequiredReason: 'claude_session_state_sharing_required',
    connectedSwitchSharedStateRequiredReason: 'claude_shared_state_required',
    nativeSwitchSharedStateRequiredReason: 'claude_session_state_sharing_required',
    sameAuthGroupRequiresResumeReachability: true,
    resolveResumeReachabilityUnsupported: verifyClaudeResumeReachability,
    classifyUsageLimitError: ({ error }: Readonly<{ error: unknown }>) =>
      mapClaudeProviderFailureToUsageDetails(error),
    usageLimitRecovery: {
      providerId: 'claude',
      issueProviderFilter: 'claude',
      defaultNativeServiceId: 'claude-subscription',
      fallbackBackoffEnvKey: 'HAPPIER_CLAUDE_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS',
      maxAttemptsEnvKey: 'HAPPIER_CLAUDE_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS',
      defaultFallbackBackoffMs: 600_000,
      defaultMaxAttempts: 3,
    },
    // Claude account switching is restart/rematerialize-only: predictive
    // (soft-threshold) switches must be suppressed by declared contract rather
    // than inferred from the generic restart-resume adapter shape.
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'unsupported' },
    },
  },
} as const);
