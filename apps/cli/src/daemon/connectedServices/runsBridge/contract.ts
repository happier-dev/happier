import { z } from 'zod';
import { AGENT_IDS } from '@happier-dev/agents';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';
import { RuntimeAccountIdentitySelectionFactV1Schema } from '../quotas/identity/runtimeAccountIdentityTypes';
import { lazySchema } from '@happier-dev/protocol';

/**
 * Wire contract for the daemon run-materialization bridge. The runner POSTs here (DEDICATED scoped
 * run-materialize capability token, mirroring the broker-bridge least-privilege precedent) to obtain the CS env for an execution run. Only PATHS
 * (e.g. `CODEX_HOME`) cross the wire — never token/secret values (those live inside the materialized
 * home the daemon owns).
 */
export const EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH =
  '/connected-service-auth/execution-run/materialize';

export const ExecutionRunConnectedServiceMaterializeRequestSchema = lazySchema(() => z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1),
  pid: z.number().int().positive(),
  materializationKey: z.string().min(1),
  connectedServicesBindingsRaw: z.unknown(),
  sessionDirectory: z.string().nullable().optional(),
  previousMaterializedRoot: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
}));

export type ExecutionRunConnectedServiceMaterializeRequestWire =
  z.infer<typeof ExecutionRunConnectedServiceMaterializeRequestSchema>;

export const ExecutionRunConnectedServiceMaterializationProofV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  agentId: z.string().min(1),
  materializationKey: z.string().min(1),
  connectedServicesBindings: ConnectedServiceBindingsV1Schema,
}).strict());

export type ExecutionRunConnectedServiceMaterializationProofV1 =
  z.infer<typeof ExecutionRunConnectedServiceMaterializationProofV1Schema>;

export const ExecutionRunConnectedServiceRegistrationV1Schema =
  lazySchema(() => ExecutionRunConnectedServiceMaterializationProofV1Schema.extend({
    brokerSelectionIdentity: z.string().min(1).nullable(),
    runtimeAccountIdentitySelections: z.array(RuntimeAccountIdentitySelectionFactV1Schema).readonly(),
    connectedServiceSelectionsJson: z.string().min(1).nullable().optional(),
    sessionDirectory: z.string().min(1).nullable(),
    materializedRoot: z.string().min(1).nullable(),
  }).strict());
export type ExecutionRunConnectedServiceRegistrationV1 =
  z.infer<typeof ExecutionRunConnectedServiceRegistrationV1Schema>;

/** Persisted daemon-local launch identity. Fields are non-secret and old markers may omit selections. */
export const ExecutionRunConnectedServicesLaunchV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  runKey: z.string().min(1),
  agentId: z.enum(AGENT_IDS),
  connectedServicesBindings: ConnectedServiceBindingsV1Schema,
  brokerSelectionIdentity: z.string().min(1).nullable().optional(),
  runtimeAccountIdentitySelections: z.array(RuntimeAccountIdentitySelectionFactV1Schema).readonly().default([]),
  connectedServiceSelectionsJson: z.string().min(1).nullable().optional(),
  sessionDirectory: z.string().min(1).nullable().optional(),
  materializedRoot: z.string().min(1).nullable(),
}).strict());

export type ExecutionRunConnectedServicesLaunchV1 = z.infer<typeof ExecutionRunConnectedServicesLaunchV1Schema>;

export function buildExecutionRunConnectedServicesLaunchV1(
  registration: ExecutionRunConnectedServiceRegistrationV1,
): ExecutionRunConnectedServicesLaunchV1 {
  return ExecutionRunConnectedServicesLaunchV1Schema.parse({
    v: 1,
    runKey: registration.materializationKey,
    agentId: registration.agentId,
    connectedServicesBindings: registration.connectedServicesBindings,
    brokerSelectionIdentity: registration.brokerSelectionIdentity,
    runtimeAccountIdentitySelections: registration.runtimeAccountIdentitySelections,
    connectedServiceSelectionsJson: registration.connectedServiceSelectionsJson,
    sessionDirectory: registration.sessionDirectory,
    materializedRoot: registration.materializedRoot,
  });
}

export const ExecutionRunConnectedServiceMaterializedEnvSchema = lazySchema(() => z
  .record(z.string(), z.string())
  .refine(
    (env) => Object.values(env).some((value) => value.trim().length > 0),
    { message: 'Connected-service materialization must contain a non-empty environment value' },
  ));

export const ExecutionRunConnectedServiceMaterializeResponseSchema = lazySchema(() => z.object({
  env: ExecutionRunConnectedServiceMaterializedEnvSchema,
  proof: ExecutionRunConnectedServiceMaterializationProofV1Schema,
  registration: ExecutionRunConnectedServiceRegistrationV1Schema.optional(),
}).strict());

export type ExecutionRunConnectedServiceMaterializeResponseWire =
  z.infer<typeof ExecutionRunConnectedServiceMaterializeResponseSchema>;

/** Run-end lifecycle: unregister the run's runtime target + clean the run-scoped materialized root. */
export const EXECUTION_RUN_CONNECTED_SERVICE_RELEASE_PATH =
  '/connected-service-auth/execution-run/release';

export const ExecutionRunConnectedServiceReleaseRequestSchema = lazySchema(() => z.object({
  runId: z.string().min(1),
  pid: z.number().int().positive(),
  materializationKey: z.string().min(1),
}));

export type ExecutionRunConnectedServiceReleaseRequestWire =
  z.infer<typeof ExecutionRunConnectedServiceReleaseRequestSchema>;

export const ExecutionRunConnectedServiceReleaseResponseSchema = lazySchema(() => z.object({
  released: z.boolean(),
}));

export type ExecutionRunConnectedServiceReleaseResponseWire =
  z.infer<typeof ExecutionRunConnectedServiceReleaseResponseSchema>;
