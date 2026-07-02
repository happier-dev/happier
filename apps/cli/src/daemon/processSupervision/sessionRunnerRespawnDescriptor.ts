import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';
import {
  readCanonicalSpawnRuntimeSelectionFromCompatIngress,
  readSpawnRuntimeDescriptorV1,
} from '@/rpc/handlers/spawnRuntimeSelection';
import {
  resolveCanonicalCodexBackendMode,
  resolveCanonicalCodexBackendModeFromCompatInput,
} from '@happier-dev/plugins-codex/agent/lifecycle/backendMode';
import type { TerminalMode, TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';
import {
  BackendTargetRefV2Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  openAccountScopedBlobCiphertext,
  RuntimeDescriptorV1Schema,
  normalizeBackendTargetRefV2InputToV2,
  sealAccountScopedBlobCiphertext,
  SessionMcpSelectionV1Schema,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';
import * as z from 'zod';
import {
  resolveConcreteBackendTargetRefV2,
  resolveConcreteCompatBackendTargetRefs,
} from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceMaterializationIdentityEnv';

const TERMINAL_MODES = ['plain', 'tmux', 'windows_terminal', 'windows_console'] as const satisfies readonly TerminalMode[];
const SAFE_RESPAWN_ENVIRONMENT_VARIABLE_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
] as const;
const MAX_SEALED_RESPAWN_ENVIRONMENT_CIPHERTEXT_CHARS = 65_536;

type RespawnDescriptorEncryptionMaterial = AccountScopedCryptoMaterial;

const SealedRespawnEnvironmentVariablesSchema = z.object({
  format: z.literal('account_scoped_v1'),
  ciphertext: z.string().min(1).max(MAX_SEALED_RESPAWN_ENVIRONMENT_CIPHERTEXT_CHARS),
}).strict();

const TerminalTmuxSpawnOptionsSchema: z.ZodType<NonNullable<TerminalSpawnOptions['tmux']>> = z
  .object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const TerminalSpawnOptionsSchema: z.ZodType<TerminalSpawnOptions> = z
  .object({
    mode: z.enum(TERMINAL_MODES).optional(),
    tmux: TerminalTmuxSpawnOptionsSchema.optional(),
  })
  .passthrough();

function pickPersistedEnvironmentVariables(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const persisted = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, raw]) => {
      if (typeof key !== 'string' || typeof raw !== 'string') return [];
      const trimmed = raw.trim();
      return trimmed ? [[key, trimmed]] : [];
    }),
  );

  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

function pickSafeRespawnEnvironmentVariables(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const persisted = Object.fromEntries(
    SAFE_RESPAWN_ENVIRONMENT_VARIABLE_KEYS.flatMap((key) => {
      const raw = record[key];
      if (typeof raw !== 'string') return [];
      const trimmed = raw.trim();
      return trimmed ? [[key, trimmed]] : [];
    }),
  );

  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

export function buildTrackedSessionRespawnEnvironmentVariables(params: Readonly<{
  expandedEnvironmentVariables: unknown;
  extraEnvForChild: unknown;
}>): Record<string, string> | undefined {
  const expandedEnvironmentVariables = pickPersistedEnvironmentVariables(params.expandedEnvironmentVariables) ?? {};
  const safeExtraEnvForChild = pickSafeRespawnEnvironmentVariables(params.extraEnvForChild) ?? {};
  const merged = {
    ...expandedEnvironmentVariables,
    ...safeExtraEnvForChild,
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function sealRespawnEnvironmentVariables(params: Readonly<{
  environmentVariables: Record<string, string> | undefined;
  encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
  randomBytes?: (length: number) => Uint8Array;
}>): z.infer<typeof SealedRespawnEnvironmentVariablesSchema> | undefined {
  if (!params.environmentVariables || !params.encryptionMaterial) return undefined;
  return {
    format: 'account_scoped_v1',
    ciphertext: sealAccountScopedBlobCiphertext({
      kind: 'session_respawn_environment',
      material: params.encryptionMaterial,
      payload: params.environmentVariables,
      randomBytes: params.randomBytes ?? nodeRandomBytes,
    }),
  };
}

function openRespawnEnvironmentVariables(params: Readonly<{
  sealedEnvironmentVariables: z.infer<typeof SealedRespawnEnvironmentVariablesSchema>;
  encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
}>): Record<string, string> | null {
  if (!params.encryptionMaterial) return null;

  const opened = openAccountScopedBlobCiphertext({
    kind: 'session_respawn_environment',
    material: params.encryptionMaterial,
    ciphertext: params.sealedEnvironmentVariables.ciphertext,
  });
  if (!opened) return null;

  const parsed = z.record(z.string(), z.string()).safeParse(opened.value);
  return parsed.success ? parsed.data : null;
}

function canonicalizeSessionRunnerRespawnDescriptorIngress(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  const normalizedBackendTarget = normalizeBackendTargetRefV2InputToV2(candidate.backendTarget);
  const {
    runtimeDescriptorV1,
    codexBackendMode: canonicalCodexBackendMode,
  } = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
    codexBackendMode: candidate.codexBackendMode,
    experimentalCodexAcp: candidate.experimentalCodexAcp,
    runtimeDescriptorV1: candidate.runtimeDescriptorV1,
    legacyAgentRuntimeDescriptorV1: candidate.agentRuntimeDescriptorV1,
  });
  const resolvedCanonicalCodexBackendMode = canonicalCodexBackendMode
    ?? (candidate.experimentalCodexResume === true ? 'acp' : undefined);
  const safeEnvironmentVariables = pickSafeRespawnEnvironmentVariables(candidate.environmentVariables);
  const {
    experimentalCodexAcp: _legacyExperimentalCodexAcp,
    experimentalCodexResume: _legacyExperimentalCodexResume,
    agentRuntimeDescriptorV1: _legacyAgentRuntimeDescriptorV1,
    ...rest
  } = candidate;

  return {
    ...rest,
    ...(normalizedBackendTarget ? { backendTarget: normalizedBackendTarget } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...(resolvedCanonicalCodexBackendMode ? { codexBackendMode: resolvedCanonicalCodexBackendMode } : {}),
    ...(safeEnvironmentVariables ? { environmentVariables: safeEnvironmentVariables } : {}),
  };
}

export const SessionRunnerRespawnDescriptorV1Schema = z
  .preprocess(canonicalizeSessionRunnerRespawnDescriptorIngress, z
  .object({
    version: z.literal(1),
    directory: z.string(),
    backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema).optional(),
    resume: z.string().optional(),
    transcriptStorage: z.enum(['persisted', 'direct']).optional(),
    terminal: TerminalSpawnOptionsSchema.optional(),
    windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).optional(),
    windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
    windowsTerminalWindowName: z.string().optional(),
    profileId: z.string().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().int().optional(),
    agentModeId: z.string().optional(),
    agentModeUpdatedAt: z.number().int().optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().int().optional(),
    sessionConfigOptionOverrides: z.unknown().optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    sealedEnvironmentVariables: SealedRespawnEnvironmentVariablesSchema.optional(),
    connectedServices: z.unknown().optional(),
    connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1Schema.optional(),
    mcpSelection: SessionMcpSelectionV1Schema.optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  })
  .passthrough());

export type SessionRunnerRespawnDescriptorV1 = z.infer<typeof SessionRunnerRespawnDescriptorV1Schema>;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
  spawnOptions: SpawnSessionOptions,
  options?: Readonly<{
    encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
    randomBytes?: (length: number) => Uint8Array;
  }>,
): SessionRunnerRespawnDescriptorV1 | null {
  const directory = normalizeOptionalString(spawnOptions.directory);
  if (!directory) return null;
  const resume = normalizeOptionalString(spawnOptions.resume);
  const transcriptStorage = spawnOptions.transcriptStorage === 'direct' ? 'direct' : undefined;
  const canonicalBackendTarget = resolveConcreteBackendTargetRefV2(spawnOptions.backendTarget);
  const backendTarget = canonicalBackendTarget ?? undefined;
  const safeEnvironmentVariables = pickSafeRespawnEnvironmentVariables(spawnOptions.environmentVariables);
  const persistedEnvironmentVariables = pickPersistedEnvironmentVariables(spawnOptions.environmentVariables);
  const canonicalCodexBackendMode = resolveCanonicalCodexBackendModeFromCompatInput({
    codexBackendMode: spawnOptions.codexBackendMode,
    experimentalCodexAcp: spawnOptions.experimentalCodexAcp,
    runtimeDescriptorV1: spawnOptions.runtimeDescriptorV1,
  });
  const runtimeDescriptorV1 = readSpawnRuntimeDescriptorV1(spawnOptions);
  const sealedEnvironmentVariables = sealRespawnEnvironmentVariables({
    environmentVariables: persistedEnvironmentVariables,
    encryptionMaterial: options?.encryptionMaterial,
    randomBytes: options?.randomBytes,
  });

  const descriptor: SessionRunnerRespawnDescriptorV1 = {
    version: 1,
    directory,
    ...(backendTarget ? { backendTarget } : {}),
    ...(resume ? { resume } : {}),
    ...(transcriptStorage ? { transcriptStorage } : {}),
    ...(spawnOptions.terminal ? { terminal: spawnOptions.terminal } : {}),
    ...(spawnOptions.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: spawnOptions.windowsRemoteSessionLaunchMode } : {}),
    ...(spawnOptions.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: spawnOptions.windowsRemoteSessionConsole } : {}),
    ...(spawnOptions.windowsTerminalWindowName ? { windowsTerminalWindowName: spawnOptions.windowsTerminalWindowName } : {}),
    ...(typeof spawnOptions.profileId === 'string' ? { profileId: spawnOptions.profileId } : {}),
    ...(typeof spawnOptions.permissionMode === 'string' ? { permissionMode: spawnOptions.permissionMode } : {}),
    ...(typeof spawnOptions.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: spawnOptions.permissionModeUpdatedAt } : {}),
    ...(typeof spawnOptions.agentModeId === 'string' ? { agentModeId: spawnOptions.agentModeId } : {}),
    ...(typeof spawnOptions.agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt: spawnOptions.agentModeUpdatedAt } : {}),
    ...(typeof spawnOptions.modelId === 'string' ? { modelId: spawnOptions.modelId } : {}),
    ...(typeof spawnOptions.modelUpdatedAt === 'number' ? { modelUpdatedAt: spawnOptions.modelUpdatedAt } : {}),
    ...(spawnOptions.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: spawnOptions.sessionConfigOptionOverrides } : {}),
    ...(safeEnvironmentVariables ? { environmentVariables: safeEnvironmentVariables } : {}),
    ...(sealedEnvironmentVariables ? { sealedEnvironmentVariables } : {}),
    ...(spawnOptions.connectedServices ? { connectedServices: spawnOptions.connectedServices } : {}),
    ...(spawnOptions.connectedServiceMaterializationIdentityV1
      ? { connectedServiceMaterializationIdentityV1: spawnOptions.connectedServiceMaterializationIdentityV1 }
      : {}),
    ...(spawnOptions.mcpSelection ? { mcpSelection: spawnOptions.mcpSelection } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
  };

  const parsed = SessionRunnerRespawnDescriptorV1Schema.safeParse(descriptor);
  return parsed.success ? parsed.data : null;
}

export function buildSpawnSessionOptionsFromRespawnDescriptorV1(
  descriptor: SessionRunnerRespawnDescriptorV1,
  options?: Readonly<{
    encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
  }>,
): SpawnSessionOptions {
  const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode: descriptor.codexBackendMode,
    runtimeDescriptorV1: descriptor.runtimeDescriptorV1,
  });
  const openedEnvironmentVariables = descriptor.sealedEnvironmentVariables
    ? openRespawnEnvironmentVariables({
        sealedEnvironmentVariables: descriptor.sealedEnvironmentVariables,
        encryptionMaterial: options?.encryptionMaterial,
      })
    : null;
  const environmentVariables = openedEnvironmentVariables ?? descriptor.environmentVariables;

  return {
    directory: descriptor.directory,
    ...(descriptor.backendTarget ? { backendTarget: descriptor.backendTarget } : {}),
    ...(typeof descriptor.resume === 'string' ? { resume: descriptor.resume } : {}),
    ...(descriptor.transcriptStorage === 'direct' ? { transcriptStorage: 'direct' } : {}),
    ...(descriptor.terminal ? { terminal: descriptor.terminal } : {}),
    ...(descriptor.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: descriptor.windowsRemoteSessionLaunchMode } : {}),
    ...(descriptor.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: descriptor.windowsRemoteSessionConsole } : {}),
    ...(descriptor.windowsTerminalWindowName ? { windowsTerminalWindowName: descriptor.windowsTerminalWindowName } : {}),
    ...(typeof descriptor.profileId === 'string' ? { profileId: descriptor.profileId } : {}),
    ...(typeof descriptor.permissionMode === 'string' ? { permissionMode: descriptor.permissionMode as any } : {}),
    ...(typeof descriptor.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: descriptor.permissionModeUpdatedAt } : {}),
    ...(typeof descriptor.agentModeId === 'string' ? { agentModeId: descriptor.agentModeId } : {}),
    ...(typeof descriptor.agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt: descriptor.agentModeUpdatedAt } : {}),
    ...(typeof descriptor.modelId === 'string' ? { modelId: descriptor.modelId } : {}),
    ...(typeof descriptor.modelUpdatedAt === 'number' ? { modelUpdatedAt: descriptor.modelUpdatedAt } : {}),
    ...(descriptor.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: descriptor.sessionConfigOptionOverrides as any } : {}),
    ...(environmentVariables ? { environmentVariables } : {}),
    ...(descriptor.connectedServices ? { connectedServices: descriptor.connectedServices } : {}),
    ...(descriptor.connectedServiceMaterializationIdentityV1
      ? { connectedServiceMaterializationIdentityV1: descriptor.connectedServiceMaterializationIdentityV1 }
      : {}),
    ...(descriptor.mcpSelection ? { mcpSelection: descriptor.mcpSelection } : {}),
    ...(descriptor.runtimeDescriptorV1 ? { runtimeDescriptorV1: descriptor.runtimeDescriptorV1 } : {}),
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
    approvedNewDirectoryCreation: true,
  };
}
