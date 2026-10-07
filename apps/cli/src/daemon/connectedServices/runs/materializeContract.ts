import { z } from 'zod';

import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { ExecutionRunConnectedServicesLaunchV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import type { ExecutionRunConnectedServicesLaunchV1 } from '@happier-dev/protocol';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '../runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { ConnectedServiceRuntimeAuthRefreshSelectionSchema, ConnectedServiceRuntimeAuthRefreshServiceIdSchema } from '../runtimeAuthRefreshAuthorization';
import type { ConnectedServiceDaemonAuthBridgeRefreshResult } from '../daemonAuthBridgeTypes';

export const ExecutionRunConnectedServicesRegistrationV1Schema = ExecutionRunConnectedServicesLaunchV1Schema;
export type ExecutionRunConnectedServicesRegistrationV1 = ExecutionRunConnectedServicesLaunchV1;

/**
 * Runner → daemon bridge contract for execution-run connected-services materialization.
 *
 * Execution runs spawn their backend from INSIDE the runner process (no daemon spawn), so the
 * runner asks the daemon — the sole connected-services owner — to resolve + materialize the
 * selected auth for a RUN-scoped materialization key and register the run PID as a
 * runtime-registry target. The endpoints are guarded by the scoped run-materialize capability
 * token (see ./capabilityToken.ts), never the master control token.
 */
export const CONNECTED_SERVICE_RUN_MATERIALIZE_PATH = '/connected-service-run/materialize';
export const CONNECTED_SERVICE_RUN_RELEASE_PATH = '/connected-service-run/release';
export const CONNECTED_SERVICE_RUN_GENERATION_CURRENT_PATH = '/connected-service-run/generation-current';
export const CONNECTED_SERVICE_RUN_REJECTED_START_PATH = '/connected-service-run/rejected-start';
export const CONNECTED_SERVICE_RUN_REFRESH_RUNTIME_AUTH_PATH = '/connected-service-run/refresh-runtime-auth';

export const ConnectedServiceRunMaterializeRequestSchema = z.object({
    runId: z.string().trim().min(1),
    runnerPid: z.number().int().positive(),
    agentId: z.string().trim().min(1),
    connectedServices: ConnectedServiceBindingsV2IngressSchema,
    cwd: z.string().trim().min(1),
    modelId: z.string().trim().min(1).optional(),
});
export type ConnectedServiceRunMaterializeRequest = z.infer<typeof ConnectedServiceRunMaterializeRequestSchema>;

export const ConnectedServiceRunReleaseRequestSchema = z.object({
    runId: z.string().trim().min(1),
    runnerPid: z.number().int().positive(),
    activationId: z.string().uuid(),
});
export type ConnectedServiceRunReleaseRequest = z.infer<typeof ConnectedServiceRunReleaseRequestSchema>;

export const ConnectedServiceRunRuntimeAuthRefreshRequestSchema = ConnectedServiceRunReleaseRequestSchema.extend({
    serviceId: ConnectedServiceRuntimeAuthRefreshServiceIdSchema,
    refreshAttemptId: z.string().trim().min(1),
    selection: ConnectedServiceRuntimeAuthRefreshSelectionSchema,
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
    planType: z.string().trim().min(1).nullable().optional(),
    failingAccessTokenFingerprint: z.string().trim().min(1).nullable().optional(),
    reason: z.string().trim().min(1).nullable().optional(),
}).strict();
export type ConnectedServiceRunRuntimeAuthRefreshRequest = z.infer<typeof ConnectedServiceRunRuntimeAuthRefreshRequestSchema>;
export type ConnectedServiceRunRuntimeAuthRefreshHandler = (
    input: ConnectedServiceRunRuntimeAuthRefreshRequest,
) => Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>;
export const ConnectedServiceRunGenerationCurrentRequestSchema = z.object({
    runId: z.string().trim().min(1),
    runnerPid: z.number().int().positive(),
    registration: ExecutionRunConnectedServicesRegistrationV1Schema.optional(),
});
export type ConnectedServiceRunGenerationCurrentRequest = z.infer<
    typeof ConnectedServiceRunGenerationCurrentRequestSchema
>;

export const CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES = {
    unavailable: 'connected_service_run_materialization_unavailable',
    blocked: 'connected_service_run_materialization_blocked',
    stale: 'connected_service_run_activation_stale',
    modelUnavailable: 'connected_service_run_model_unavailable',
} as const;

export const ConnectedServiceRunRejectedStartRequestSchema = z.object({
    runId: z.string().trim().min(1),
    runnerPid: z.number().int().positive(),
    activationId: z.string().uuid(),
    modelId: z.string().trim().min(1),
    classification: z.unknown().transform((value, ctx) => {
        const classification = sanitizeConnectedServiceRuntimeFailureClassification(value);
        if (!classification) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid connected service classification' });
            return z.NEVER;
        }
        return classification;
    }),
}).strict();
export type ConnectedServiceRunRejectedStartRequest = z.infer<typeof ConnectedServiceRunRejectedStartRequestSchema>;
export const ConnectedServiceRunRejectedStartResultSchema = z.union([
    z.object({ ok: z.literal(true), retry: z.literal(true) }).strict(),
    z.object({
        ok: z.literal(false),
        errorCode: z.enum([
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.unavailable,
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.blocked,
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.stale,
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.modelUnavailable,
        ]),
        modelId: z.string().optional(),
        errorMessage: z.string().optional(),
    }).strict(),
]);
export type ConnectedServiceRunRejectedStartResult = z.infer<typeof ConnectedServiceRunRejectedStartResultSchema>;
export type ConnectedServiceRunRejectedStartHandler = (
    input: ConnectedServiceRunRejectedStartRequest,
) => Promise<ConnectedServiceRunRejectedStartResult>;

export type ConnectedServiceRunMaterializationHandlerResult =
    | Readonly<{
        ok: true;
        activationId: string;
        env: Readonly<Record<string, string>>;
        connectedServicesBindings: unknown;
        registration: ExecutionRunConnectedServicesRegistrationV1;
    }>
    | Readonly<{
        ok: false;
        errorCode: typeof CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.blocked | typeof CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.modelUnavailable;
        modelId?: string;
        errorMessage?: string;
    }>;

export type ConnectedServiceRunMaterializationHandler = (
    input: ConnectedServiceRunMaterializeRequest,
) => Promise<ConnectedServiceRunMaterializationHandlerResult>;

export type ConnectedServiceRunReleaseHandler = (
    input: ConnectedServiceRunReleaseRequest,
) => Promise<Readonly<{ ok: true; released: boolean }>>;

export type ConnectedServiceRunGenerationCurrentHandler = (
    input: ConnectedServiceRunGenerationCurrentRequest,
) => Promise<Readonly<{ ok: true; current: boolean }>>;
