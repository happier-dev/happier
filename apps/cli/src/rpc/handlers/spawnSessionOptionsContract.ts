import { z } from 'zod';
import {
  AcpConfigOptionOverridesV1Schema,
  RuntimeDescriptorV1Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  SessionAttachMetadataIdentityPolicySchema,
  SessionMcpSelectionV1Schema,
  type BackendTargetRefV2,
} from '@happier-dev/protocol';

import { PERMISSION_MODES } from '@/api/types';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { normalizeDaemonBackendTargetV2Input } from '@/daemon/backendTargetRouting';

import type { SpawnSessionOptions } from './registerSessionHandlers';
import { readCanonicalSpawnRuntimeSelectionFromCompatIngress } from './spawnRuntimeSelection';

function asNonEmptyStringTuple<T extends string>(values: readonly T[]): [T, ...T[]] {
  if (values.length === 0) {
    throw new Error('Expected non-empty string tuple');
  }
  return values as [T, ...T[]];
}

export const SpawnSessionPermissionModeSchema = z.enum(asNonEmptyStringTuple(PERMISSION_MODES));
const RESOLVABLE_BUILT_IN_AGENT_IDS = CATALOG_AGENT_IDS as readonly CatalogAgentId[];
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

  if (backendTarget.sourceKind === 'built_in' && !RESOLVABLE_BUILT_IN_AGENT_IDS.includes(backendTarget.backendId as CatalogAgentId)) {
    return false;
  }

  return true;
}

function isKnownCatalogAgentId(value: string): value is CatalogAgentId {
  return (RESOLVABLE_BUILT_IN_AGENT_IDS as readonly string[]).includes(value);
}

type CanonicalSpawnBackendTarget = BackendTargetRefV2;

export type SpawnDaemonSessionRequest = Omit<
  SpawnSessionOptions,
  'experimentalCodexAcp' | 'backendTarget'
> & {
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
  directory: z.string(),
  approvedNewDirectoryCreation: z.boolean().optional(),
  machineId: z.string().trim().min(1).optional(),
  spawnNonce: z.string().trim().min(1).optional(),
  accountSettingsVersionHint: z.number().int().min(0).optional(),
  initialPrompt: z.string().optional(),
  sessionId: z.string().trim().min(1).optional(),
  existingSessionId: z.string().trim().min(1).optional(),
  initialTranscriptAfterSeq: z.number().int().min(0).optional(),
  attachMetadataIdentityPolicy: SessionAttachMetadataIdentityPolicySchema.optional(),
  resume: z.string().trim().min(1).optional(),
  experimentalCodexAcp: z.boolean().optional(),
  codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
  permissionMode: SpawnSessionPermissionModeSchema.optional(),
  permissionModeUpdatedAt: z.number().int().optional(),
  agentModeId: z.string().trim().min(1).optional(),
  agentModeUpdatedAt: z.number().int().optional(),
  modelId: z.string().optional(),
  modelUpdatedAt: z.number().int().optional(),
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
}));

export const SpawnDaemonSessionRequestSchema = SpawnDaemonSessionRequestCompatSchema.transform((request, ctx) => {
  const {
    experimentalCodexAcp: _experimentalCodexAcp,
    codexBackendMode,
    agent,
    approvedNewDirectoryCreation,
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
  const {
    codexBackendMode: canonicalCodexBackendMode,
    runtimeDescriptorV1,
  } = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
    codexBackendMode,
    experimentalCodexAcp: _experimentalCodexAcp,
    runtimeDescriptorV1: request.runtimeDescriptorV1,
  });

  return {
    ...rest,
    ...(approvedNewDirectoryCreation !== undefined ? { approvedNewDirectoryCreation } : {}),
    ...(canonicalBackendTarget ? { backendTarget: canonicalBackendTarget } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
  };
}) as z.ZodType<SpawnDaemonSessionRequest>;

const SPAWN_SESSION_OPTION_KEYS = [
  'machineId',
  'directory',
  'spawnNonce',
  'accountSettingsVersionHint',
  'initialPrompt',
  'sessionId',
  'resume',
  'codexBackendMode',
  'runtimeDescriptorV1',
  'existingSessionId',
  'initialTranscriptAfterSeq',
  'attachMetadataIdentityPolicy',
  'permissionMode',
  'permissionModeUpdatedAt',
  'agentModeId',
  'agentModeUpdatedAt',
  'modelId',
  'modelUpdatedAt',
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
