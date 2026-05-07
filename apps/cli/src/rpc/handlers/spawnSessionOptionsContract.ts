import { z } from 'zod';
import {
  AcpConfigOptionOverridesV1Schema,
  AgentRuntimeDescriptorV1Schema,
  SessionAttachMetadataIdentityPolicySchema,
  SessionMcpSelectionV1Schema,
} from '@happier-dev/protocol';

import { PERMISSION_MODES } from '@/api/types';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { resolveCanonicalCodexBackendMode } from './registerSessionHandlers';

import type { SpawnSessionOptions } from './registerSessionHandlers';

function asNonEmptyStringTuple<T extends string>(values: readonly T[]): [T, ...T[]] {
  if (values.length === 0) {
    throw new Error('Expected non-empty string tuple');
  }
  return values as [T, ...T[]];
}

export const SpawnSessionPermissionModeSchema = z.enum(asNonEmptyStringTuple(PERMISSION_MODES));
const SpawnBackendTargetSchema = z.union([
  z.object({
    kind: z.literal('builtInAgent'),
    agentId: z.enum(asNonEmptyStringTuple(CATALOG_AGENT_IDS as readonly CatalogAgentId[])),
  }),
  z.object({
    kind: z.literal('configuredAcpBackend'),
    backendId: z.string().trim().min(1),
  }),
]);
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
  backendTarget: SpawnBackendTargetSchema.optional(),
  terminal: SpawnSessionTerminalSchema.optional(),
  windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).optional(),
  windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
  windowsTerminalWindowName: z.string().optional(),
  profileId: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
  connectedServices: z.unknown().optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
});

export const SpawnDaemonSessionRequestSchema = SpawnDaemonSessionRequestCompatSchema.transform((request) => {
  const { experimentalCodexAcp: _experimentalCodexAcp, codexBackendMode, ...rest } = request;
  const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode,
    experimentalCodexAcp: _experimentalCodexAcp,
    agentRuntimeDescriptorV1: request.agentRuntimeDescriptorV1,
  });

  return {
    ...rest,
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
  };
});

export type SpawnDaemonSessionRequest = z.infer<typeof SpawnDaemonSessionRequestSchema>;

export function normalizeSpawnSessionDirectory(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = directory.trim();
  if (!trimmed) {
    return '';
  }
  return expandHomeDirPath(trimmed, env);
}

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
  'windowsTerminalWindowName',
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
