/**
 * Operations barrel (split by domain)
 */

export * from './ops/machines';
export * from './ops/machineAccount';
export * from './ops/capabilities';
export * from './ops/sessions';
export * from './ops/sessionReadState';
export * from './ops/sessionScm';
export * from './ops/sessionFileSystem';
export * from './domains/transfers/ops/uploadSessionAttachment';
export * from './ops/machineExecutionRuns';
export * from './ops/machineDirectSessions';
export * from './ops/machineFileBrowser';


export type { SpawnHappySessionRpcParams, SpawnSessionOptions } from './domains/session/spawn/spawnSessionPayload';
export { buildSpawnHappySessionRpcParams } from './domains/session/spawn/spawnSessionPayload';
export type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from './api/capabilities/capabilitiesProtocol';
