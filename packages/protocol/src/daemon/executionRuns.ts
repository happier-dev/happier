import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { z } from '../zodRuntimePolicy.js';

import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { RequesterWorkAttributionV1Schema } from '../machines/requesterWorkAttributionV1.js';

import { ExecutionRunClassSchema, ExecutionRunIntentSchema, ExecutionRunIoModeSchema, ExecutionRunRetentionPolicySchema } from '../execution/runs/runPrimitives.js';
import { ExecutionRunDisplaySchema, ExecutionRunLaunchOriginSchema, normalizeLegacyExecutionRunBackendTargetInput, ExecutionRunResumeHandleSchema } from '../execution/runs/startRequest.js';
import { ExecutionRunRequestedConfigurationSchema, ExecutionRunResolvedSelectionSchema } from '../execution/runs/requestedConfiguration.js';
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
  ConnectedServiceAuthGroupPolicyV2Schema,
  ConnectedServiceCredentialRevisionV1Schema,
} from '../connect/connectedServiceSchemas.js';
import { TeamCredentialDirectMaterialUseV1Schema } from '../teams/credentials/directMaterialUseV1.js';
import { TeamCredentialRouteV1Schema } from '../teams/credentials/resourceV1.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderModelIdSchema } from '../providers/ids.js';
import { ApprovalProfileIdV1Schema } from '../actions/approvalProfiles.js';

/**
 * The Run owner's own accepted provider-model selection, attested with its
 * currentness: the Home authorizes a Run's broker operation on it, never on
 * the resource an open names (`teams-lane-10/PLAN.md` §2.3). Null when the Run
 * selected nothing and so inherits its parent Session's selection.
 */
const ExecutionRunTeamCredentialProviderModelAttestationV1Schema = lazyZodSchema(() => z.nullable(z.strictObject({
  resourceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  deliveryMode: TeamCredentialRouteV1Schema,
})));

export const DaemonExecutionRunBrokerAuthorityRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  requestNonce: z.string().check(z.uuid()),
  serverIdentityId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  requestingAccountId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  workerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  executionRunId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  expectedIntent: z.optional(ExecutionRunIntentSchema),
  expectedOccurrenceId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  expectedDirectMaterialUse: z.optional(TeamCredentialDirectMaterialUseV1Schema),
}));
export type DaemonExecutionRunBrokerAuthorityRequestV1 = z.infer<
  typeof DaemonExecutionRunBrokerAuthorityRequestV1Schema
>;

export const DaemonExecutionRunBrokerAuthorityResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('current'),
    requestNonce: z.string().check(z.uuid()),
    serverIdentityId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    requestingAccountId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    workerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    executionRunId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    occurrenceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    parentSessionId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    intent: ExecutionRunIntentSchema,
    runtimeState: z.enum(['active_turn', 'idle']),
    activeTurnId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512)))),
    teamCredentialProviderModel: ExecutionRunTeamCredentialProviderModelAttestationV1Schema,
  }),
  z.strictObject({
    status: z.literal('not_current'),
    requestNonce: z.string().check(z.uuid()),
    reason: z.enum(['identity_mismatch', 'not_found', 'terminal', 'detached', 'occurrence_mismatch', 'runtime_unavailable']),
  }),
]));
export type DaemonExecutionRunBrokerAuthorityResponseV1 = z.infer<
  typeof DaemonExecutionRunBrokerAuthorityResponseV1Schema
>;

/**
 * Host-private request from the daemon into the exact live Session runtime.
 * Persisted execution-run markers are intentionally absent: they locate the
 * Session process but never decide occurrence or turn authority.
 */
export const SessionExecutionRunBrokerAuthorityRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  executionRunId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  expectedIntent: z.optional(ExecutionRunIntentSchema),
  expectedOccurrenceId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  expectedDirectMaterialUse: z.optional(TeamCredentialDirectMaterialUseV1Schema),
  expectedProviderConnectionModel: z.optional(z.strictObject({
    agentId: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_AGENT_ROUTING_ID_BYTES)),
    agentTargetKey: ProviderAgentTargetKeySchema,
    providerConnectionId: ProviderConnectionIdSchema,
    modelId: ProviderModelIdSchema,
  })),
}));
export type SessionExecutionRunBrokerAuthorityRequestV1 = z.infer<
  typeof SessionExecutionRunBrokerAuthorityRequestV1Schema
>;

export const SessionExecutionRunBrokerAuthorityResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('current'),
    executionRunId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    occurrenceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    parentSessionId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    intent: ExecutionRunIntentSchema,
    runtimeState: z.enum(['active_turn', 'idle']),
    activeTurnId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512)))),
    teamCredentialProviderModel: ExecutionRunTeamCredentialProviderModelAttestationV1Schema,
  }),
  z.strictObject({
    status: z.literal('not_current'),
    reason: z.enum(['identity_mismatch', 'not_found', 'terminal', 'detached', 'occurrence_mismatch', 'runtime_unavailable']),
  }),
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
 * Historical metadata identifying the immutable Agent contribution at launch.
 * Restart adoption uses the current trusted contribution without requiring source correspondence.
 * Account/Team, selected credential and exact Run activation custody remain separate authorities.
 */
export const ExecutionRunAgentContributionIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  localId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  sourceCustody: PluginSourceCustodyV1Schema,
}));
export type ExecutionRunAgentContributionIdentityV1 = z.infer<
  typeof ExecutionRunAgentContributionIdentityV1Schema
>;

export const ExecutionRunConnectedServicesLaunchV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  activationId: z.optional(z.string().check(z.uuid())),
  runKey: z.string().check(z.trim(), z.minLength(1)),
  agentId: z.string().check(z.trim(), z.minLength(1)),
  /**
   * Retained for historical records; current launch writers omit it. Its presence or absence
   * does not authorize or refuse adoption.
   */
  agentContribution: z.optional(ExecutionRunAgentContributionIdentityV1Schema),
  materializationKey: z.string().check(z.trim(), z.minLength(1)),
  connectedServicesBindings: ConnectedServiceBindingsV2Schema,
  connectedServiceSelectionsEnv: z.record(z.string(), z.string()),
  sessionDirectory: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  materializedRoot: z.nullable(z.string().check(z.trim(), z.minLength(1))),
}));
export type ExecutionRunConnectedServicesLaunchV1 = z.infer<typeof ExecutionRunConnectedServicesLaunchV1Schema>;

/**
 * Privacy-bounded terminal cleanup custody. It grants no purpose, request-auth,
 * run-target, or replay authority; the daemon can only derive the exact
 * materialized root already owned by this run key and Agent.
 */
export const ExecutionRunConnectedServicesCleanupReceiptV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  activationId: z.string().check(z.uuid()),
  runKey: z.string().check(z.trim(), z.minLength(1)),
  agentId: z.string().check(z.trim(), z.minLength(1)),
}));
export type ExecutionRunConnectedServicesCleanupReceiptV1 = z.infer<
  typeof ExecutionRunConnectedServicesCleanupReceiptV1Schema
>;

const PersistedConnectedServiceChildSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('profile'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    profileId: ConnectedServiceProfileIdSchema,
    credentialRevision: z.optional(ConnectedServiceCredentialRevisionV1Schema),
  }),
  z.strictObject({
    kind: z.literal('group'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    activeProfileId: ConnectedServiceProfileIdSchema,
    fallbackProfileId: ConnectedServiceProfileIdSchema,
    generation: z.number().check(z.int(), z.nonnegative()),
    policy: ConnectedServiceAuthGroupPolicyV2Schema,
    credentialRevision: z.optional(ConnectedServiceCredentialRevisionV1Schema),
  }),
]));

function createPersistedConnectedServiceSelectionsJsonSchema(stored: boolean): z.ZodMiniType<string, string> {
  const selections = z.array(PersistedConnectedServiceChildSelectionV1Schema);
  const selectionsReader = stored ? createStoredReadSchema(selections) : selections;
  const schema = z.pipe(z.string().check(z.trim(), z.minLength(1)), z.transform((raw, ctx) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      ctx.issues.push({ code: "custom", message: 'Invalid connected service selections JSON', input: ctx.value });
      return z.NEVER;
    }
    const parsed = selectionsReader.safeParse(parsedJson);
    if (!parsed.success) {
      ctx.issues.push({ code: "custom", message: 'Invalid connected service selections', input: ctx.value });
      return z.NEVER;
    }
    const serviceIds = parsed.data.map((selection) => selection.serviceId);
    if (new Set(serviceIds).size !== serviceIds.length) {
      ctx.issues.push({ code: "custom", message: 'Duplicate connected service selection', input: ctx.value });
      return z.NEVER;
    }
    return JSON.stringify(parsed.data);
  }));
  // Nullable/optional compositions retain the concrete transform, so its
  // persistence projection belongs to that identity as well as the lazy facade.
  return stored ? schema : defineStoredReadProjection(schema,
    () => createPersistedConnectedServiceSelectionsJsonSchema(true));
}

const PersistedConnectedServiceSelectionsJsonSchema = defineStoredReadProjection(
  lazyZodSchema(() => createPersistedConnectedServiceSelectionsJsonSchema(false)),
  () => createPersistedConnectedServiceSelectionsJsonSchema(true),
);

const PERSISTED_CONNECTED_SERVICE_SELECTIONS_ENV_KEY =
  'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';
const PERSISTED_SELECTION_IDENTITY_ENV_KEY_PATTERN =
  /^[A-Z][A-Z0-9_]*CONNECTED_SERVICE_SELECTION_IDENTITY$/;
const PERSISTED_SELECTION_IDENTITY_VALUE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/|+=-]{0,511}$/;
const SECRET_BEARING_IDENTITY_VALUE_PATTERN =
  /^(?:bearer[ :]|sk-|gh[opusr]_|github_pat_|xox[baprs]-|ya29[.-])/i;

function createPersistedConnectedServiceSelectionsEnvSchema(stored: boolean) {
  const selectionsReader = stored ? createStoredReadSchema(PersistedConnectedServiceSelectionsJsonSchema)
    : PersistedConnectedServiceSelectionsJsonSchema;
  return z.pipe(z.record(z.string(), z.string()), z.transform((env, ctx) => {
    const normalized: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(env)) {
      if (key === PERSISTED_CONNECTED_SERVICE_SELECTIONS_ENV_KEY) {
        const parsed = selectionsReader.safeParse(rawValue);
        if (!parsed.success) {
          ctx.issues.push({ code: "custom", message: 'Invalid persisted connected service selections', input: ctx.value });
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
        ctx.issues.push({ code: "custom", message: 'Invalid persisted selection identity environment', input: ctx.value });
        return z.NEVER;
      }
      normalized[key] = value;
    }
    return normalized;
  }));
}

const PersistedConnectedServiceSelectionsEnvSchema = defineStoredReadProjection(
  lazyZodSchema(() => createPersistedConnectedServiceSelectionsEnvSchema(false)),
  () => createPersistedConnectedServiceSelectionsEnvSchema(true),
);

const PersistedCurrentExecutionRunConnectedServicesLaunchV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExecutionRunConnectedServicesLaunchV1Schema, {
    connectedServicesBindings: ConnectedServiceBindingsV2Schema,
    connectedServiceSelectionsEnv: PersistedConnectedServiceSelectionsEnvSchema,
  })));

/**
 * Released/predecessor markers used bundled scalar Connected Account service
 * ids. Keep that spelling at this persistence ingress only and immediately
 * normalize it through the canonical Connected Account compatibility owner.
 */
const PersistedLegacyExecutionRunConnectedServicesLaunchV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExecutionRunConnectedServicesLaunchV1Schema, {
    connectedServicesBindings: BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
    connectedServiceSelectionsEnv: PersistedConnectedServiceSelectionsEnvSchema,
  })));

const RemoteDevRuntimeAccountIdentitySelectionFactV1Schema = lazyZodSchema(() => z.strictObject({
  serviceId: ConnectedServiceIdSchema,
  profileId: z.string().check(z.trim(), z.minLength(1)),
  groupId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  groupGeneration: z.nullable(z.number().check(z.int(), z.nonnegative())),
  providerAccountId: z.string().check(z.trim(), z.minLength(1)),
  accountLabel: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  source: z.enum(['spawn_selection', 'group_switch_selection', 'codex_live_auth_apply']),
}));

/**
 * Exact non-secret launch fact written by the moving remote-dev predecessor.
 *
 * This is a persisted-marker compatibility seam only. The current materialization
 * request/response contract remains ExecutionRunConnectedServicesLaunchV1Schema.
 */
export const RemoteDevExecutionRunConnectedServicesLaunchV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  runKey: z.string().check(z.regex(/^execution_run:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)),
  agentId: z.string().check(z.trim(), z.minLength(1)),
  connectedServicesBindings: BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
  brokerSelectionIdentity: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  runtimeAccountIdentitySelections: z._default(z.readonly(z.array(
    RemoteDevRuntimeAccountIdentitySelectionFactV1Schema,
  )), []),
  connectedServiceSelectionsJson: z.optional(z.nullable(PersistedConnectedServiceSelectionsJsonSchema)),
  sessionDirectory: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  materializedRoot: z.nullable(z.string().check(z.trim(), z.minLength(1))),
}));
export type RemoteDevExecutionRunConnectedServicesLaunchV1 = z.infer<
  typeof RemoteDevExecutionRunConnectedServicesLaunchV1Schema
>;

export const PersistedExecutionRunConnectedServicesLaunchV1Schema = defineStoredReadProjection(lazyZodSchema(() => z.union([
  PersistedCurrentExecutionRunConnectedServicesLaunchV1Schema,
  RemoteDevExecutionRunConnectedServicesLaunchV1Schema,
  PersistedLegacyExecutionRunConnectedServicesLaunchV1Schema,
])), () => z.union([
  createStoredReadSchema(PersistedCurrentExecutionRunConnectedServicesLaunchV1Schema),
  createStoredReadSchema(PersistedLegacyExecutionRunConnectedServicesLaunchV1Schema),
  (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
    // A malformed current fact must not downgrade into the predecessor shape
    // when its current-only fields would otherwise be dropped on stored read.
    if (value && typeof value === 'object' && !Array.isArray(value)
      && (Object.hasOwn(value, 'materializationKey') || Object.hasOwn(value, 'connectedServiceSelectionsEnv'))) return null;
    return value;
  }), createStoredReadSchema(RemoteDevExecutionRunConnectedServicesLaunchV1Schema)),
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
  const parsed = createStoredReadSchema(PersistedExecutionRunConnectedServicesLaunchV1Schema).safeParse(value);
  if (!parsed.success) return null;
  const launch = parsed.data;
  if ('materializationKey' in launch) {
    return {
      source: 'current',
      registration: {
        ...launch,
        connectedServicesBindings: ConnectedServiceBindingsV2IngressSchema.parse(
          launch.connectedServicesBindings,
        ),
      },
    };
  }
  return {
    source: 'remote_dev_predecessor',
    registration: {
      v: 1,
      runKey: launch.runKey,
      agentId: launch.agentId,
      materializationKey: launch.runKey,
      connectedServicesBindings: ConnectedServiceBindingsV2IngressSchema.parse(
        launch.connectedServicesBindings,
      ),
      connectedServiceSelectionsEnv: launch.connectedServiceSelectionsJson
        ? { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: launch.connectedServiceSelectionsJson }
        : {},
      sessionDirectory: launch.sessionDirectory ?? null,
      materializedRoot: launch.materializedRoot,
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

const DaemonExecutionRunMarkerBackendIdentitySchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
    const parsed = BackendTargetRefV2Schema.safeParse(
      normalizeBackendTargetRefV2InputToV2(value),
    );
    if (!parsed.success) return value;
    return {
      kind: 'backend',
      backendId: parsed.data.backendId,
    };
  }), z.strictObject({
    kind: z.literal('backend'),
    // The marker carries the host Agent routing id, so its bound is the
    // canonical Agent-id wire contract, not the bounded diagnostic-string
    // length used for `permissionMode`/`errorCode` below.
    backendId: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_AGENT_ROUTING_ID_BYTES)),
  })));

/**
 * Bounded public run facts. The four policy/class fields remain optional for
 * predecessor marker reads; a full public-state projection requires all four.
 * Resolved selection is an optional presentation fact, never reconstructed from omissions.
 */
const DaemonExecutionRunMarkerPublicStateFieldsSchema = lazyDefinition(() => ({
  // Presentation-only echo of the host-admitted choice; never launch authority.
  resolvedSelection: z.optional(ExecutionRunResolvedSelectionSchema),
  permissionMode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(200))),
  approvalProfileId: z.optional(z.nullable(ApprovalProfileIdV1Schema)),
  runClass: z.optional(ExecutionRunClassSchema),
  ioMode: z.optional(ExecutionRunIoModeSchema),
  retentionPolicy: z.optional(ExecutionRunRetentionPolicySchema),
  notifyParentOnCompletion: z.optional(z.boolean()),
}));

/**
 * Canonical on-disk marker shape. Marker files are observability/restart hints,
 * not a shadow execution request or runtime snapshot: keep only bounded run
 * identity, public policy/class, safe selection, status, timing, size, and error-code facts.
 */
const DaemonExecutionRunMarkerFieldsSchema = lazyZodSchema(() => z.object({
  pid: z.number().check(z.int(), z.positive()),
  processCommandHash: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
  // A run stays daemon-owned when detached; `null` makes the missing Session
  // association explicit instead of inventing a marker variant or placeholder.
  happySessionId: z.nullable(z.string().check(z.minLength(1))),

  runId: z.string().check(z.minLength(1)),
  callId: z.string().check(z.minLength(1)),
  sidechainId: z.string().check(z.minLength(1)),
  intent: ExecutionRunIntentSchema,
  backendTarget: DaemonExecutionRunMarkerBackendIdentitySchema,
  launchOrigin: z.optional(ExecutionRunLaunchOriginSchema),
  requestedConfiguration: z.optional(ExecutionRunRequestedConfigurationSchema),

  ...DaemonExecutionRunMarkerPublicStateFieldsSchema,

  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().check(z.int(), z.nonnegative()),
  updatedAtMs: z.number().check(z.int(), z.nonnegative()),
  finishedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  lastActivityAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),

  errorCode: z.optional(z.string().check(z.maxLength(200))),
  resultSizeBytes: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

/**
 * Supported historical marker fields. Legacy identity, display, resume, and
 * launch facts exist only at this read boundary; the shared bounded public
 * policy/class fields above are canonical for new markers as well.
 */
const DaemonExecutionRunMarkerPersistenceReadFieldsSchema = lazyZodSchema(() => z.object({
  happyHomeDir: z.optional(z.string().check(z.minLength(1))),
  pid: z.number().check(z.int(), z.positive()),
  processCommandHash: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
  happySessionId: z.nullable(z.string().check(z.minLength(1))),
  runId: z.string().check(z.minLength(1)),
  callId: z.string().check(z.minLength(1)),
  sidechainId: z.string().check(z.minLength(1)),
  intent: ExecutionRunIntentSchema,
  backendTarget: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeBackendTargetRefV2InputToV2), BackendTargetRefV2Schema),
  backendId: z.optional(z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_AGENT_ROUTING_ID_BYTES))),
  configuredBackendId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(200))),
  sourceKind: z.optional(BackendTargetSourceKindV2Schema),
  display: z.optional(ExecutionRunDisplaySchema),
  launchOrigin: z.optional(ExecutionRunLaunchOriginSchema),
  requestedConfiguration: z.optional(ExecutionRunRequestedConfigurationSchema),
  ...DaemonExecutionRunMarkerPublicStateFieldsSchema,
  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().check(z.int(), z.nonnegative()),
  updatedAtMs: z.number().check(z.int(), z.nonnegative()),
  finishedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  lastActivityAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  errorCode: z.optional(z.string().check(z.maxLength(200))),
  resultSizeBytes: z.optional(z.number().check(z.int(), z.nonnegative())),
  resumeHandle: z.optional(z.nullable(ExecutionRunResumeHandleSchema)),
}));

const DaemonExecutionRunMarkerSchemaCore = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(DaemonExecutionRunMarkerFieldsSchema).check(z.superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: "custom",
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
})));

export const DaemonExecutionRunMarkerOwnerWriteSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(z.extend(DaemonExecutionRunMarkerFieldsSchema, {
    requesterWorkAttributionV1: z.optional(RequesterWorkAttributionV1Schema),
    executionRunConnectedServicesCleanupReceiptV1:
      z.optional(ExecutionRunConnectedServicesCleanupReceiptV1Schema),
  })).check(z.superRefine((value, ctx) => {
    if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
      ctx.addIssue({
        code: "custom",
        message: 'backendTarget must identify a concrete backend',
        path: ['backendTarget'],
      });
    }
    if (
      value.executionRunConnectedServicesCleanupReceiptV1
      && value.executionRunConnectedServicesCleanupReceiptV1.runKey !== value.runId
    ) {
      ctx.addIssue({
        code: "custom",
        message: 'Execution-run cleanup receipt must match its marker run id',
        path: ['executionRunConnectedServicesCleanupReceiptV1', 'runKey'],
      });
    }
  })));
export type DaemonExecutionRunMarkerOwnerWrite = z.infer<
  typeof DaemonExecutionRunMarkerOwnerWriteSchema
>;

/**
 * Read-only compatibility seam for predecessor marker bytes. New marker writes
 * always use DaemonExecutionRunMarkerOwnerWriteSchema above, which strips this launch
 * configuration rather than making it a second persisted marker contract.
 */
const DaemonExecutionRunMarkerPersistenceReadSchemaCore = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(z.extend(DaemonExecutionRunMarkerPersistenceReadFieldsSchema, {
  requesterWorkAttributionV1: z.optional(RequesterWorkAttributionV1Schema),
  executionRunBrokerAuthorityV1: z.optional(z.strictObject({
    occurrenceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    turnState: z.enum(['active_turn', 'idle']),
  })),
  executionRunConnectedServicesLaunchV1: z.optional(PersistedExecutionRunConnectedServicesLaunchV1Schema),
  executionRunConnectedServicesCleanupReceiptV1:
    z.optional(ExecutionRunConnectedServicesCleanupReceiptV1Schema),
})).check(z.superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: "custom",
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
        code: "custom",
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
      code: "custom",
      message: 'Execution-run cleanup receipt must match its marker run id',
      path: ['executionRunConnectedServicesCleanupReceiptV1', 'runKey'],
    });
  }
})));
export const DaemonExecutionRunMarkerSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
    const normalized = normalizeLegacyExecutionRunBackendTargetInput(value);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
    return normalized;
  }), DaemonExecutionRunMarkerSchemaCore));
export type DaemonExecutionRunMarker = z.infer<typeof DaemonExecutionRunMarkerSchema>;

export const DaemonExecutionRunMarkerPersistenceReadSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyExecutionRunBackendTargetInput), createStoredReadSchema(DaemonExecutionRunMarkerPersistenceReadSchemaCore)));
export type DaemonExecutionRunMarkerPersistenceRead = z.infer<
  typeof DaemonExecutionRunMarkerPersistenceReadSchema
>;

export const DaemonExecutionRunProcessInfoSchema = lazyZodSchema(() => z.looseObject({
  pid: z.number().check(z.int(), z.positive()),
  name: z.optional(z.string()),
  cmd: z.optional(z.string()),
  cpu: z.optional(z.number()),
  memory: z.optional(z.number()),
}));
export type DaemonExecutionRunProcessInfo = z.infer<typeof DaemonExecutionRunProcessInfoSchema>;

const DaemonExecutionRunEntrySchemaCore = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(DaemonExecutionRunMarkerSchemaCore, {
  process: z.optional(DaemonExecutionRunProcessInfoSchema),
})));
export const DaemonExecutionRunEntrySchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyExecutionRunBackendTargetInput), DaemonExecutionRunEntrySchemaCore));
export type DaemonExecutionRunEntry = z.infer<typeof DaemonExecutionRunEntrySchema>;

export const DaemonExecutionRunListRequestSchema = lazyZodSchema(() => z.looseObject({}));
export type DaemonExecutionRunListRequest = z.infer<typeof DaemonExecutionRunListRequestSchema>;

export const DaemonExecutionRunListResponseSchema = lazyZodSchema(() => z.looseObject({
  runs: z.array(DaemonExecutionRunEntrySchema),
}));
export type DaemonExecutionRunListResponse = z.infer<typeof DaemonExecutionRunListResponseSchema>;
