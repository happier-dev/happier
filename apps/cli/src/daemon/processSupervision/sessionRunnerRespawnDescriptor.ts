import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { resolveCanonicalCodexBackendMode } from '@/rpc/handlers/registerSessionHandlers';
import type { TerminalMode, TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';
import {
  AgentRuntimeDescriptorV1Schema,
  BackendTargetRefSchema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  SessionMcpSelectionV1Schema,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import * as z from 'zod';

const TERMINAL_MODES = ['plain', 'tmux', 'windows_terminal', 'windows_console'] as const satisfies readonly TerminalMode[];
const SAFE_RESPAWN_ENVIRONMENT_VARIABLE_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
const MAX_SEALED_RESPAWN_ENVIRONMENT_CIPHERTEXT_CHARS = 65_536;

type RespawnDescriptorEncryptionMaterial =
  | AccountScopedCryptoMaterial
  | Readonly<{ type: 'dataKey'; publicKey: Uint8Array; machineKey: Uint8Array }>;

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

const SealedRespawnEnvironmentVariablesSchema = z.object({
  format: z.literal('account_scoped_v1'),
  ciphertext: z.string().min(1).max(MAX_SEALED_RESPAWN_ENVIRONMENT_CIPHERTEXT_CHARS),
}).strict();

function resolveAccountScopedCryptoMaterial(
  material: RespawnDescriptorEncryptionMaterial,
): AccountScopedCryptoMaterial {
  return material.type === 'legacy'
    ? { type: 'legacy', secret: material.secret }
    : { type: 'dataKey', machineKey: material.machineKey };
}

function pickPersistedEnvironmentVariables(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const persisted = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, raw]) => {
      if (typeof key !== 'string' || typeof raw !== 'string') return [];
      return [[key, raw]];
    }),
  );

  return Object.keys(persisted).length > 0 ? persisted : undefined;
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
      material: resolveAccountScopedCryptoMaterial(params.encryptionMaterial),
      payload: params.environmentVariables,
      randomBytes: params.randomBytes ?? ((length) => new Uint8Array(nodeRandomBytes(length))),
    }),
  };
}

function openRespawnEnvironmentVariables(params: Readonly<{
  sealedEnvironmentVariables: z.infer<typeof SealedRespawnEnvironmentVariablesSchema>;
  encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
}>): Record<string, string> {
  if (!params.encryptionMaterial) {
    throw new Error('Encrypted respawn environment variables require daemon credentials');
  }

  const opened = openAccountScopedBlobCiphertext({
    kind: 'session_respawn_environment',
    material: resolveAccountScopedCryptoMaterial(params.encryptionMaterial),
    ciphertext: params.sealedEnvironmentVariables.ciphertext,
  });
  const parsed = z.record(z.string(), z.string()).safeParse(opened?.value);
  if (!parsed.success) {
    throw new Error('Failed to decrypt respawn environment variables');
  }
  return parsed.data;
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

export const SessionRunnerRespawnDescriptorV1Schema = z
  .preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const candidate = value as Record<string, unknown>;
    const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
      codexBackendMode: candidate.codexBackendMode,
      experimentalCodexAcp: candidate.experimentalCodexAcp === true,
      agentRuntimeDescriptorV1: candidate.agentRuntimeDescriptorV1,
    }) ?? (candidate.experimentalCodexResume === true ? 'acp' : undefined);
    const safeEnvironmentVariables = pickSafeRespawnEnvironmentVariables(candidate.environmentVariables);
    const { experimentalCodexAcp: _legacyExperimentalCodexAcp, experimentalCodexResume: _legacyExperimentalCodexResume, ...rest } = candidate;

    return {
      ...rest,
      ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
      ...(safeEnvironmentVariables ? { environmentVariables: safeEnvironmentVariables } : {}),
    };
  }, z
  .object({
    version: z.literal(1),
    directory: z.string(),
    backendTarget: BackendTargetRefSchema.optional(),
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
    mcpSelection: SessionMcpSelectionV1Schema.optional(),
    agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
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
  const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode: spawnOptions.codexBackendMode,
    experimentalCodexAcp: spawnOptions.experimentalCodexAcp,
    agentRuntimeDescriptorV1: spawnOptions.agentRuntimeDescriptorV1,
  });
  const safeEnvironmentVariables = pickSafeRespawnEnvironmentVariables(spawnOptions.environmentVariables);
  const persistedEnvironmentVariables = pickPersistedEnvironmentVariables(spawnOptions.environmentVariables);
  const sealedEnvironmentVariables = sealRespawnEnvironmentVariables({
    environmentVariables: persistedEnvironmentVariables,
    encryptionMaterial: options?.encryptionMaterial,
    randomBytes: options?.randomBytes,
  });

  const descriptor: SessionRunnerRespawnDescriptorV1 = {
    version: 1,
    directory,
    ...(spawnOptions.backendTarget ? { backendTarget: spawnOptions.backendTarget } : {}),
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
    ...(spawnOptions.mcpSelection ? { mcpSelection: spawnOptions.mcpSelection } : {}),
    ...(spawnOptions.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: spawnOptions.agentRuntimeDescriptorV1 } : {}),
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
    agentRuntimeDescriptorV1: descriptor.agentRuntimeDescriptorV1,
  });
  const environmentVariables = descriptor.sealedEnvironmentVariables
    ? openRespawnEnvironmentVariables({
      sealedEnvironmentVariables: descriptor.sealedEnvironmentVariables,
      encryptionMaterial: options?.encryptionMaterial,
    })
    : descriptor.environmentVariables;

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
    ...(descriptor.mcpSelection ? { mcpSelection: descriptor.mcpSelection } : {}),
    ...(descriptor.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: descriptor.agentRuntimeDescriptorV1 } : {}),
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
    approvedNewDirectoryCreation: true,
  };
}
