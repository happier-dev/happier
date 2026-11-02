import { z } from 'zod/mini';
import { ConnectedServiceUxDiagnosticV1Schema } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

import { ConnectedServiceBindingsV2IngressSchema, ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
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
export const CONNECTED_SERVICE_RUN_RECOVER_RUNTIME_FAILURE_PATH = '/connected-service-run/recover-runtime-failure';
export const CONNECTED_SERVICE_RUN_RUNTIME_TURN_COMPLETED_PATH = '/connected-service-run/runtime-turn-completed';
export const CONNECTED_SERVICE_APPLIED_PARENT_SELECTION_PATH = '/connected-service-run/applied-parent-selection';
export const ConnectedServiceAppliedParentSelectionRequestSchema = z.strictObject({
    sessionId: z.string().check(z.trim(), z.minLength(1)), runnerPid: z.number().check(z.int(), z.positive()), agentId: z.string().check(z.trim(), z.minLength(1)),
    /** Startup-only proof from the accepted native open, never a read-time fallback. */
    initialEmpty: z.optional(z.literal(true)),
});
export const ConnectedServiceAppliedParentSelectionResultSchema = z.union([
    z.strictObject({ status: z.literal('unavailable') }),
    z.strictObject({ status: z.literal('applied'), connectedServices: ConnectedServiceBindingsV2Schema }),
]);
export type ConnectedServiceAppliedParentSelectionReader = (
    input: z.infer<typeof ConnectedServiceAppliedParentSelectionRequestSchema>,
) => z.infer<typeof ConnectedServiceAppliedParentSelectionResultSchema> | Promise<z.infer<typeof ConnectedServiceAppliedParentSelectionResultSchema>>;
export type ConnectedServiceAppliedParentSelectionRequest = z.infer<typeof ConnectedServiceAppliedParentSelectionRequestSchema>;
export type ConnectedServiceAppliedParentSelectionResult = z.infer<typeof ConnectedServiceAppliedParentSelectionResultSchema>;

export const ConnectedServiceRunMaterializeRequestSchema = z.strictObject({
    activationId: z.string().check(z.uuid()),
    runId: z.string().check(z.trim(), z.minLength(1)),
    runnerPid: z.number().check(z.int(), z.positive()),
    agentId: z.string().check(z.trim(), z.minLength(1)),
    connectedServices: ConnectedServiceBindingsV2IngressSchema,
    cwd: z.string().check(z.trim(), z.minLength(1)),
    modelId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    /** Exact retained activation replacement; never a fresh launch or parent Session resume. */
    recovery: z.optional(z.strictObject({ activationId: z.string().check(z.uuid()), nativeResumeId: z.string().check(z.trim(), z.minLength(1)) })),
});
export type ConnectedServiceRunMaterializeRequest = z.infer<typeof ConnectedServiceRunMaterializeRequestSchema>;

export const ConnectedServiceRunMaterializeSuccessResponseSchema = z.strictObject({
    ok: z.literal(true),
    result: z.strictObject({
        activationId: z.string().check(z.uuid()),
        env: z.record(z.string(), z.string()),
        unsetEnvKeys: z.optional(z.array(z.string())),
        connectedServicesBindings: z.unknown(),
        registration: ExecutionRunConnectedServicesRegistrationV1Schema,
    }),
});

export const ConnectedServiceRunReleaseResultSchema = z.union([
    z.strictObject({ ok: z.literal(true), released: z.boolean() }),
    z.strictObject({ ok: z.literal(false), errorCode: z.enum([
        'connected_service_run_cleanup_failed', 'connected_service_run_cleanup_unavailable',
    ]) }),
]);

export const ConnectedServiceRunReleaseRequestSchema = z.object({
    runId: z.string().check(z.trim(), z.minLength(1)),
    runnerPid: z.number().check(z.int(), z.positive()),
    activationId: z.string().check(z.uuid()),
});
export type ConnectedServiceRunReleaseRequest = z.infer<typeof ConnectedServiceRunReleaseRequestSchema>;
export const ConnectedServiceRunRuntimeTurnCompletedRequestSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ConnectedServiceRunReleaseRequestSchema);
export const ConnectedServiceRunRuntimeTurnCompletedResultSchema = z.strictObject({ ok: z.literal(true), accepted: z.boolean() });
export type ConnectedServiceRunRuntimeTurnCompletedHandler = (input: ConnectedServiceRunReleaseRequest) => Promise<z.infer<typeof ConnectedServiceRunRuntimeTurnCompletedResultSchema>>;

export const ConnectedServiceRunRuntimeAuthRefreshRequestSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ConnectedServiceRunReleaseRequestSchema, {
    serviceId: ConnectedServiceRuntimeAuthRefreshServiceIdSchema,
    refreshAttemptId: z.string().check(z.trim(), z.minLength(1)),
    selection: ConnectedServiceRuntimeAuthRefreshSelectionSchema,
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
    planType: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    failingAccessTokenFingerprint: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    reason: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
}));
export type ConnectedServiceRunRuntimeAuthRefreshRequest = z.infer<typeof ConnectedServiceRunRuntimeAuthRefreshRequestSchema>;
export type ConnectedServiceRunRuntimeAuthRefreshHandler = (
    input: ConnectedServiceRunRuntimeAuthRefreshRequest,
) => Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>;

export const ConnectedServiceRunRuntimeFailureRecoveryRequestSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ConnectedServiceRunReleaseRequestSchema, {
    nativeResumeId: z.string().check(z.trim(), z.minLength(1)),
    interruptedOriginId: z.string().check(z.trim(), z.minLength(1)),
    classification: z.optional(z.pipe(z.unknown(), z.transform((value, ctx) => {
        const classification = sanitizeConnectedServiceRuntimeFailureClassification(value);
        if (!classification) {
            ctx.issues.push({ code: "custom", message: 'Invalid connected service classification', input: ctx.value });
            return z.NEVER;
        }
        return classification;
    }))),
    diagnostic: z.optional(z.unknown()),
})).check(z.refine((input) => input.classification !== undefined || input.diagnostic !== undefined));
export type ConnectedServiceRunRuntimeFailureRecoveryRequest = z.infer<typeof ConnectedServiceRunRuntimeFailureRecoveryRequestSchema>;
export const ConnectedServiceRunRuntimeFailureRecoveryResultSchema = z.union([
    z.strictObject({ status: z.literal('continue'), input: z.string().check(z.minLength(1)), rematerialize: z.boolean() }),
    z.strictObject({ status: z.literal('failed'), reason: z.optional(z.string()) }),
]);
export type ConnectedServiceRunRuntimeFailureRecoveryResult = z.infer<typeof ConnectedServiceRunRuntimeFailureRecoveryResultSchema>;
export type ConnectedServiceRunRuntimeFailureRecoveryHandler = (
    input: ConnectedServiceRunRuntimeFailureRecoveryRequest, signal: AbortSignal,
) => Promise<ConnectedServiceRunRuntimeFailureRecoveryResult>;
export const ConnectedServiceRunGenerationCurrentRequestSchema = z.object({
    runId: z.string().check(z.trim(), z.minLength(1)),
    runnerPid: z.number().check(z.int(), z.positive()),
    registration: z.optional(ExecutionRunConnectedServicesRegistrationV1Schema),
});
export type ConnectedServiceRunGenerationCurrentRequest = z.infer<
    typeof ConnectedServiceRunGenerationCurrentRequestSchema
>;

export const CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES = {
    unavailable: 'connected_service_run_materialization_unavailable',
    blocked: 'connected_service_run_materialization_blocked',
    stale: 'connected_service_run_activation_stale',
    modelUnavailable: 'connected_service_run_model_unavailable',
    resumeUnavailable: 'provider_session_state_unavailable_for_resume',
} as const;

export const ConnectedServiceRunMaterializationFailureResponseSchema = z.strictObject({
    ok: z.literal(false),
    errorCode: z.enum([CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.blocked,
        CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.modelUnavailable,
        CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.resumeUnavailable]),
    modelId: z.optional(z.string()),
    errorMessage: z.optional(z.string()),
    uxDiagnostic: z.optional(ConnectedServiceUxDiagnosticV1Schema),
});

export const ConnectedServiceRunRejectedStartRequestSchema = z.strictObject({
    runId: z.string().check(z.trim(), z.minLength(1)),
    runnerPid: z.number().check(z.int(), z.positive()),
    activationId: z.string().check(z.uuid()),
    modelId: z.string().check(z.trim(), z.minLength(1)),
    classification: z.pipe(z.unknown(), z.transform((value, ctx) => {
        const classification = sanitizeConnectedServiceRuntimeFailureClassification(value);
        if (!classification) {
            ctx.issues.push({ code: "custom", message: 'Invalid connected service classification', input: ctx.value });
            return z.NEVER;
        }
        return classification;
    })),
});
export type ConnectedServiceRunRejectedStartRequest = z.infer<typeof ConnectedServiceRunRejectedStartRequestSchema>;
export const ConnectedServiceRunRejectedStartResultSchema = z.union([
    z.strictObject({ ok: z.literal(true), retry: z.literal(true) }),
    z.extend(ConnectedServiceRunMaterializationFailureResponseSchema, {
        errorCode: z.enum([
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.unavailable,
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.blocked,
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.stale,
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.modelUnavailable,
            CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.resumeUnavailable,
        ]),
    }),
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
        unsetEnvKeys?: readonly string[];
        connectedServicesBindings: unknown;
        registration: ExecutionRunConnectedServicesRegistrationV1;
    }>
    | z.infer<typeof ConnectedServiceRunMaterializationFailureResponseSchema>;

export type ConnectedServiceRunMaterializationHandler = (
    input: ConnectedServiceRunMaterializeRequest,
    signal?: AbortSignal,
) => Promise<ConnectedServiceRunMaterializationHandlerResult>;

export type ConnectedServiceRunReleaseHandler = (
    input: ConnectedServiceRunReleaseRequest,
) => Promise<z.infer<typeof ConnectedServiceRunReleaseResultSchema>>;

export type ConnectedServiceRunGenerationCurrentHandler = (
    input: ConnectedServiceRunGenerationCurrentRequest,
) => Promise<Readonly<{ ok: true; current: boolean }>>;
