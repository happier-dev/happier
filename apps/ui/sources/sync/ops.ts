/**
 * Operations barrel (split by domain)
 */

export {
    completePendingMachineSpawnAttemptCustodyForSession,
    machineResolveSpawnSessionByNonce,
    machineResolveSpawnSessionByNonceUntilSettled,
    machineStopDaemon,
    machineStopSession,
    machineBash,
    machinePreviewEnv,
    machineCollectBugReportDiagnostics,
    machineGetBugReportLogTail,
    machineReadSessionLogTail,
    machineUpdateMetadata,
} from './ops/machines';
export type {
    MachineResolveSpawnSessionByNonceResult,
    MachineStopSessionResult,
    MachineBashRequest,
    EnvPreviewSecretsPolicy,
    PreviewEnvSensitivitySource,
    PreviewEnvValue,
    PreviewEnvResponse,
    MachinePreviewEnvResult,
    BugReportCollectDiagnosticsResult,
    BugReportLogTailResult,
    MachineReadSessionLogTailResult,
} from './ops/machines';
export * from './ops/machineAccount';
export * from './ops/capabilities';
export * from './ops/sessions';
export * from './ops/sessionReadState';
export * from './ops/workspaceFileSystem';
export * from './domains/transfers/ops/uploadSessionAttachment';
export * from './ops/machineExecutionRuns';
export * from './ops/machineExternalSessions';
export * from './ops/machineFileBrowser';


export type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from './api/capabilities/capabilitiesProtocol';
