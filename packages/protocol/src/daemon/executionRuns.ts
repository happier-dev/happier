import { z } from 'zod';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { RequesterWorkAttributionV1Schema } from '../machines/requesterWorkAttributionV1.js';

import { ExecutionRunClassSchema, ExecutionRunIntentSchema, ExecutionRunIoModeSchema, ExecutionRunRetentionPolicySchema } from '../execution/runs/runPrimitives.js';
import { ExecutionRunDisplaySchema, ExecutionRunLaunchOriginSchema, normalizeLegacyExecutionRunBackendTargetInput, ExecutionRunResumeHandleSchema } from '../execution/runs/startRequest.js';
import { ExecutionRunRequestedConfigurationSchema } from '../execution/runs/requestedConfiguration.js';
import { ExecutionRunStatusSchema } from '../execution/runs/responseSchemas.js';
import {
  BackendTargetRefV2Schema,
  BackendTargetSourceKindV2Schema,
  normalizeBackendTargetRefV2InputToV2,
} from '../backends/targets/backendTargetRefV2.js';
import { hasLegacyCustomAcpConcreteBackendId } from '../backends/targets/compat/customAcp.js';
import { MAX_AGENT_ROUTING_ID_BYTES } from '../agents/agentIdV1.js';
import {
  BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
  ConnectedAccountServiceKeyIngressSchema,
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceBindingsV2IngressSchema,
  ConnectedServiceBindingsV2Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../connect/connectedServiceBindings.js';
import {
  ConnectedServiceAuthGroupPolicyV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
} from '../connect/connectedServiceSchemas.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '../runtime/agentSessionLimitsV1.js';
import { TeamCredentialDirectMaterialUseV1Schema } from '../teams/credentials/directMaterialV1.js';
import { TeamCredentialRouteV1Schema } from '../teams/credentials/resourceV1.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';

/**
 * The Run owner's own accepted provider-model selection, attested with its
 * currentness: the Home authorizes a Run's broker operation on it, never on
 * the resource an open names (`teams-lane-10/PLAN.md` §2.3). Null when the Run
 * selected nothing and so inherits its parent Session's selection.
 */
const ExecutionRunTeamCredentialProviderModelAttestationV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().trim().min(1).max(512),
  deliveryMode: TeamCredentialRouteV1Schema,
}).strict().nullable());

const EXECUTION_RUN_MARKER_RESULT_SIZE_MAX_BYTES =
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates.sendRequestMaxJsonBytes;

export const DaemonExecutionRunBrokerAuthorityRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  requestNonce: z.string().uuid(),
  serverIdentityId: z.string().trim().min(1).max(256),
  requestingAccountId: z.string().trim().min(1).max(256),
  workerMachineId: z.string().trim().min(1).max(256),
  executionRunId: z.string().trim().min(1).max(512),
  expectedIntent: ExecutionRunIntentSchema.optional(),
  expectedOccurrenceId: z.string().trim().min(1).max(512).nullable(),
  expectedDirectMaterialUse: TeamCredentialDirectMaterialUseV1Schema.optional(),
}).strict());
export type DaemonExecutionRunBrokerAuthorityRequestV1 = z.infer<
  typeof DaemonExecutionRunBrokerAuthorityRequestV1Schema
>;

export const DaemonExecutionRunBrokerAuthorityResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({
    status: z.literal('current'),
    requestNonce: z.string().uuid(),
    serverIdentityId: z.string().trim().min(1).max(256),
    requestingAccountId: z.string().trim().min(1).max(256),
    workerMachineId: z.string().trim().min(1).max(256),
    executionRunId: z.string().trim().min(1).max(512),
    occurrenceId: z.string().trim().min(1).max(512),
    parentSessionId: z.string().trim().min(1).max(512).nullable(),
    intent: ExecutionRunIntentSchema,
    runtimeState: z.enum(['active_turn', 'idle']),
    activeTurnId: z.string().trim().min(1).max(512).nullable().optional(),
    teamCredentialProviderModel: ExecutionRunTeamCredentialProviderModelAttestationV1Schema,
  }).strict(),
  z.object({
    status: z.literal('not_current'),
    requestNonce: z.string().uuid(),
    reason: z.enum(['identity_mismatch', 'not_found', 'terminal', 'detached', 'occurrence_mismatch', 'runtime_unavailable']),
  }).strict(),
]));
export type DaemonExecutionRunBrokerAuthorityResponseV1 = z.infer<
  typeof DaemonExecutionRunBrokerAuthorityResponseV1Schema
>;

/**
 * Host-private request from the daemon into the exact live Session runtime.
 * Persisted execution-run markers are intentionally absent: they locate the
 * Session process but never decide occurrence or turn authority.
 */
export const SessionExecutionRunBrokerAuthorityRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  executionRunId: z.string().trim().min(1).max(512),
  expectedIntent: ExecutionRunIntentSchema.optional(),
  expectedOccurrenceId: z.string().trim().min(1).max(512).nullable(),
  expectedDirectMaterialUse: TeamCredentialDirectMaterialUseV1Schema.optional(),
}).strict());
export type SessionExecutionRunBrokerAuthorityRequestV1 = z.infer<
  typeof SessionExecutionRunBrokerAuthorityRequestV1Schema
>;

export const SessionExecutionRunBrokerAuthorityResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({
    status: z.literal('current'),
    executionRunId: z.string().trim().min(1).max(512),
    occurrenceId: z.string().trim().min(1).max(512),
    parentSessionId: z.string().trim().min(1).max(512).nullable(),
    intent: ExecutionRunIntentSchema,
    runtimeState: z.enum(['active_turn', 'idle']),
    activeTurnId: z.string().trim().min(1).max(512).nullable().optional(),
    teamCredentialProviderModel: ExecutionRunTeamCredentialProviderModelAttestationV1Schema,
  }).strict(),
  z.object({
    status: z.literal('not_current'),
    reason: z.enum(['identity_mismatch', 'not_found', 'terminal', 'detached', 'occurrence_mismatch', 'runtime_unavailable']),
  }).strict(),
]));
export type SessionExecutionRunBrokerAuthorityResponseV1 = z.infer<
  typeof SessionExecutionRunBrokerAuthorityResponseV1Schema
>;

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
 * exact contribution identity plus its durable source custody lets adoption demand correspondence
 * instead of trusting run/PID liveness as source proof.
 */
export const ExecutionRunAgentContributionIdentityV1Schema = lazyZodSchema(() => z.object({
  pluginId: z.string().trim().min(1).max(256),
  localId: z.string().trim().min(1).max(256),
  sourceCustody: PluginSourceCustodyV1Schema,
}).strict());
export type ExecutionRunAgentContributionIdentityV1 = z.infer<
  typeof ExecutionRunAgentContributionIdentityV1Schema
>;

export const ExecutionRunConnectedServicesLaunchV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  activationId: z.string().uuid().optional(),
  runKey: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  /**
   * Absent only for a record whose writer could not prove the Agent source custody. Adoption treats
   * that as unproven and refuses, rather than upgrading it into fresh request-auth authority.
   */
  agentContribution: ExecutionRunAgentContributionIdentityV1Schema.optional(),
  materializationKey: z.string().trim().min(1),
  connectedServicesBindings: ConnectedServiceBindingsV2Schema,
  connectedServiceSelectionsEnv: z.record(z.string(), z.string()),
  sessionDirectory: z.string().trim().min(1).nullable(),
  materializedRoot: z.string().trim().min(1).nullable(),
}).strict());
export type ExecutionRunConnectedServicesLaunchV1 = z.infer<typeof ExecutionRunConnectedServicesLaunchV1Schema>;

/**
 * Privacy-bounded terminal cleanup custody. It grants no purpose, request-auth,
 * run-target, or replay authority; the daemon can only derive the exact
 * materialized root already owned by this run key and Agent.
 */
export const ExecutionRunConnectedServicesCleanupReceiptV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  activationId: z.string().uuid(),
  runKey: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
}).strict());
export type ExecutionRunConnectedServicesCleanupReceiptV1 = z.infer<
  typeof ExecutionRunConnectedServicesCleanupReceiptV1Schema
>;

const PersistedConnectedServiceChildSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('profile'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    profileId: ConnectedServiceProfileIdSchema,
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('group'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    activeProfileId: ConnectedServiceProfileIdSchema,
    fallbackProfileId: ConnectedServiceProfileIdSchema,
    generation: z.number().int().nonnegative(),
    policy: ConnectedServiceAuthGroupPolicyV1Schema,
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema.optional(),
  }).strict(),
]));

const PersistedConnectedServiceSelectionsJsonSchema = lazyZodSchema(() => z.string().trim().min(1).transform((raw, ctx) => {
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
}));

const PERSISTED_CONNECTED_SERVICE_SELECTIONS_ENV_KEY =
  'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';
const PERSISTED_SELECTION_IDENTITY_ENV_KEY_PATTERN =
  /^[A-Z][A-Z0-9_]*CONNECTED_SERVICE_SELECTION_IDENTITY$/;
const PERSISTED_SELECTION_IDENTITY_VALUE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/|+=-]{0,511}$/;
const SECRET_BEARING_IDENTITY_VALUE_PATTERN =
  /^(?:bearer[ :]|sk-|gh[opusr]_|github_pat_|xox[baprs]-|ya29[.-])/i;

const PersistedConnectedServiceSelectionsEnvSchema = lazyZodSchema(() => z.record(
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
}));

const PersistedCurrentExecutionRunConnectedServicesLaunchV1Schema =
  lazyZodSchema(() => ExecutionRunConnectedServicesLaunchV1Schema.extend({
    connectedServicesBindings: ConnectedServiceBindingsV2Schema,
    connectedServiceSelectionsEnv: PersistedConnectedServiceSelectionsEnvSchema,
  }).strict());

/**
 * Released/predecessor markers used bundled scalar Connected Account service
 * ids. Keep that spelling at this persistence ingress only and immediately
 * normalize it through the canonical Connected Account compatibility owner.
 */
const PersistedLegacyExecutionRunConnectedServicesLaunchV1Schema =
  lazyZodSchema(() => ExecutionRunConnectedServicesLaunchV1Schema.extend({
    connectedServicesBindings: BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
    connectedServiceSelectionsEnv: PersistedConnectedServiceSelectionsEnvSchema,
  }).strict());

const RemoteDevRuntimeAccountIdentitySelectionFactV1Schema = lazyZodSchema(() => z.object({
  serviceId: ConnectedServiceIdSchema,
  profileId: z.string().trim().min(1),
  groupId: z.string().trim().min(1).nullable(),
  groupGeneration: z.number().int().nonnegative().nullable(),
  providerAccountId: z.string().trim().min(1),
  accountLabel: z.string().trim().min(1).nullable(),
  source: z.enum(['spawn_selection', 'group_switch_selection', 'codex_live_auth_apply']),
}).strict());

/**
 * Exact non-secret launch fact written by the moving remote-dev predecessor.
 *
 * This is a persisted-marker compatibility seam only. The current materialization
 * request/response contract remains ExecutionRunConnectedServicesLaunchV1Schema.
 */
export const RemoteDevExecutionRunConnectedServicesLaunchV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  runKey: z.string().regex(
    /^execution_run:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
  agentId: z.string().trim().min(1),
  connectedServicesBindings: BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
  brokerSelectionIdentity: z.string().trim().min(1).nullable().optional(),
  runtimeAccountIdentitySelections: z.array(
    RemoteDevRuntimeAccountIdentitySelectionFactV1Schema,
  ).readonly().default([]),
  connectedServiceSelectionsJson: PersistedConnectedServiceSelectionsJsonSchema.nullable().optional(),
  sessionDirectory: z.string().trim().min(1).nullable().optional(),
  materializedRoot: z.string().trim().min(1).nullable(),
}).strict());
export type RemoteDevExecutionRunConnectedServicesLaunchV1 = z.infer<
  typeof RemoteDevExecutionRunConnectedServicesLaunchV1Schema
>;

export const PersistedExecutionRunConnectedServicesLaunchV1Schema = lazyZodSchema(() => z.union([
  PersistedCurrentExecutionRunConnectedServicesLaunchV1Schema,
  RemoteDevExecutionRunConnectedServicesLaunchV1Schema,
  PersistedLegacyExecutionRunConnectedServicesLaunchV1Schema,
]));
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
  const legacyCurrent = PersistedLegacyExecutionRunConnectedServicesLaunchV1Schema.safeParse(value);
  if (legacyCurrent.success) {
    return {
      source: 'current',
      registration: {
        ...legacyCurrent.data,
        connectedServicesBindings: ConnectedServiceBindingsV2IngressSchema.parse(
          legacyCurrent.data.connectedServicesBindings,
        ),
      },
    };
  }
  const predecessor = RemoteDevExecutionRunConnectedServicesLaunchV1Schema.safeParse(value);
  if (!predecessor.success) return null;
  return {
    source: 'remote_dev_predecessor',
    registration: {
      v: 1,
      runKey: predecessor.data.runKey,
      agentId: predecessor.data.agentId,
      materializationKey: predecessor.data.runKey,
      connectedServicesBindings: ConnectedServiceBindingsV2IngressSchema.parse(
        predecessor.data.connectedServicesBindings,
      ),
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

const DaemonExecutionRunMarkerBackendIdentitySchema = lazyZodSchema(() => z.preprocess(
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
    // The marker carries the host Agent routing id, so its bound is the
    // canonical Agent-id wire contract, not the bounded diagnostic-string
    // length used for `permissionMode`/`errorCode` below.
    backendId: z.string().trim().min(1).max(MAX_AGENT_ROUTING_ID_BYTES),
  }).strict(),
));

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
  notifyParentOnCompletion: z.boolean().optional(),
};

/**
 * Canonical on-disk marker shape. Marker files are observability/restart hints,
 * not a shadow execution request or runtime snapshot: keep only bounded run
 * identity, public policy/class, status, timing, size, and error-code facts.
 */
const DaemonExecutionRunMarkerFieldsSchema = lazyZodSchema(() => z.object({
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
  launchOrigin: ExecutionRunLaunchOriginSchema.optional(),
  requestedConfiguration: ExecutionRunRequestedConfigurationSchema.optional(),

  ...DaemonExecutionRunMarkerPublicStateFieldsSchema,

  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  lastActivityAtMs: z.number().int().nonnegative().optional(),

  errorCode: z.string().max(200).optional(),
  resultSizeBytes: z.number().int().nonnegative().max(EXECUTION_RUN_MARKER_RESULT_SIZE_MAX_BYTES).optional(),
}));

/**
 * Supported historical marker fields. Legacy identity, display, resume, and
 * launch facts exist only at this read boundary; the shared bounded public
 * policy/class fields above are canonical for new markers as well.
 */
const DaemonExecutionRunMarkerPersistenceReadFieldsSchema = lazyZodSchema(() => z.object({
  happyHomeDir: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  happySessionId: z.string().min(1).nullable(),
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema),
  backendId: z.string().trim().min(1).max(MAX_AGENT_ROUTING_ID_BYTES).optional(),
  configuredBackendId: z.string().trim().min(1).max(200).optional(),
  sourceKind: BackendTargetSourceKindV2Schema.optional(),
  display: ExecutionRunDisplaySchema.optional(),
  launchOrigin: ExecutionRunLaunchOriginSchema.optional(),
  requestedConfiguration: ExecutionRunRequestedConfigurationSchema.optional(),
  ...DaemonExecutionRunMarkerPublicStateFieldsSchema,
  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  lastActivityAtMs: z.number().int().nonnegative().optional(),
  errorCode: z.string().max(200).optional(),
  resultSizeBytes: z.number().int().nonnegative().max(EXECUTION_RUN_MARKER_RESULT_SIZE_MAX_BYTES).optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
}));

const DaemonExecutionRunMarkerSchemaCore = lazyZodSchema(() => DaemonExecutionRunMarkerFieldsSchema.strip().superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
}));

export const DaemonExecutionRunMarkerOwnerWriteSchema =
  lazyZodSchema(() => DaemonExecutionRunMarkerFieldsSchema.extend({
    requesterWorkAttributionV1: RequesterWorkAttributionV1Schema.optional(),
    executionRunConnectedServicesCleanupReceiptV1:
      ExecutionRunConnectedServicesCleanupReceiptV1Schema.optional(),
  }).strip().superRefine((value, ctx) => {
    if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backendTarget must identify a concrete backend',
        path: ['backendTarget'],
      });
    }
    if (
      value.executionRunConnectedServicesCleanupReceiptV1
      && value.executionRunConnectedServicesCleanupReceiptV1.runKey !== value.runId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution-run cleanup receipt must match its marker run id',
        path: ['executionRunConnectedServicesCleanupReceiptV1', 'runKey'],
      });
    }
  }));
export type DaemonExecutionRunMarkerOwnerWrite = z.infer<
  typeof DaemonExecutionRunMarkerOwnerWriteSchema
>;

/**
 * Read-only compatibility seam for predecessor marker bytes. New marker writes
 * always use DaemonExecutionRunMarkerOwnerWriteSchema above, which strips this launch
 * configuration rather than making it a second persisted marker contract.
 */
const DaemonExecutionRunMarkerPersistenceReadSchemaCore = lazyZodSchema(() => DaemonExecutionRunMarkerPersistenceReadFieldsSchema.extend({
  requesterWorkAttributionV1: RequesterWorkAttributionV1Schema.optional(),
  executionRunBrokerAuthorityV1: z.object({
    occurrenceId: z.string().trim().min(1).max(512),
    turnState: z.enum(['active_turn', 'idle']),
  }).strict().optional(),
  executionRunConnectedServicesLaunchV1: PersistedExecutionRunConnectedServicesLaunchV1Schema.optional(),
  executionRunConnectedServicesCleanupReceiptV1:
    ExecutionRunConnectedServicesCleanupReceiptV1Schema.optional(),
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
  if (
    value.executionRunConnectedServicesCleanupReceiptV1
    && value.executionRunConnectedServicesCleanupReceiptV1.runKey !== value.runId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Execution-run cleanup receipt must match its marker run id',
      path: ['executionRunConnectedServicesCleanupReceiptV1', 'runKey'],
    });
  }
}));
export const DaemonExecutionRunMarkerSchema = lazyZodSchema(() => z.preprocess(
  (value) => {
    const normalized = normalizeLegacyExecutionRunBackendTargetInput(value);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
    return normalized;
  },
  DaemonExecutionRunMarkerSchemaCore,
));
export type DaemonExecutionRunMarker = z.infer<typeof DaemonExecutionRunMarkerSchema>;

export const DaemonExecutionRunMarkerPersistenceReadSchema = lazyZodSchema(() => z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  DaemonExecutionRunMarkerPersistenceReadSchemaCore,
));
export type DaemonExecutionRunMarkerPersistenceRead = z.infer<
  typeof DaemonExecutionRunMarkerPersistenceReadSchema
>;

export const DaemonExecutionRunProcessInfoSchema = lazyZodSchema(() => z.object({
  pid: z.number().int().positive(),
  name: z.string().optional(),
  cmd: z.string().optional(),
  cpu: z.number().optional(),
  memory: z.number().optional(),
}).passthrough());
export type DaemonExecutionRunProcessInfo = z.infer<typeof DaemonExecutionRunProcessInfoSchema>;

const DaemonExecutionRunEntrySchemaCore = lazyZodSchema(() => DaemonExecutionRunMarkerSchemaCore.extend({
  process: DaemonExecutionRunProcessInfoSchema.optional(),
}).passthrough());
export const DaemonExecutionRunEntrySchema = lazyZodSchema(() => z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  DaemonExecutionRunEntrySchemaCore,
));
export type DaemonExecutionRunEntry = z.infer<typeof DaemonExecutionRunEntrySchema>;

export const DaemonExecutionRunListRequestSchema = lazyZodSchema(() => z.object({}).passthrough());
export type DaemonExecutionRunListRequest = z.infer<typeof DaemonExecutionRunListRequestSchema>;

export const DaemonExecutionRunListResponseSchema = lazyZodSchema(() => z.object({
  runs: z.array(DaemonExecutionRunEntrySchema),
}).passthrough());
export type DaemonExecutionRunListResponse = z.infer<typeof DaemonExecutionRunListResponseSchema>;
