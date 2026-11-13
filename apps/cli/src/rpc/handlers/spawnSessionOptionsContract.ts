import { z } from 'zod';
import { SpawnSessionTerminalSchema } from '@happier-dev/protocol/spawnSession';
import {
  AcpConfigOptionOverridesV1Schema,
  FreshAssignableSessionRoleV1Schema,
  AgentRuntimeDescriptorV1Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  PendingFirstInputV1Schema,
  SessionInitialGoalRequestV1Schema,
  SessionAttachMetadataIdentityPolicySchema,
  SessionMcpSelectionV1Schema,
  SessionSpawnSourceContextV1Schema,
  SessionRoleV1Schema,
  SessionOriginV1Schema,
  ExecutionRunLinkV1Schema,
  resolveAssignableSessionRoleProfileV1,
  SpawnSessionExecutionAuthorizationSchema,
} from '@happier-dev/protocol';

import { PERMISSION_MODES } from '@/api/types';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { resolveCanonicalCodexBackendMode } from './codexBackendMode';

import type { SpawnSessionOptions } from './registerSessionHandlers';
import { lazySchema } from '@happier-dev/protocol';

function asNonEmptyStringTuple<T extends string>(values: readonly T[]): [T, ...T[]] {
  if (values.length === 0) {
    throw new Error('Expected non-empty string tuple');
  }
  return values as [T, ...T[]];
}

export const SpawnSessionPermissionModeSchema = lazySchema(() => z.enum(asNonEmptyStringTuple(PERMISSION_MODES)));
const SpawnBackendTargetSchema = lazySchema(() => z.union([
  z.object({
    kind: z.literal('builtInAgent'),
    agentId: z.enum(asNonEmptyStringTuple(CATALOG_AGENT_IDS as readonly CatalogAgentId[])),
  }),
  z.object({
    kind: z.literal('configuredAcpBackend'),
    backendId: z.string().trim().min(1),
  }),
]));
export { SpawnSessionTerminalSchema };

export { SpawnSessionExecutionAuthorizationSchema };

const SpawnDaemonSessionRequestCompatSchema = lazySchema(() => z.object({
  directory: z.string(),
  machineId: z.string().trim().min(1).optional(),
  spawnNonce: z.string().trim().min(1).optional(),
  accountSettingsVersionHint: z.number().int().min(0).optional(),
  pendingFirstInput: PendingFirstInputV1Schema.optional(),
  sessionId: z.string().trim().min(1).optional(),
  existingSessionId: z.string().trim().min(1).optional(),
  initialTranscriptAfterSeq: z.number().int().min(0).optional(),
  executionAuthorization: SpawnSessionExecutionAuthorizationSchema.optional(),
  initialGoal: SessionInitialGoalRequestV1Schema.optional(),
  attachMetadataIdentityPolicy: SessionAttachMetadataIdentityPolicySchema.optional(),
  approvedNewDirectoryCreation: z.boolean().optional(),
  resume: z.string().trim().min(1).optional(),
  experimentalCodexAcp: z.boolean().optional(),
  codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
  permissionMode: SpawnSessionPermissionModeSchema.optional(),
  permissionModeUpdatedAt: z.number().int().optional(),
  agentModeId: z.string().refine((value) => value.trim().length > 0, {
    message: 'Agent mode ID must not be blank',
  }).optional(),
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
  connectedServicesUpdatedAt: z.number().int().optional(),
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1Schema.optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  sessionRoleV1: SessionRoleV1Schema.optional(),
  /**
   * Creation provenance seeded into the child's initial metadata by the spawn core. Declared so the
   * ingress never strips it; an existing session's persisted origin is never replaced.
   */
  sessionOriginV1: SessionOriginV1Schema.optional(),
  /** Visible-run link seeded before the child's first turn, so its first completed turn can report. */
  executionRunLinkV1: ExecutionRunLinkV1Schema.optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
  /**
   * Typed source recipe for a Replay-seeded child.
   *
   * Declared here so the machine-RPC creation ingress carries it instead of
   * stripping it: this schema is a plain `z.object`, and an undeclared field
   * would be dropped silently, producing an ordinary blank Session that reports
   * success. Honouring it is required semantics — the daemon resolves the seed
   * before creating the child and creates no child on failure.
   */
  sourceContext: SessionSpawnSourceContextV1Schema.optional(),
}).superRefine((request, context) => {
  // Existing-session attach/resume must retain legacy snapshots. A fresh creation may carry only
  // a current assignable role, even though both paths share this transport object.
  if (
    request.sessionRoleV1 !== undefined
    && request.existingSessionId === undefined
    && !FreshAssignableSessionRoleV1Schema.safeParse(request.sessionRoleV1).success
  ) {
    context.addIssue({
      code: 'custom',
      path: ['sessionRoleV1', 'role'],
      message: 'Fresh session role snapshots must be complete and use a current assignable role',
    });
  }
}));

type SpawnDaemonSessionRequestCompat = z.output<typeof SpawnDaemonSessionRequestCompatSchema>;
type SpawnDaemonSessionRequestOutput = Omit<SpawnDaemonSessionRequestCompat, 'experimentalCodexAcp' | 'codexBackendMode'> & {
  codexBackendMode?: SpawnSessionOptions['codexBackendMode'];
};

export const SpawnDaemonSessionRequestSchema = lazySchema(() => SpawnDaemonSessionRequestCompatSchema.transform((request): SpawnDaemonSessionRequestOutput => {
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
}));

export type SpawnDaemonSessionRequest = z.infer<typeof SpawnDaemonSessionRequestSchema>;

/**
 * Catalog admission for fresh role snapshots. Existing-session attach/resume deliberately does not
 * call this owner: a deleted custom identity remains readable from its self-contained snapshot.
 */
export function isFreshSpawnSessionRoleKnownToAccount(
  sessionRoleV1: unknown,
  accountSettings: unknown,
): boolean {
  if (sessionRoleV1 === undefined || sessionRoleV1 === null) return true;
  const parsed = FreshAssignableSessionRoleV1Schema.safeParse(sessionRoleV1);
  if (!parsed.success) return false;
  return resolveAssignableSessionRoleProfileV1(accountSettings, parsed.data.role) !== null;
}

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
  'accountSettingsVersionHint',
  'pendingFirstInput',
  'sessionId',
  'resume',
  'codexBackendMode',
  'agentRuntimeDescriptorV1',
  'existingSessionId',
  'initialTranscriptAfterSeq',
  'executionAuthorization',
  'initialGoal',
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
  'materializationDiagnostics',
  'mcpSelection',
  'sessionRoleV1',
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
