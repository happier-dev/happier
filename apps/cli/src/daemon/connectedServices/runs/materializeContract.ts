import { z } from 'zod';

import {
    ConnectedServiceBindingsV1Schema,
    ExecutionRunConnectedServicesLaunchV1Schema,
    type ExecutionRunConnectedServicesLaunchV1,
} from '@happier-dev/protocol';

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

export const ConnectedServiceRunMaterializeRequestSchema = z.object({
    runId: z.string().trim().min(1),
    runnerPid: z.number().int().positive(),
    agentId: z.string().trim().min(1),
    connectedServices: ConnectedServiceBindingsV1Schema,
    cwd: z.string().trim().min(1),
});
export type ConnectedServiceRunMaterializeRequest = z.infer<typeof ConnectedServiceRunMaterializeRequestSchema>;

export const ConnectedServiceRunReleaseRequestSchema = z.object({
    runId: z.string().trim().min(1),
    runnerPid: z.number().int().positive(),
    activationId: z.string().uuid(),
});
export type ConnectedServiceRunReleaseRequest = z.infer<typeof ConnectedServiceRunReleaseRequestSchema>;
export const ConnectedServiceRunGenerationCurrentRequestSchema = z.object({
    runId: z.string().trim().min(1),
    runnerPid: z.number().int().positive(),
});
export type ConnectedServiceRunGenerationCurrentRequest = z.infer<
    typeof ConnectedServiceRunGenerationCurrentRequestSchema
>;

export const CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES = {
    unavailable: 'connected_service_run_materialization_unavailable',
    blocked: 'connected_service_run_materialization_blocked',
} as const;

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
        errorCode: typeof CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.blocked;
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
