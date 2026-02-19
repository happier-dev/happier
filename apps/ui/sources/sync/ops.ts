/**
 * Operations barrel (split by domain)
 */

export * from './ops/machines';
export * from './ops/machineAccount';
export * from './ops/capabilities';
export * from './ops/sessions';
export * from './ops/sessionAttachmentsUpload';
export * from './ops/machineExecutionRuns';


export type { SpawnHappySessionRpcParams, SpawnSessionOptions } from './domains/session/spawn/spawnSessionPayload';
export { buildSpawnHappySessionRpcParams } from './domains/session/spawn/spawnSessionPayload';
export type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from './api/capabilities/capabilitiesProtocol';
