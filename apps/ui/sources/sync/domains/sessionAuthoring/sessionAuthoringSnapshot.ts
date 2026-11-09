import type {
    AgentExecutionTargetV1} from '@happier-dev/protocol/agents/executionTargetV1';
import type {
    BackendTargetRefV2} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type {
    RuntimeDescriptorV1} from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import type {
    SessionAuthoringTerminalV1,
    SessionAuthoringValueV1,
} from '@happier-dev/protocol/sessions/authoring/index';

export type SessionAuthoringSnapshot = Readonly<{
    directory: string;
    agentId: string | null;
    agentTarget: AgentExecutionTargetV1 | null;
    backendTarget: BackendTargetRefV2 | null;
    transcriptStorage: SessionAuthoringValueV1['transcriptStorage'];
    profileId: SessionAuthoringValueV1['profileId'];
    permissionMode: SessionAuthoringValueV1['permissionMode'];
    permissionModeUpdatedAt: SessionAuthoringValueV1['permissionModeUpdatedAt'];
    modelSelection: SessionAuthoringValueV1['modelSelection'];
    modelId: SessionAuthoringValueV1['modelId'];
    modelUpdatedAt: SessionAuthoringValueV1['modelUpdatedAt'];
    capabilitySelection: SessionAuthoringValueV1['capabilitySelection'];
    connectedServices: SessionAuthoringValueV1['connectedServices'];
    terminal: SessionAuthoringTerminalV1 | null;
    runtimeDescriptorV1: RuntimeDescriptorV1 | null;
    existingSessionId: string;
    sessionEncryptionMode: SessionAuthoringValueV1['sessionEncryptionMode'];
    sessionEncryptionKeyBase64: SessionAuthoringValueV1['sessionEncryptionKeyBase64'];
    sessionEncryptionVariant: SessionAuthoringValueV1['sessionEncryptionVariant'];
}>;
