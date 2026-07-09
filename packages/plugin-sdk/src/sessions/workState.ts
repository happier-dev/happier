import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export const SESSION_WORK_STATE_GOAL_RPC_METHODS_V1 = Object.freeze({
    get: SESSION_RPC_METHODS.SESSION_GOAL_GET,
    set: SESSION_RPC_METHODS.SESSION_GOAL_SET,
    clear: SESSION_RPC_METHODS.SESSION_GOAL_CLEAR,
});

export {
    SessionWorkStateGoalCapabilitiesV1Schema,
    boundSessionWorkStateItemsV1,
    mergeSessionWorkStateMetadataV1,
    mergeSessionWorkStateV1,
    readDisplayableSessionWorkStateV1,
    readSessionWorkStateV1FromMetadata,
    resolveSessionWorkStatePrimaryItemId,
    writeSessionWorkStateV1ToMetadata,
    type SessionWorkStateGoalCapabilitiesV1,
    type SessionWorkStateItemV1,
    type SessionWorkStateStatusV1,
    type SessionWorkStateV1,
    type SessionWorkStateWriteItemV1,
    type SessionWorkStateWriteSnapshotV1,
} from '@happier-dev/protocol';

// Provider-agnostic workflow activity contracts (DW2). Re-exported here so the Claude plugin
// normalizer can consume the durable snapshot/headline schemas + the per-run revision helpers
// without depending on `@happier-dev/protocol` directly. Workflow detail rides durable system
// records; only the count-only headline rides session metadata (key `sessionWorkflowActivityHeadlineV1`).
export {
    ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
    SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
    buildWorkflowRunSystemRecordLocalId,
    type ActivitySessionSystemRecordKind,
    type SessionSystemRecordKind,
    type SessionSystemRecordNamespace,
} from '@happier-dev/protocol';

export {
    SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX,
    SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX,
    SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX,
    SessionWorkflowActivityHeadlineV1Schema,
    SessionWorkflowAgentSnapshotV1Schema,
    SessionWorkflowAgentStatusV1Schema,
    SessionWorkflowPhaseSnapshotV1Schema,
    SessionWorkflowRunHeadlineV1Schema,
    SessionWorkflowRunSnapshotV1Schema,
    SessionWorkflowRunStatusV1Schema,
    buildSessionWorkflowActivityHeadline,
    bumpWorkflowRunRecordRevision,
    findWorkflowPhaseForAgent,
    isTerminalWorkflowRunStatus,
    isWorkflowRunSnapshotMaterialChange,
    resolvePrimaryWorkflowRunId,
    resolveWorkflowAgentPhaseTitle,
    sortActiveWorkflowRunHeadlines,
    type SessionWorkflowActivityHeadlineV1,
    type SessionWorkflowAgentSnapshotV1,
    type SessionWorkflowAgentStatusV1,
    type SessionWorkflowPhaseSnapshotV1,
    type SessionWorkflowRunHeadlineV1,
    type SessionWorkflowRunSnapshotV1,
    type SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol';
