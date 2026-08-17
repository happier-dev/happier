export {
    boundSessionWorkStateItemsV1,
    type SessionWorkStateGoalCapabilitiesV1,
    type SessionWorkStateItemV1,
    type SessionWorkStateStatusV1,
    type SessionWorkStateV1,
} from '@happier-dev/protocol/sessions/work-state';
/** @realm daemon */
export {
    type SessionWorkStateTruncationV1,
    type SessionWorkStateUnknownItemV1,
    type ResolveSessionWorkStatePrimaryOptions,
} from '@happier-dev/protocol/sessions/work-state';

import {
    resolveSessionWorkStatePrimaryItemId as resolveProtocolSessionWorkStatePrimaryItemId,
    type ResolveSessionWorkStatePrimaryOptions,
    type SessionWorkStateItemV1,
    type SessionWorkStateUnknownItemV1,
} from '@happier-dev/protocol/sessions/work-state';

/**
 * Selects the primary item from the public logical work-state item model.
 * Persistence/write-envelope types intentionally remain Protocol-owned.
 */
export function resolveSessionWorkStatePrimaryItemId(
    items: readonly (SessionWorkStateItemV1 | SessionWorkStateUnknownItemV1)[],
    previousPrimaryItemId?: string | null,
    options?: ResolveSessionWorkStatePrimaryOptions,
): string | null {
    return resolveProtocolSessionWorkStatePrimaryItemId(items, previousPrimaryItemId, options);
}

export {
    ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
    SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
    buildBackgroundTaskSystemRecordLocalId,
    buildWorkflowRunSystemRecordLocalId,
    type ActivitySessionSystemRecordKind,
} from '@happier-dev/protocol/sessions/work-state';

export {
    BACKGROUND_TASK_KINDS_V1,
    BACKGROUND_TASK_LABEL_MAX,
    BACKGROUND_TASK_LABEL_TRUNCATION_SUFFIX,
    BACKGROUND_TASK_SUMMARY_MAX,
    BackgroundTaskKindV1Schema,
    SessionBackgroundTaskRecordV1Schema,
    redactBackgroundCommand,
    type BackgroundCommandPathCollapse,
    type BackgroundTaskKindV1,
    type SessionBackgroundTaskRecordV1,
} from '@happier-dev/protocol/sessions/work-state';

export {
    SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX,
    SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
    SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT,
    AGENT_ACTIVITY_KINDS_V1,
    AGENT_ACTIVITY_STATUSES_V1,
    AGENT_ACTIVITY_TONES_V1,
    AgentActivityKindV1Schema,
    AgentActivityStatusV1Schema,
    AgentActivityToneV1Schema,
    SessionActivityHeadlineBundleV1Schema,
    SessionAgentActivityEntryV1Schema,
    SessionAgentActivityHeadlineV1Schema,
    buildAgentActivityEntryId,
    buildSessionAgentActivityHeadline,
    fromWorkflowAgentStatus,
    fromWorkflowRunStatus,
    isTerminalAgentActivityStatus,
    parseAgentActivityEntryId,
    parseSessionAgentActivityHeadlineV1,
    readSessionAgentActivityHeadlineFromMetadata,
    resolveAgentActivityEntryAgentHandle,
    resolveAgentActivityTone,
    type AgentActivityEntryRefV1,
    type AgentActivityKindV1,
    type AgentActivityStatusV1,
    type AgentActivityToneV1,
    type BuildSessionAgentActivityHeadlineInput,
    type SessionActivityHeadlineBundleV1,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol/sessions/work-state';

export {
    SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX,
    SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX,
    SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX,
    SessionWorkflowActivityHeadlineV1Schema,
    SessionWorkflowRunSnapshotV1Schema,
    buildSessionWorkflowActivityHeadline,
    bumpWorkflowRunRecordRevision,
    isTerminalWorkflowRunStatus,
    isWorkflowRunSnapshotMaterialChange,
    type SessionWorkflowActivityHeadlineV1,
    type SessionWorkflowAgentSnapshotV1,
    type SessionWorkflowAgentStatusV1,
    type SessionWorkflowPhaseSnapshotV1,
    type SessionWorkflowRunHeadlineV1,
    type SessionWorkflowRunSnapshotV1,
    type SessionWorkflowRunStatusReasonV1,
    type SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol/sessions/work-state';
/** @realm daemon */
export { type BuildSessionWorkflowActivityHeadlineInput } from '@happier-dev/protocol/sessions/work-state';
