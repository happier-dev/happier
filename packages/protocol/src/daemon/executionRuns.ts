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

/**
 * Daemon-scoped execution run listing.
 *
 * This is a machine-wide view of execution runs discovered via a daemon-readable
 * file registry. It is intentionally best-effort and may contain stale entries
 * if session processes crash or the machine reboots.
 */

export const ExecutionRunConnectedServicesLaunchV1Schema = z.object({
  v: z.literal(1),
  activationId: z.string().uuid().optional(),
  runKey: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
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

const DaemonExecutionRunMarkerSchemaCore = z.object({
  // Safety/filtering: only accept markers for the current happyHomeDir.
  happyHomeDir: z.string().min(1),

  pid: z.number().int().positive(),
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  happySessionId: z.string().min(1),

  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema),
  display: ExecutionRunDisplaySchema.optional(),

  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  retentionPolicy: ExecutionRunRetentionPolicySchema,

  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  lastActivityAtMs: z.number().int().nonnegative().optional(),

  summary: z.string().max(20_000).optional(),
  errorCode: z.string().max(200).optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
  executionRunConnectedServicesLaunchV1: PersistedExecutionRunConnectedServicesLaunchV1Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
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
  normalizeLegacyExecutionRunBackendTargetInput,
  DaemonExecutionRunMarkerSchemaCore,
);
export type DaemonExecutionRunMarker = z.infer<typeof DaemonExecutionRunMarkerSchema>;

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
