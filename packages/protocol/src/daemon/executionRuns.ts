import { z } from 'zod';

import {
  ExecutionRunClassSchema,
  ExecutionRunDisplaySchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleSchema,
  ExecutionRunRetentionPolicySchema,
  ExecutionRunStatusSchema,
} from '../execution/runs/index.js';
import {
  BackendTargetRefV2Schema,
  BackendTargetSourceKindV2Schema,
  normalizeBackendTargetRefV2InputToV2,
} from '../backends/targets/backendTargetRefV2.js';
import { hasLegacyCustomAcpConcreteBackendId } from '../backends/targets/compat/customAcp.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  PersistedConnectedServiceBindingsV1Schema,
} from '../connect/connectedServiceBindings.js';
import {
  ConnectedServiceAuthGroupPolicyV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
} from '../connect/connectedServiceSchemas.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '../runtime/agentSessionLimitsV1.js';

const EXECUTION_RUN_MARKER_RESULT_SIZE_MAX_BYTES =
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates.sendRequestMaxJsonBytes;

/**
 * Daemon-scoped execution run listing.
 *
 * This is a machine-wide view of execution runs discovered via a daemon-readable
 * file registry. It is intentionally best-effort and may contain stale entries
 * if session processes crash or the machine reboots.
 */

/**
 * The immutable Agent contribution the runner was actually launched with.
 *
 * `agentId` is a host routing id and survives a reload; it says nothing about which build of the
 * Agent a live runner is executing. Restart adoption reconstructs Connected Account purposes and
 * request-auth uses from the daemon's CURRENT registry, so without this fact a runner still
 * executing generation G1 could be handed authority derived from G2's declarations. Recording the
 * exact contribution identity plus its immutable generation lets adoption demand correspondence
 * instead of trusting run/PID liveness as generation proof.
 */
export const ExecutionRunAgentContributionIdentityV1Schema = z.object({
  pluginId: z.string().trim().min(1).max(256),
  localId: z.string().trim().min(1).max(256),
  immutableGenerationId: z.string().trim().min(1).max(256),
}).strict();
export type ExecutionRunAgentContributionIdentityV1 = z.infer<
  typeof ExecutionRunAgentContributionIdentityV1Schema
>;

export const ExecutionRunConnectedServicesLaunchV1Schema = z.object({
  v: z.literal(1),
  activationId: z.string().uuid().optional(),
  runKey: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  /**
   * Absent only for a record whose writer could not prove the Agent generation. Adoption treats
   * that as unproven and refuses, rather than upgrading it into fresh request-auth authority.
   */
  agentContribution: ExecutionRunAgentContributionIdentityV1Schema.optional(),
  materializationKey: z.string().trim().min(1),
  connectedServicesBindings: ConnectedServiceBindingsV1Schema,
  connectedServiceSelectionsEnv: z.record(z.string(), z.string()),
  sessionDirectory: z.string().trim().min(1).nullable(),
  materializedRoot: z.string().trim().min(1).nullable(),
}).strict();
export type ExecutionRunConnectedServicesLaunchV1 = z.infer<typeof ExecutionRunConnectedServicesLaunchV1Schema>;

const PersistedConnectedServiceChildSelectionV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('profile'),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('group'),
    serviceId: ConnectedServiceIdSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    activeProfileId: ConnectedServiceProfileIdSchema,
    fallbackProfileId: ConnectedServiceProfileIdSchema,
    generation: z.number().int().nonnegative(),
    policy: ConnectedServiceAuthGroupPolicyV1Schema,
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema.optional(),
  }).strict(),
]);

const PersistedConnectedServiceSelectionsJsonSchema = z.string().trim().min(1).transform((raw, ctx) => {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid connected service selections JSON' });
    return z.NEVER;
  }
  const parsed = z.array(PersistedConnectedServiceChildSelectionV1Schema).safeParse(parsedJson);
  if (!parsed.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid connected service selections' });
    return z.NEVER;
  }
  const serviceIds = parsed.data.map((selection) => selection.serviceId);
  if (new Set(serviceIds).size !== serviceIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate connected service selection' });
    return z.NEVER;
  }
  return JSON.stringify(parsed.data);
});

const PERSISTED_CONNECTED_SERVICE_SELECTIONS_ENV_KEY =
  'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';
const PERSISTED_SELECTION_IDENTITY_ENV_KEY_PATTERN =
  /^[A-Z][A-Z0-9_]*CONNECTED_SERVICE_SELECTION_IDENTITY$/;
const PERSISTED_SELECTION_IDENTITY_VALUE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/|+=-]{0,511}$/;
const SECRET_BEARING_IDENTITY_VALUE_PATTERN =
  /^(?:bearer[ :]|sk-|gh[opusr]_|github_pat_|xox[baprs]-|ya29[.-])/i;

const PersistedConnectedServiceSelectionsEnvSchema = z.record(
  z.string(),
  z.string(),
).transform((env, ctx) => {
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(env)) {
    if (key === PERSISTED_CONNECTED_SERVICE_SELECTIONS_ENV_KEY) {
      const parsed = PersistedConnectedServiceSelectionsJsonSchema.safeParse(rawValue);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid persisted connected service selections' });
        return z.NEVER;
      }
      normalized[key] = parsed.data;
      continue;
    }
    const value = rawValue.trim();
    if (
      !PERSISTED_SELECTION_IDENTITY_ENV_KEY_PATTERN.test(key)
      || !PERSISTED_SELECTION_IDENTITY_VALUE_PATTERN.test(value)
      || SECRET_BEARING_IDENTITY_VALUE_PATTERN.test(value)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid persisted selection identity environment' });
      return z.NEVER;
    }
    normalized[key] = value;
  }
  return normalized;
});

const PersistedCurrentExecutionRunConnectedServicesLaunchV1Schema =
  ExecutionRunConnectedServicesLaunchV1Schema.extend({
    connectedServicesBindings: PersistedConnectedServiceBindingsV1Schema,
    connectedServiceSelectionsEnv: PersistedConnectedServiceSelectionsEnvSchema,
  }).strict();

const RemoteDevRuntimeAccountIdentitySelectionFactV1Schema = z.object({
  serviceId: ConnectedServiceIdSchema,
  profileId: z.string().trim().min(1),
  groupId: z.string().trim().min(1).nullable(),
  groupGeneration: z.number().int().nonnegative().nullable(),
  providerAccountId: z.string().trim().min(1),
  accountLabel: z.string().trim().min(1).nullable(),
  source: z.enum(['spawn_selection', 'group_switch_selection', 'codex_live_auth_apply']),
}).strict();

/**
 * Exact non-secret launch fact written by the moving remote-dev predecessor.
 *
 * This is a persisted-marker compatibility seam only. The current materialization
 * request/response contract remains ExecutionRunConnectedServicesLaunchV1Schema.
 */
export const RemoteDevExecutionRunConnectedServicesLaunchV1Schema = z.object({
  v: z.literal(1),
  runKey: z.string().regex(
    /^execution_run:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
  agentId: z.string().trim().min(1),
  connectedServicesBindings: PersistedConnectedServiceBindingsV1Schema,
  brokerSelectionIdentity: z.string().trim().min(1).nullable().optional(),
  runtimeAccountIdentitySelections: z.array(
    RemoteDevRuntimeAccountIdentitySelectionFactV1Schema,
  ).readonly().default([]),
  connectedServiceSelectionsJson: PersistedConnectedServiceSelectionsJsonSchema.nullable().optional(),
  sessionDirectory: z.string().trim().min(1).nullable().optional(),
  materializedRoot: z.string().trim().min(1).nullable(),
}).strict();
export type RemoteDevExecutionRunConnectedServicesLaunchV1 = z.infer<
  typeof RemoteDevExecutionRunConnectedServicesLaunchV1Schema
>;

export const PersistedExecutionRunConnectedServicesLaunchV1Schema = z.union([
  PersistedCurrentExecutionRunConnectedServicesLaunchV1Schema,
  RemoteDevExecutionRunConnectedServicesLaunchV1Schema,
]);
export type PersistedExecutionRunConnectedServicesLaunchV1 = z.infer<
  typeof PersistedExecutionRunConnectedServicesLaunchV1Schema
>;

export type NormalizedPersistedExecutionRunConnectedServicesLaunchV1 = Readonly<{
  source: 'current' | 'remote_dev_predecessor';
  registration: ExecutionRunConnectedServicesLaunchV1;
}>;

export function normalizePersistedExecutionRunConnectedServicesLaunchV1(
  value: unknown,
): NormalizedPersistedExecutionRunConnectedServicesLaunchV1 | null {
  const current = PersistedCurrentExecutionRunConnectedServicesLaunchV1Schema.safeParse(value);
  if (current.success) return { source: 'current', registration: current.data };
  const predecessor = RemoteDevExecutionRunConnectedServicesLaunchV1Schema.safeParse(value);
  if (!predecessor.success) return null;
  return {
    source: 'remote_dev_predecessor',
    registration: {
      v: 1,
      runKey: predecessor.data.runKey,
      agentId: predecessor.data.agentId,
      materializationKey: predecessor.data.runKey,
      connectedServicesBindings: predecessor.data.connectedServicesBindings,
      connectedServiceSelectionsEnv: predecessor.data.connectedServiceSelectionsJson
        ? { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: predecessor.data.connectedServiceSelectionsJson }
        : {},
      sessionDirectory: predecessor.data.sessionDirectory ?? null,
      materializedRoot: predecessor.data.materializedRoot,
    },
  };
}

const REMOTE_DEV_EXECUTION_RUN_MARKER_ID_PATTERN =
  /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isPersistedExecutionRunConnectedServicesLaunchIdentityExact(input: Readonly<{
  markerRunId: string;
  normalized: NormalizedPersistedExecutionRunConnectedServicesLaunchV1;
}>): boolean {
  if (input.normalized.source === 'current') {
    return input.normalized.registration.runKey === input.markerRunId;
  }
  return REMOTE_DEV_EXECUTION_RUN_MARKER_ID_PATTERN.test(input.markerRunId)
    && input.normalized.registration.runKey !== input.markerRunId;
}

const DaemonExecutionRunMarkerBackendIdentitySchema = z.preprocess(
  (value) => {
    const parsed = BackendTargetRefV2Schema.safeParse(
      normalizeBackendTargetRefV2InputToV2(value),
    );
    if (!parsed.success) return value;
    return {
      kind: 'backend',
      backendId: parsed.data.backendId,
    };
  },
  z.object({
    kind: z.literal('backend'),
    backendId: z.string().trim().min(1).max(200),
  }).strict(),
);

/**
 * Bounded facts required to faithfully project a marker-backed public run.
 * They remain optional for partial predecessor marker reads; such a marker is
 * deliberately not projected because the public-state schema requires all four.
 */
const DaemonExecutionRunMarkerPublicStateFieldsSchema = {
  permissionMode: z.string().trim().min(1).max(200).optional(),
  runClass: ExecutionRunClassSchema.optional(),
  ioMode: ExecutionRunIoModeSchema.optional(),
  retentionPolicy: ExecutionRunRetentionPolicySchema.optional(),
};

/**
 * Canonical on-disk marker shape. Marker files are observability/restart hints,
 * not a shadow execution request or runtime snapshot: keep only bounded run
 * identity, public policy/class, status, timing, size, and error-code facts.
 */
const DaemonExecutionRunMarkerFieldsSchema = z.object({
  pid: z.number().int().positive(),
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // A run stays daemon-owned when detached; `null` makes the missing Session
  // association explicit instead of inventing a marker variant or placeholder.
  happySessionId: z.string().min(1).nullable(),

  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendTarget: DaemonExecutionRunMarkerBackendIdentitySchema,

  ...DaemonExecutionRunMarkerPublicStateFieldsSchema,

  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  lastActivityAtMs: z.number().int().nonnegative().optional(),

  errorCode: z.string().max(200).optional(),
  resultSizeBytes: z.number().int().nonnegative().max(EXECUTION_RUN_MARKER_RESULT_SIZE_MAX_BYTES).optional(),
});

/**
 * Supported historical marker fields. Legacy identity, display, resume, and
 * launch facts exist only at this read boundary; the shared bounded public
 * policy/class fields above are canonical for new markers as well.
 */
const DaemonExecutionRunMarkerPersistenceReadFieldsSchema = z.object({
  happyHomeDir: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  happySessionId: z.string().min(1).nullable(),
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema),
  backendId: z.string().trim().min(1).max(200).optional(),
  configuredBackendId: z.string().trim().min(1).max(200).optional(),
  sourceKind: BackendTargetSourceKindV2Schema.optional(),
  display: ExecutionRunDisplaySchema.optional(),
  ...DaemonExecutionRunMarkerPublicStateFieldsSchema,
  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  lastActivityAtMs: z.number().int().nonnegative().optional(),
  errorCode: z.string().max(200).optional(),
  resultSizeBytes: z.number().int().nonnegative().max(EXECUTION_RUN_MARKER_RESULT_SIZE_MAX_BYTES).optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
});

const DaemonExecutionRunMarkerSchemaCore = DaemonExecutionRunMarkerFieldsSchema.strip().superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
});

/**
 * Read-only compatibility seam for predecessor marker bytes. New marker writes
 * always use DaemonExecutionRunMarkerSchema above, which strips this launch
 * configuration rather than making it a second persisted marker contract.
 */
const DaemonExecutionRunMarkerPersistenceReadSchemaCore = DaemonExecutionRunMarkerPersistenceReadFieldsSchema.extend({
  executionRunConnectedServicesLaunchV1: PersistedExecutionRunConnectedServicesLaunchV1Schema.optional(),
}).strip().superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
  if (value.executionRunConnectedServicesLaunchV1) {
    const normalized = normalizePersistedExecutionRunConnectedServicesLaunchV1(
      value.executionRunConnectedServicesLaunchV1,
    );
    if (
      !normalized
      || !isPersistedExecutionRunConnectedServicesLaunchIdentityExact({
        markerRunId: value.runId,
        normalized,
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution-run connected-services launch identity does not match its marker',
        path: ['executionRunConnectedServicesLaunchV1'],
      });
    }
  }
});
export const DaemonExecutionRunMarkerSchema = z.preprocess(
  (value) => {
    const normalized = normalizeLegacyExecutionRunBackendTargetInput(value);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
    return normalized;
  },
  DaemonExecutionRunMarkerSchemaCore,
);
export type DaemonExecutionRunMarker = z.infer<typeof DaemonExecutionRunMarkerSchema>;

export const DaemonExecutionRunMarkerPersistenceReadSchema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  DaemonExecutionRunMarkerPersistenceReadSchemaCore,
);
export type DaemonExecutionRunMarkerPersistenceRead = z.infer<
  typeof DaemonExecutionRunMarkerPersistenceReadSchema
>;

export const DaemonExecutionRunProcessInfoSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().optional(),
  cmd: z.string().optional(),
  cpu: z.number().optional(),
  memory: z.number().optional(),
}).passthrough();
export type DaemonExecutionRunProcessInfo = z.infer<typeof DaemonExecutionRunProcessInfoSchema>;

const DaemonExecutionRunEntrySchemaCore = DaemonExecutionRunMarkerSchemaCore.extend({
  process: DaemonExecutionRunProcessInfoSchema.optional(),
}).passthrough();
export const DaemonExecutionRunEntrySchema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  DaemonExecutionRunEntrySchemaCore,
);
export type DaemonExecutionRunEntry = z.infer<typeof DaemonExecutionRunEntrySchema>;

export const DaemonExecutionRunListRequestSchema = z.object({}).passthrough();
export type DaemonExecutionRunListRequest = z.infer<typeof DaemonExecutionRunListRequestSchema>;

export const DaemonExecutionRunListResponseSchema = z.object({
  runs: z.array(DaemonExecutionRunEntrySchema),
}).passthrough();
export type DaemonExecutionRunListResponse = z.infer<typeof DaemonExecutionRunListResponseSchema>;
