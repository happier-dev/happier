import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import {
  readCanonicalSpawnRuntimeSelectionFromCompatIngress,
  readSpawnRuntimeDescriptorV1,
} from '@/rpc/handlers/spawnRuntimeSelection';
import type { TerminalMode, TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';
import {
  BackendTargetRefSchema,
  BackendTargetRefV2Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  PluginContributionIdentityV1Schema,
  openAccountScopedBlobCiphertext,
  readBackendTargetRefV2,
  RuntimeDescriptorV1Schema,
  sealAccountScopedBlobCiphertext,
  SessionMcpSelectionV1Schema,
  SessionModelSelectionV1Schema,
  SessionProviderBindingMetadataV1Schema,
  buildBackendTargetKeyV2,
  writePersistedBackendTargetRefV2,
  writeRuntimeDescriptorV1ForPersistence,
  type AccountScopedCryptoMaterial,
  type BackendTargetRefV1,
  type BackendTargetRefV2,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';
import * as z from 'zod';
import {
  resolveConcreteBackendTargetRefV2,
  resolveConcreteCompatBackendTargetRefs,
  type ResolvedConcreteBackendTargetRefs,
} from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceMaterializationIdentityEnv';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

const TERMINAL_MODES = ['plain', 'tmux', 'zellij', 'windows_terminal', 'windows_console'] as const satisfies readonly TerminalMode[];
const SAFE_RESPAWN_ENVIRONMENT_VARIABLE_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
] as const;
const MAX_SEALED_RESPAWN_ENVIRONMENT_CIPHERTEXT_CHARS = 65_536;

type RespawnDescriptorEncryptionMaterial = AccountScopedCryptoMaterial;

const SealedRespawnEnvironmentVariablesSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('account_scoped_v1'),
    ciphertext: z.string().min(1).max(MAX_SEALED_RESPAWN_ENVIRONMENT_CIPHERTEXT_CHARS),
  }).strict(),
  z.object({
    format: z.literal('device_local_v1'),
    ciphertext: z.string().min(1).max(MAX_SEALED_RESPAWN_ENVIRONMENT_CIPHERTEXT_CHARS),
  }).strict(),
]);

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
  excludedEnvironmentVariableKeys?: readonly string[];
}>): Record<string, string> | undefined {
  const expandedEnvironmentVariables = pickPersistedEnvironmentVariables(params.expandedEnvironmentVariables) ?? {};
  const safeExtraEnvForChild = pickSafeRespawnEnvironmentVariables(params.extraEnvForChild) ?? {};
  const merged = {
    ...expandedEnvironmentVariables,
    ...safeExtraEnvForChild,
  };
  const excluded = new Set(
    (params.excludedEnvironmentVariableKeys ?? []).map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(merged)) {
    if (excluded.has(key.toLowerCase())) {
      delete merged[key];
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function sealRespawnEnvironmentVariables(params: Readonly<{
  environmentVariables: Record<string, string> | undefined;
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
  randomBytes?: (length: number) => Uint8Array;
}>): z.infer<typeof SealedRespawnEnvironmentVariablesSchema> | undefined {
  if (!params.environmentVariables) return undefined;
  if (params.deviceLocalSecretStorage) {
    return {
      format: 'device_local_v1',
      ciphertext: params.deviceLocalSecretStorage.sealJson({
        purpose: 'session_respawn_environment',
        value: params.environmentVariables,
        randomBytes: params.randomBytes,
      }),
    };
  }
  if (!params.encryptionMaterial) return undefined;
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
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
}>): Record<string, string> | null {
  if (params.sealedEnvironmentVariables.format === 'device_local_v1') {
    if (!params.deviceLocalSecretStorage) return null;
    const opened = params.deviceLocalSecretStorage.openJson({
      purpose: 'session_respawn_environment',
      ciphertext: params.sealedEnvironmentVariables.ciphertext,
    });
    const parsed = z.record(z.string(), z.string()).safeParse(opened);
    return parsed.success ? parsed.data : null;
  }
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

/**
 * Normalizes an already-owned marker's sealed respawn environment. Callers
 * must prove the live process/marker ownership relationship before invoking
 * this write-side helper. Canonical ciphertext is returned byte-for-byte so a
 * later daemon recovery does not rotate its nonce; only the bounded historical
 * tag-6 alias is resealed under canonical tag 5.
 */
export function normalizeOwnedMarkerRespawnEnvironmentCiphertext(
  params: Readonly<{
    sealedEnvironmentVariables: z.infer<
      typeof SealedRespawnEnvironmentVariablesSchema
    >;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
    encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
    randomBytes?: (length: number) => Uint8Array;
  }>,
): z.infer<typeof SealedRespawnEnvironmentVariablesSchema> | null {
  if (params.sealedEnvironmentVariables.format === 'device_local_v1') {
    return params.deviceLocalSecretStorage
      ? params.sealedEnvironmentVariables
      : null;
  }
  if (!params.encryptionMaterial) return null;
  const opened = openAccountScopedBlobCiphertext({
    kind: 'session_respawn_environment',
    material: params.encryptionMaterial,
    ciphertext:
      params.sealedEnvironmentVariables.ciphertext,
  });
  if (!opened) return null;
  const environmentVariables =
    z.record(z.string(), z.string()).safeParse(opened.value);
  if (!environmentVariables.success) return null;
  if (opened.kindTag === 'canonical') {
    return params.sealedEnvironmentVariables;
  }
  if (opened.kindTag !== 'historical_alias') return null;
  return {
    format: 'account_scoped_v1',
    ciphertext: sealAccountScopedBlobCiphertext({
      kind: 'session_respawn_environment',
      material: params.encryptionMaterial,
      payload: environmentVariables.data,
      randomBytes:
        params.randomBytes ?? nodeRandomBytes,
    }),
  };
}

function areBackendTargetRefV1Equal(left: BackendTargetRefV1, right: BackendTargetRefV1): boolean {
  if (left.kind === 'builtInAgent') {
    return right.kind === 'builtInAgent' && left.agentId === right.agentId;
  }
  return right.kind === 'configuredAcpBackend' && left.backendId === right.backendId;
}

/**
 * Supported V1 readers validate the legacy target field but preserve unknown fields. Keep a
 * canonical V2 shadow only when the V1 projection would lose target identity. Remove this adapter
 * after released/predecessor V1 respawn takeover and rollback support has closed.
 */
function resolveNativeV1BackendTargetV2Shadow(
  refs: ResolvedConcreteBackendTargetRefs,
): BackendTargetRefV2 | undefined {
  const legacyRoundTrip = resolveConcreteCompatBackendTargetRefs(refs.backendTarget);
  if (!legacyRoundTrip
    || buildBackendTargetKeyV2(legacyRoundTrip.backendTargetV2) !== buildBackendTargetKeyV2(refs.backendTargetV2)) {
    return refs.backendTargetV2;
  }
  return undefined;
}

function canonicalizeSessionRunnerRespawnDescriptorIngress(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  const parsedAgentIdentity = PluginContributionIdentityV1Schema.safeParse(candidate.agentIdentity);
  const agentIdentityTarget = parsedAgentIdentity.success
    ? readBackendTargetRefV2({
        kind: 'agent',
        identity: parsedAgentIdentity.data,
      })
    : null;
  if (candidate.agentIdentity !== undefined && !agentIdentityTarget) {
    return undefined;
  }
  const legacyBackendTargetRefs = resolveConcreteCompatBackendTargetRefs(
    candidate.backendTarget as never,
  );
  const agentIdentityTargetRefs = agentIdentityTarget
    ? resolveConcreteCompatBackendTargetRefs(agentIdentityTarget)
    : null;
  if (agentIdentityTargetRefs && legacyBackendTargetRefs
    && buildBackendTargetKeyV2(agentIdentityTargetRefs.backendTargetV2)
      !== buildBackendTargetKeyV2(legacyBackendTargetRefs.backendTargetV2)) {
    return undefined;
  }
  const normalizedBackendTargetRefs = agentIdentityTargetRefs ?? legacyBackendTargetRefs;
  const normalizedBackendTargetV2Shadow = resolveConcreteBackendTargetRefV2(
    candidate.backendTargetV2 as never,
  );
  const normalizedBackendTargetV2 = candidate.version === 1 && normalizedBackendTargetV2Shadow
    ? normalizedBackendTargetV2Shadow
    : normalizedBackendTargetRefs?.backendTargetV2 ?? null;
  const persistedBackendTarget = candidate.version === 1
    ? normalizedBackendTargetRefs?.backendTarget
    : normalizedBackendTargetV2;
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
  const hasCanonicalModelSelection = candidate.modelSelection !== undefined;
  const parsedSelection = SessionModelSelectionV1Schema.safeParse(candidate.modelSelection);
  const normalizedParsedSelection = parsedSelection.success
    ? (() => {
        try {
          const selectionTarget = readBackendTargetRefV2(
            parsedSelection.data.ref.agentTargetKey as BackendTargetRefV2Input,
          );
          return SessionModelSelectionV1Schema.parse({
            ...parsedSelection.data,
            ref: {
              ...parsedSelection.data.ref,
              agentTargetKey: buildBackendTargetKeyV2(selectionTarget),
            },
          });
        } catch {
          return parsedSelection.data;
        }
      })()
    : null;
  const legacyModelId = normalizeOptionalString(candidate.modelId);
  const modelSelection = normalizedParsedSelection
    ? normalizedParsedSelection
    : !hasCanonicalModelSelection && legacyModelId && normalizedBackendTargetV2
      ? SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: typeof candidate.modelUpdatedAt === 'number' && Number.isFinite(candidate.modelUpdatedAt)
          ? candidate.modelUpdatedAt
          : 0,
        ref: {
          agentTargetKey: buildBackendTargetKeyV2(normalizedBackendTargetV2),
          providerConnectionId: null,
          modelId: legacyModelId,
        },
      })
      : undefined;
  const {
    experimentalCodexAcp: _legacyExperimentalCodexAcp,
    experimentalCodexResume: _legacyExperimentalCodexResume,
    agentRuntimeDescriptorV1: _legacyAgentRuntimeDescriptorV1,
    agentIdentity: _persistedAgentIdentity,
    ...rest
  } = candidate;

  return {
    ...rest,
    ...(persistedBackendTarget ? { backendTarget: persistedBackendTarget } : {}),
    ...(normalizedBackendTargetV2Shadow ? { backendTargetV2: normalizedBackendTargetV2Shadow } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...(resolvedCanonicalCodexBackendMode ? { codexBackendMode: resolvedCanonicalCodexBackendMode } : {}),
    ...(safeEnvironmentVariables ? { environmentVariables: safeEnvironmentVariables } : {}),
    ...(modelSelection ? { modelSelection } : {}),
  };
}

export const SessionRunnerRespawnDescriptorSchema = z
  .preprocess(canonicalizeSessionRunnerRespawnDescriptorIngress, z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    directory: z.string(),
    backendTarget: z.union([BackendTargetRefSchema, BackendTargetRefV2Schema]).optional(),
    backendTargetV2: BackendTargetRefV2Schema.optional(),
    resume: z.string().optional(),
    vendorResumeId: z.string().optional(),
    existingSessionId: z.string().optional(),
    spawnNonce: z.string().optional(),
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
    modelSelection: SessionModelSelectionV1Schema.optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().int().optional(),
    providerBindingMetadataV1: SessionProviderBindingMetadataV1Schema.optional(),
    sessionConfigOptionOverrides: z.unknown().optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    sealedEnvironmentVariables: SealedRespawnEnvironmentVariablesSchema.optional(),
    connectedServices: z.unknown().optional(),
    connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1Schema.optional(),
    mcpSelection: SessionMcpSelectionV1Schema.optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  })
  .passthrough().superRefine((value, ctx) => {
    const backendTargetRefs = value.backendTarget
      ? resolveConcreteCompatBackendTargetRefs(value.backendTarget)
      : null;
    const backendTargetV2ShadowRefs = value.backendTargetV2
      ? resolveConcreteCompatBackendTargetRefs(value.backendTargetV2)
      : null;
    if (value.backendTargetV2) {
      if (value.version !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backendTargetV2'],
          message: 'Canonical backend target shadow is reserved for native descriptor V1 compatibility',
        });
      }
      if (!backendTargetRefs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backendTarget'],
          message: 'Canonical backend target shadow requires a legacy backend target carrier',
        });
      } else if (!backendTargetV2ShadowRefs
        || !areBackendTargetRefV1Equal(backendTargetRefs.backendTarget, backendTargetV2ShadowRefs.backendTarget)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backendTargetV2'],
          message: 'Canonical backend target shadow must project to the legacy backend target carrier',
        });
      }
    }
    const semanticBackendTargetRefs = value.version === 1 && backendTargetV2ShadowRefs
      ? backendTargetV2ShadowRefs
      : backendTargetRefs;
    if (value.modelSelection && (!semanticBackendTargetRefs
      || value.modelSelection.ref.agentTargetKey !== buildBackendTargetKeyV2(semanticBackendTargetRefs.backendTargetV2))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelSelection', 'ref', 'agentTargetKey'],
        message: 'Model selection agent target must match backendTarget',
      });
    }
    const providerConnectionId = value.modelSelection?.ref.providerConnectionId ?? null;
    const hasProviderContinuity = providerConnectionId !== null || value.providerBindingMetadataV1 !== undefined;
    if (value.version === 1 && hasProviderContinuity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['version'],
        message: 'Provider-bound respawn continuity requires descriptor version 2',
      });
    }
    if (value.version === 2 && !hasProviderContinuity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['version'],
        message: 'Respawn descriptor version 2 is reserved for Provider-bound continuity',
      });
    }
    if (value.providerBindingMetadataV1) {
      if (!providerConnectionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerBindingMetadataV1'],
          message: 'Provider binding continuity requires a Provider-bound model selection',
        });
      } else if (value.providerBindingMetadataV1.connectionId !== providerConnectionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerBindingMetadataV1', 'connectionId'],
          message: 'Provider binding continuity must match the selected Provider connection',
        });
      }
    } else if (providerConnectionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerBindingMetadataV1'],
        message: 'Provider-bound model selection requires binding continuity metadata',
      });
    }
  }));

export type SessionRunnerRespawnDescriptor = z.infer<typeof SessionRunnerRespawnDescriptorSchema>;

/**
 * Compatibility alias retained for existing internal imports while descriptor
 * V1 (native/predecessor) and V2 (Provider-bound) coexist at the same owner.
 */
export const SessionRunnerRespawnDescriptorV1Schema = SessionRunnerRespawnDescriptorSchema;
export type SessionRunnerRespawnDescriptorV1 = SessionRunnerRespawnDescriptor;

export function writeSessionRunnerRespawnDescriptorForPersistence(
  descriptor: SessionRunnerRespawnDescriptorV1,
): Readonly<Record<string, unknown>> {
  const parsed = SessionRunnerRespawnDescriptorV1Schema.parse(descriptor);
  const semanticBackendTarget = parsed.version === 1 && parsed.backendTargetV2
    ? parsed.backendTargetV2
    : parsed.backendTarget;
  const runtimeBackendTarget = semanticBackendTarget
    ? resolveConcreteCompatBackendTargetRefs(semanticBackendTarget)?.backendTargetV2 ?? null
    : null;
  const persistedBackendTarget = runtimeBackendTarget
    ? writePersistedBackendTargetRefV2(runtimeBackendTarget)
    : null;
  const persistedRuntimeDescriptor = parsed.runtimeDescriptorV1
    ? writeRuntimeDescriptorV1ForPersistence(parsed.runtimeDescriptorV1)
    : undefined;
  const persistedModelSelection = parsed.modelSelection && runtimeBackendTarget
    ? {
        ...parsed.modelSelection,
        ref: {
          ...parsed.modelSelection.ref,
          agentTargetKey: buildBackendTargetKeyV2(runtimeBackendTarget),
        },
      }
    : parsed.modelSelection;

  if (persistedBackendTarget?.kind !== 'agent') {
    return {
      ...parsed,
      ...(persistedRuntimeDescriptor ? { runtimeDescriptorV1: persistedRuntimeDescriptor } : {}),
      ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
    };
  }

  const {
    backendTarget: _legacyBackendTarget,
    backendTargetV2: _legacyBackendTargetV2,
    runtimeDescriptorV1: _runtimeDescriptor,
    modelSelection: _modelSelection,
    ...rest
  } = parsed;
  return {
    ...rest,
    agentIdentity: persistedBackendTarget.identity,
    ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
    ...(persistedRuntimeDescriptor ? { runtimeDescriptorV1: persistedRuntimeDescriptor } : {}),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
  spawnOptions: SpawnSessionOptions,
  options?: Readonly<{
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
    encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
    randomBytes?: (length: number) => Uint8Array;
    vendorResumeId?: string;
  }>,
): SessionRunnerRespawnDescriptorV1 | null {
  const directory = normalizeOptionalString(spawnOptions.directory);
  if (!directory) return null;
  const resume = normalizeOptionalString(spawnOptions.resume);
  const vendorResumeId = normalizeOptionalString(options?.vendorResumeId);
  const existingSessionId = normalizeOptionalString(spawnOptions.existingSessionId);
  const spawnNonce = normalizeOptionalString(spawnOptions.spawnNonce);
  const transcriptStorage = spawnOptions.transcriptStorage === 'direct' ? 'direct' : undefined;
  const canonicalBackendTarget = resolveConcreteBackendTargetRefV2(spawnOptions.backendTarget);
  const backendTargetRefs = canonicalBackendTarget
    ? resolveConcreteCompatBackendTargetRefs(canonicalBackendTarget)
    : null;
  const safeEnvironmentVariables = pickSafeRespawnEnvironmentVariables(spawnOptions.environmentVariables);
  const persistedEnvironmentVariables = pickPersistedEnvironmentVariables(spawnOptions.environmentVariables);
  const {
    codexBackendMode: canonicalCodexBackendMode,
  } = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
    codexBackendMode: spawnOptions.codexBackendMode,
    experimentalCodexAcp: spawnOptions.experimentalCodexAcp,
    runtimeDescriptorV1: spawnOptions.runtimeDescriptorV1,
  });
  const runtimeDescriptorV1 = readSpawnRuntimeDescriptorV1(spawnOptions);
  const selectedProviderConnectionId = spawnOptions.modelSelection?.ref.providerConnectionId ?? null;
  const backendTarget = selectedProviderConnectionId
    ? backendTargetRefs?.backendTargetV2
    : backendTargetRefs?.backendTarget;
  const backendTargetV2Shadow = !selectedProviderConnectionId && backendTargetRefs
    ? resolveNativeV1BackendTargetV2Shadow(backendTargetRefs)
    : undefined;
  if ((spawnOptions.providerBindingMetadataV1 && !selectedProviderConnectionId)
    || (!spawnOptions.providerBindingMetadataV1 && selectedProviderConnectionId)
    || (spawnOptions.providerBindingMetadataV1
      && selectedProviderConnectionId
      && spawnOptions.providerBindingMetadataV1.connectionId !== selectedProviderConnectionId)) {
    return null;
  }
  const sealedEnvironmentVariables = sealRespawnEnvironmentVariables({
    environmentVariables: persistedEnvironmentVariables,
    deviceLocalSecretStorage: options?.deviceLocalSecretStorage,
    encryptionMaterial: options?.encryptionMaterial,
    randomBytes: options?.randomBytes,
  });

  const descriptor: SessionRunnerRespawnDescriptor = {
    version: selectedProviderConnectionId ? 2 : 1,
    directory,
    ...(backendTarget ? { backendTarget } : {}),
    ...(backendTargetV2Shadow ? { backendTargetV2: backendTargetV2Shadow } : {}),
    ...(resume ? { resume } : {}),
    ...(vendorResumeId ? { vendorResumeId } : {}),
    ...(existingSessionId ? { existingSessionId } : {}),
    ...(spawnNonce ? { spawnNonce } : {}),
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
    ...(spawnOptions.modelSelection ? { modelSelection: spawnOptions.modelSelection } : {}),
    ...(spawnOptions.modelSelection?.ref.providerConnectionId === null
      ? {
          modelId: spawnOptions.modelSelection.ref.modelId,
          modelUpdatedAt: spawnOptions.modelSelection.updatedAt,
        }
      : {}),
    ...(spawnOptions.providerBindingMetadataV1
      && selectedProviderConnectionId
      ? { providerBindingMetadataV1: spawnOptions.providerBindingMetadataV1 }
      : {}),
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
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
    encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
  }>,
): SpawnSessionOptions {
  const {
    codexBackendMode: canonicalCodexBackendMode,
  } = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
    codexBackendMode: descriptor.codexBackendMode,
    runtimeDescriptorV1: descriptor.runtimeDescriptorV1,
  });
  const openedEnvironmentVariables = descriptor.sealedEnvironmentVariables
    ? openRespawnEnvironmentVariables({
        sealedEnvironmentVariables: descriptor.sealedEnvironmentVariables,
        deviceLocalSecretStorage: options?.deviceLocalSecretStorage,
        encryptionMaterial: options?.encryptionMaterial,
      })
    : null;
  const environmentVariables = openedEnvironmentVariables ?? descriptor.environmentVariables;
  const persistedBackendTarget = descriptor.version === 1 && descriptor.backendTargetV2
    ? descriptor.backendTargetV2
    : descriptor.backendTarget;
  const backendTarget = persistedBackendTarget
    ? resolveConcreteCompatBackendTargetRefs(persistedBackendTarget)?.backendTargetV2
    : null;

  return {
    directory: descriptor.directory,
    ...(backendTarget ? { backendTarget } : {}),
    ...(typeof descriptor.resume === 'string' ? { resume: descriptor.resume } : {}),
    ...(typeof descriptor.existingSessionId === 'string' ? { existingSessionId: descriptor.existingSessionId } : {}),
    ...(typeof descriptor.spawnNonce === 'string' ? { spawnNonce: descriptor.spawnNonce } : {}),
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
    ...(descriptor.modelSelection ? { modelSelection: descriptor.modelSelection } : {}),
    ...(descriptor.providerBindingMetadataV1
      ? { providerBindingMetadataV1: descriptor.providerBindingMetadataV1 }
      : {}),
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
