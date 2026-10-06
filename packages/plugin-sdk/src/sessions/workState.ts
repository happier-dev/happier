export { boundSessionWorkStateItemsV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateBounds';
export type { SessionWorkStateGoalCapabilitiesV1, SessionWorkStateItemV1, SessionWorkStateStatusV1, SessionWorkStateV1 } from '@happier-dev/protocol/sessions/work-state';
/** @realm daemon */
export {
    type SessionWorkStateTruncationV1,
    type SessionWorkStateUnknownItemV1,
    type ResolveSessionWorkStatePrimaryOptions,
} from '@happier-dev/protocol/sessions/work-state';

import { resolveSessionWorkStatePrimaryItemId as resolveProtocolSessionWorkStatePrimaryItemId } from '@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary';
import type { ResolveSessionWorkStatePrimaryOptions, SessionWorkStateItemV1, SessionWorkStateUnknownItemV1 } from '@happier-dev/protocol/sessions/work-state';

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

export { ACTIVITY_SESSION_SYSTEM_RECORD_KINDS, SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE, buildBackgroundTaskSystemRecordLocalId, buildWorkflowRunSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
export type { ActivitySessionSystemRecordKind } from '@happier-dev/protocol/sessions/work-state';

export { BACKGROUND_TASK_KINDS_V1, BACKGROUND_TASK_LABEL_MAX, BACKGROUND_TASK_SUMMARY_MAX, BackgroundTaskKindV1Schema, SessionBackgroundTaskRecordV1Schema } from '@happier-dev/protocol/sessions/work/backgroundTask/backgroundTaskRecordV1';
export { BACKGROUND_TASK_LABEL_TRUNCATION_SUFFIX, redactBackgroundCommand } from '@happier-dev/protocol/sessions/work/backgroundTask/backgroundTaskRedaction';
export type { BackgroundCommandPathCollapse, BackgroundTaskKindV1, SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol/sessions/work-state';

export { SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX, SessionAgentActivityEntryV1Schema } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityEntryV1';
export { SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY, SessionAgentActivityHeadlineV1Schema, parseSessionAgentActivityHeadlineV1, readSessionAgentActivityHeadlineFromMetadata } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
export { SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT, buildSessionAgentActivityHeadline } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineBuild';
export { AGENT_ACTIVITY_KINDS_V1, AgentActivityKindV1Schema } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityKindV1';
export { AGENT_ACTIVITY_STATUSES_V1, AgentActivityStatusV1Schema, isTerminalAgentActivityStatus } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityStatusV1';
export { AGENT_ACTIVITY_TONES_V1, AgentActivityToneV1Schema, resolveAgentActivityTone } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityToneV1';
export { SessionActivityHeadlineBundleV1Schema } from '@happier-dev/protocol/sessions/work/sessionActivityHeadlineBundleV1';
export { buildAgentActivityEntryId, parseAgentActivityEntryId, resolveAgentActivityEntryAgentHandle } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityEntryId';
export { fromWorkflowAgentStatus } from '@happier-dev/protocol/sessions/work/agentActivity/adapters/fromWorkflowAgentStatus';
export { fromWorkflowRunStatus } from '@happier-dev/protocol/sessions/work/agentActivity/adapters/fromWorkflowRunStatus';
export type { AgentActivityEntryRefV1, AgentActivityKindV1, AgentActivityStatusV1, AgentActivityToneV1, BuildSessionAgentActivityHeadlineInput, SessionActivityHeadlineBundleV1, SessionAgentActivityEntryV1, SessionAgentActivityHeadlineV1 } from '@happier-dev/protocol/sessions/work-state';

export { SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX, SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION, SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX, SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX, SessionWorkflowRunSnapshotV1Schema } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';
export { SessionWorkflowActivityHeadlineV1Schema } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
export { buildSessionWorkflowActivityHeadline, isTerminalWorkflowRunStatus } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineBuild';
export { bumpWorkflowRunRecordRevision, isWorkflowRunSnapshotMaterialChange } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunRecordRevision';
export type { SessionWorkflowActivityHeadlineV1, SessionWorkflowAgentSnapshotV1, SessionWorkflowAgentStatusV1, SessionWorkflowPhaseSnapshotV1, SessionWorkflowRunHeadlineV1, SessionWorkflowRunSnapshotV1, SessionWorkflowRunStatusReasonV1, SessionWorkflowRunStatusV1 } from '@happier-dev/protocol/sessions/work-state';
/** @realm daemon */
export { type BuildSessionWorkflowActivityHeadlineInput } from '@happier-dev/protocol/sessions/work-state';
