import { z } from 'zod';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol';

import { PERMISSION_MODES } from '@/api/types';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';

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

export const SpawnDaemonSessionRequestSchema = z.object({
  directory: z.string(),
  machineId: z.string().trim().min(1).optional(),
  spawnNonce: z.string().trim().min(1).optional(),
  initialPrompt: z.string().optional(),
  sessionId: z.string().trim().min(1).optional(),
  existingSessionId: z.string().trim().min(1).optional(),
  resume: z.string().trim().min(1).optional(),
  experimentalCodexAcp: z.boolean().optional(),
  permissionMode: SpawnSessionPermissionModeSchema.optional(),
  permissionModeUpdatedAt: z.number().int().optional(),
  modelId: z.string().optional(),
  modelUpdatedAt: z.number().int().optional(),
  backendTarget: SpawnBackendTargetSchema.optional(),
  token: z.string().optional(),
  terminal: SpawnSessionTerminalSchema.optional(),
  windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).optional(),
  windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
  profileId: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
  connectedServices: z.unknown().optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
});

export type SpawnDaemonSessionRequest = z.infer<typeof SpawnDaemonSessionRequestSchema>;

const SPAWN_SESSION_OPTION_KEYS = [
  'machineId',
  'directory',
  'spawnNonce',
  'initialPrompt',
  'sessionId',
  'resume',
  'experimentalCodexAcp',
  'existingSessionId',
  'permissionMode',
  'permissionModeUpdatedAt',
  'modelId',
  'modelUpdatedAt',
  'approvedNewDirectoryCreation',
  'backendTarget',
  'token',
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
