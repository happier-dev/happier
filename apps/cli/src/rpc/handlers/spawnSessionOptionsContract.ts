import { z } from 'zod';
import {
  AcpConfigOptionOverridesV1Schema,
  AgentRuntimeDescriptorV1Schema,
  SessionAttachMetadataIdentityPolicySchema,
  SessionMcpSelectionV1Schema,
  normalizeBackendTargetRefV2InputToV2,
  BackendTargetRefV2Schema,
} from '@happier-dev/protocol';

import { PERMISSION_MODES } from '@/api/types';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { resolveCanonicalCodexBackendMode } from './registerSessionHandlers';

import type { SpawnSessionOptions } from './registerSessionHandlers';

function asNonEmptyStringTuple<T extends string>(values: readonly T[]): [T, ...T[]] {
  if (values.length === 0) {
    throw new Error('Expected non-empty string tuple');
  }
  return values as [T, ...T[]];
}

export const SpawnSessionPermissionModeSchema = z.enum(asNonEmptyStringTuple(PERMISSION_MODES));
const RESOLVABLE_BUILT_IN_AGENT_IDS = (CATALOG_AGENT_IDS as readonly CatalogAgentId[]).filter(
  (agentId): agentId is CatalogAgentId => agentId !== 'customAcp',
);
function parseSpawnBackendTargetCandidate(value: unknown): CanonicalSpawnBackendTarget | null {
  try {
    const normalizedValue = normalizeBackendTargetRefV2InputToV2(value);
    const parsedBackendTarget = BackendTargetRefV2Schema.safeParse(normalizedValue);
    if (!parsedBackendTarget.success) {
      return null;
    }

    const backendTarget = parsedBackendTarget.data;
    if (!isSupportedSpawnBackendTarget(backendTarget)) {
      return null;
    }

    return backendTarget;
  } catch {
    return null;
  }
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

type CanonicalSpawnBackendTarget = z.infer<typeof BackendTargetRefV2Schema>;

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

const SpawnDaemonSessionRequestCompatSchema = z.object({
  directory: z.string(),
  machineId: z.string().trim().min(1).optional(),
  spawnNonce: z.string().trim().min(1).optional(),
  initialPrompt: z.string().optional(),
  sessionId: z.string().trim().min(1).optional(),
  existingSessionId: z.string().trim().min(1).optional(),
  attachMetadataIdentityPolicy: SessionAttachMetadataIdentityPolicySchema.optional(),
  resume: z.string().trim().min(1).optional(),
  experimentalCodexAcp: z.boolean().optional(),
  codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
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
  profileId: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
  connectedServices: z.unknown().optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
});

export const SpawnDaemonSessionRequestSchema = SpawnDaemonSessionRequestCompatSchema.transform((request) => {
  const {
    experimentalCodexAcp: _experimentalCodexAcp,
    codexBackendMode,
    agent,
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
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'Unknown backend target',
        path: ['backendTarget'],
      },
    ]);
  }
  if (canonicalBackendTarget && !isSupportedSpawnBackendTarget(canonicalBackendTarget)) {
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'Unknown backend target',
        path: ['backendTarget'],
      },
    ]);
  }
  const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode,
    experimentalCodexAcp: _experimentalCodexAcp,
    agentRuntimeDescriptorV1: request.agentRuntimeDescriptorV1,
  });

  return {
    ...rest,
    ...(canonicalBackendTarget ? { backendTarget: canonicalBackendTarget } : {}),
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
  };
});

export type SpawnDaemonSessionRequest = z.infer<typeof SpawnDaemonSessionRequestSchema>;

const SPAWN_SESSION_OPTION_KEYS = [
  'machineId',
  'directory',
  'spawnNonce',
  'initialPrompt',
  'sessionId',
  'resume',
  'codexBackendMode',
  'agentRuntimeDescriptorV1',
  'existingSessionId',
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
  'profileId',
  'environmentVariables',
  'connectedServices',
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
