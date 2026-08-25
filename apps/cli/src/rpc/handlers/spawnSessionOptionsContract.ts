import { z } from 'zod';
import {
  AcpConfigOptionOverridesV1Schema,
  AgentSessionStartupInstructionsV1Schema,
  RuntimeDescriptorV1Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  SessionCreationCorrespondenceV1Schema,
  SessionAttachMetadataIdentityPolicySchema,
  SessionMcpSelectionV1Schema,
  SessionModelSelectionV1Schema,
  SessionCreationTagV1Schema,
  SessionProviderBindingSecurityChangeConfirmationV1Schema,
  SpawnSessionExecutionAuthorizationSchema,
  buildBackendTargetKeyV2,
  type BackendTargetRefV2,
} from '@happier-dev/protocol';

import { PERMISSION_MODES } from '@/api/types';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { normalizeDaemonBackendTargetV2Input } from '@/daemon/backendTargetRouting';

import {
  NativeForkSourceSchema,
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import { readCanonicalSpawnRuntimeSelectionFromCompatIngress } from './spawnRuntimeSelection';

function asNonEmptyStringTuple<T extends string>(values: readonly T[]): [T, ...T[]] {
  if (values.length === 0) {
    throw new Error('Expected non-empty string tuple');
  }
  return values as [T, ...T[]];
}

export const SpawnSessionPermissionModeSchema = z.enum(asNonEmptyStringTuple(PERMISSION_MODES));
function parseSpawnBackendTargetCandidate(value: unknown): CanonicalSpawnBackendTarget | null {
  const backendTarget = normalizeDaemonBackendTargetV2Input(value);
  if (!backendTarget) {
    return null;
  }
  if (!isSupportedSpawnBackendTarget(backendTarget)) {
    return null;
  }
  return backendTarget;
}

function isSupportedSpawnBackendTarget(backendTarget: CanonicalSpawnBackendTarget): boolean {
  if (backendTarget.backendId === 'customAcp' || backendTarget.configuredBackendId === 'customAcp') {
    return false;
  }

  if (backendTarget.sourceKind === 'built_in' && !isCatalogAgentId(backendTarget.backendId)) {
    return false;
  }

  return true;
}

function isKnownCatalogAgentId(value: string): value is CatalogAgentId {
  return isCatalogAgentId(value);
}

type CanonicalSpawnBackendTarget = BackendTargetRefV2;

export type SpawnDaemonSessionRequest = Omit<
  SpawnSessionOptions,
  | 'experimentalCodexAcp'
  | 'backendTarget'
  | 'nativeResumeReference'
  | 'providerBindingMetadataV1'
> & {
  /** Private machine transport discriminator retained for lifecycle routing. */
  type?: 'spawn-in-directory' | 'resume-session';
  backendTarget?: BackendTargetRefV2;
};

export function canonicalizeSpawnBackendTargetFromTransportInput(params: Readonly<{
  backendTarget?: unknown;
  legacyAgent?: unknown;
}>): Readonly<{ backendTarget?: CanonicalSpawnBackendTarget; errorMessage?: string }> {
  if (params.backendTarget !== undefined) {
    const parsedBackendTarget = parseSpawnBackendTargetCandidate(params.backendTarget);
    if (!parsedBackendTarget) {
      return { errorMessage: 'Unknown backend target' };
    }
    return { backendTarget: parsedBackendTarget };
  }

  const normalizedLegacyAgent = typeof params.legacyAgent === 'string' ? params.legacyAgent.trim() : '';
  if (!normalizedLegacyAgent) {
    return {};
  }
  if (!isKnownCatalogAgentId(normalizedLegacyAgent)) {
    return { errorMessage: 'Unknown backend target' };
  }
  return {
    backendTarget: {
      kind: 'backend',
      backendId: normalizedLegacyAgent,
      sourceKind: 'built_in',
    },
  };
}

export const SpawnSessionTerminalSchema = z.object({
  mode: z.enum(['plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.union([z.string(), z.null()]).optional(),
  }).optional(),
});

function canonicalizeSpawnDaemonSessionRequestIngress(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const request = value as Record<string, unknown>;
  const { runtimeDescriptorV1 } = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
    runtimeDescriptorV1: request.runtimeDescriptorV1,
    legacyAgentRuntimeDescriptorV1: request.agentRuntimeDescriptorV1,
  });
  const { agentRuntimeDescriptorV1: _legacyAgentRuntimeDescriptorV1, ...rest } = request;

  return runtimeDescriptorV1
    ? {
      ...rest,
      runtimeDescriptorV1,
    }
    : rest;
}

const SpawnDaemonSessionRequestCompatSchema = z.preprocess(canonicalizeSpawnDaemonSessionRequestIngress, z.object({
  type: z.enum(['spawn-in-directory', 'resume-session']).optional(),
  directory: z.string(),
  approvedNewDirectoryCreation: z.boolean().optional(),
  machineId: z.string().trim().min(1).optional(),
  spawnNonce: z.string().trim().min(1).optional(),
  sessionCreationTag: SessionCreationTagV1Schema.optional(),
  sessionCreationCorrespondence: SessionCreationCorrespondenceV1Schema.optional(),
  initialTitle: z.string().trim().min(1).optional(),
  pendingFirstInput: z.object({
    text: z.string().refine((value) => value.trim().length > 0),
    localId: z.string().refine((value) => value.trim().length > 0),
  }).optional(),
  accountSettingsVersionHint: z.number().int().min(0).optional(),
  sessionId: z.string().trim().min(1).optional(),
  existingSessionId: z.string().trim().min(1).optional(),
  initialTranscriptAfterSeq: z.number().int().min(0).optional(),
  executionAuthorization: SpawnSessionExecutionAuthorizationSchema.optional(),
  attachMetadataIdentityPolicy: SessionAttachMetadataIdentityPolicySchema.optional(),
  resume: z.string().trim().min(1).optional(),
  nativeForkSource: NativeForkSourceSchema.optional(),
  agentSessionStartupInstructionsV1:
    AgentSessionStartupInstructionsV1Schema.optional(),
  experimentalCodexAcp: z.boolean().optional(),
  backendMode: z.string().trim().min(1).optional(),
  codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
  permissionMode: SpawnSessionPermissionModeSchema.optional(),
  permissionModeUpdatedAt: z.number().int().optional(),
  agentModeId: z.string().trim().min(1).optional(),
  agentModeUpdatedAt: z.number().int().optional(),
  modelId: z.string().optional(),
  modelUpdatedAt: z.number().int().optional(),
  modelSelection: SessionModelSelectionV1Schema.optional(),
  providerBindingSecurityChangeConfirmationV1: SessionProviderBindingSecurityChangeConfirmationV1Schema.optional(),
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  backendTarget: z.any().optional(),
  agent: z.string().trim().min(1).optional(),
  terminal: SpawnSessionTerminalSchema.optional(),
  windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).optional(),
  windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
  windowsTerminalWindowName: z.string().optional(),
  profileId: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
  connectedServices: z.unknown().optional(),
  connectedServicesUpdatedAt: z.number().int().optional(),
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1Schema.optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
}).strict());

export const SpawnDaemonSessionRequestSchema = SpawnDaemonSessionRequestCompatSchema.transform((request, ctx) => {
  if (request.resume && request.nativeForkSource) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'resume and nativeForkSource are mutually exclusive',
      path: ['nativeForkSource'],
    });
    return z.NEVER;
  }
  if (
    request.nativeForkSource
    && request.agentSessionStartupInstructionsV1
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Startup instructions are not supported for fork requests',
      path: ['agentSessionStartupInstructionsV1'],
    });
    return z.NEVER;
  }
  if (
    request.sessionCreationCorrespondence
    && request.sessionCreationCorrespondence.sessionCreationTag !== request.sessionCreationTag
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Session creation correspondence must match sessionCreationTag',
      path: ['sessionCreationCorrespondence'],
    });
    return z.NEVER;
  }
  const {
    experimentalCodexAcp: _experimentalCodexAcp,
    backendMode,
    codexBackendMode,
    agent,
    approvedNewDirectoryCreation,
    modelId: legacyModelId,
    modelUpdatedAt: legacyModelUpdatedAt,
    ...rest
  } = request;
  const canonicalBackendTarget = rest.backendTarget !== undefined
    ? canonicalizeSpawnBackendTargetFromTransportInput({
      backendTarget: rest.backendTarget,
    }).backendTarget
    : canonicalizeSpawnBackendTargetFromTransportInput({
      legacyAgent: agent,
    }).backendTarget;
  const hasBackendTargetInput = rest.backendTarget !== undefined || Boolean(typeof agent === 'string' && agent.trim().length > 0);
  if (hasBackendTargetInput && !canonicalBackendTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unknown backend target',
      path: ['backendTarget'],
    });
    return z.NEVER;
  }
  const targetKey = canonicalBackendTarget ? buildBackendTargetKeyV2(canonicalBackendTarget) : null;
  if (rest.modelSelection && (!targetKey || rest.modelSelection.ref.agentTargetKey !== targetKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Model selection agent target must match backendTarget',
      path: ['modelSelection', 'ref', 'agentTargetKey'],
    });
    return z.NEVER;
  }
  const normalizedLegacyModelId = typeof legacyModelId === 'string' ? legacyModelId.trim() : '';
  if (normalizedLegacyModelId && !targetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTarget is required when modelId is provided',
      path: ['backendTarget'],
    });
    return z.NEVER;
  }
  const modelSelection = rest.modelSelection ?? (normalizedLegacyModelId && targetKey
    ? SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: legacyModelUpdatedAt ?? Date.now(),
      ref: { agentTargetKey: targetKey, providerConnectionId: null, modelId: normalizedLegacyModelId },
    })
    : undefined);
  const {
    codexBackendMode: canonicalCodexBackendMode,
    runtimeDescriptorV1,
  } = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
    backendMode,
    codexBackendMode,
    experimentalCodexAcp: _experimentalCodexAcp,
    runtimeDescriptorV1: request.runtimeDescriptorV1,
  });

  return {
    ...rest,
    ...(approvedNewDirectoryCreation !== undefined ? { approvedNewDirectoryCreation } : {}),
    ...(canonicalBackendTarget ? { backendTarget: canonicalBackendTarget } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(backendMode ? { backendMode } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
  };
}) as z.ZodType<SpawnDaemonSessionRequest>;

const SPAWN_SESSION_OPTION_KEYS = [
  'machineId',
  'directory',
  'spawnNonce',
  'sessionCreationTag',
  'sessionCreationCorrespondence',
  'initialTitle',
  'pendingFirstInput',
  'accountSettingsVersionHint',
  'sessionId',
  'resume',
  'nativeForkSource',
  'agentSessionStartupInstructionsV1',
  'backendMode',
  'codexBackendMode',
  'runtimeDescriptorV1',
  'existingSessionId',
  'initialTranscriptAfterSeq',
  'executionAuthorization',
  'attachMetadataIdentityPolicy',
  'permissionMode',
  'permissionModeUpdatedAt',
  'agentModeId',
  'agentModeUpdatedAt',
  'modelSelection',
  'sessionConfigOptionOverrides',
  'approvedNewDirectoryCreation',
  'backendTarget',
  'terminal',
  'windowsRemoteSessionLaunchMode',
  'windowsRemoteSessionConsole',
  'windowsTerminalWindowName',
  'profileId',
  'environmentVariables',
  'connectedServices',
  'connectedServicesUpdatedAt',
  'connectedServiceMaterializationIdentityV1',
  'mcpSelection',
  'transcriptStorage',
] as const satisfies readonly (keyof SpawnSessionOptions)[];

type SpawnSessionOptionKey = (typeof SPAWN_SESSION_OPTION_KEYS)[number];

export function pickDefinedSpawnSessionOptions(options: Partial<SpawnSessionOptions>): Partial<SpawnSessionOptions> {
  const result: Partial<SpawnSessionOptions> = {};

  for (const key of SPAWN_SESSION_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      (result as Record<SpawnSessionOptionKey, unknown>)[key] = value;
    }
  }

  return result;
}

export function mergeSpawnSessionOptions(
  options: Partial<SpawnSessionOptions>,
  overrides: Partial<SpawnSessionOptions> = {},
  params: { omit?: readonly SpawnSessionOptionKey[] } = {},
): Partial<SpawnSessionOptions> {
  const result = pickDefinedSpawnSessionOptions(options);

  for (const key of params.omit ?? []) {
    delete result[key];
  }

  return {
    ...result,
    ...pickDefinedSpawnSessionOptions(overrides),
  };
}
