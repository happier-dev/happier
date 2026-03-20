import type {
    BackendTargetRefV1,
    SessionAuthoringCodexBackendMode,
    SessionAuthoringTerminalV1,
    SessionAuthoringValueV1,
} from '@happier-dev/protocol';

export type SessionAuthoringSnapshot = Readonly<{
    directory: string;
    agentId: string | null;
    backendTarget: BackendTargetRefV1 | null;
    transcriptStorage: SessionAuthoringValueV1['transcriptStorage'];
    profileId: SessionAuthoringValueV1['profileId'];
    permissionMode: SessionAuthoringValueV1['permissionMode'];
    permissionModeUpdatedAt: SessionAuthoringValueV1['permissionModeUpdatedAt'];
    modelId: SessionAuthoringValueV1['modelId'];
    modelUpdatedAt: SessionAuthoringValueV1['modelUpdatedAt'];
    mcpSelection: SessionAuthoringValueV1['mcpSelection'];
    connectedServices: SessionAuthoringValueV1['connectedServices'];
    terminal: SessionAuthoringTerminalV1 | null;
    codexBackendMode: SessionAuthoringCodexBackendMode | null;
    existingSessionId: string;
    sessionEncryptionMode: SessionAuthoringValueV1['sessionEncryptionMode'];
    sessionEncryptionKeyBase64: SessionAuthoringValueV1['sessionEncryptionKeyBase64'];
    sessionEncryptionVariant: SessionAuthoringValueV1['sessionEncryptionVariant'];
}>;
