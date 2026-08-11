/**
 * The agent-activity presentation surface.
 *
 * Everything a host needs to render agent work is here, and nothing a host needs is anywhere else:
 * one row, one status glyph table, one tone→ink binding, one elapsed formatter. A surface that
 * reaches past this barrel for a second status colour or a second duration format is the split-brain
 * this folder replaced.
 */
export {
    AGENT_ACTIVITY_ROW_NO_ACTIONS,
    type AgentActivityRowActionId,
    type AgentActivityRowEntry,
} from './agentActivityRowEntry';
export {
    resolveAgentActivityStatusWord,
    resolveAgentActivityToneStyle,
    type AgentActivityToneStyle,
} from './presentation/agentActivityToneStyle';
export {
    AGENT_ACTIVITY_QUIET_AFTER_MS,
    AGENT_ACTIVITY_STALE_AFTER_MS,
    resolveAgentActivityElapsedFreezeAtMs,
    resolveAgentActivityStaleness,
    resolveAgentActivityStalenessNote,
    type AgentActivityStaleness,
    type AgentActivityStalenessInput,
} from './presentation/agentActivityStaleness';
export {
    useAgentActivityStalenessResolver,
    type AgentActivityStalenessResolver,
} from './presentation/useAgentActivityStaleness';
export { formatElapsedDuration } from './presentation/formatElapsedDuration';
export { resolveAgentActivityElapsedStartMs } from './presentation/resolveAgentActivityElapsedStartMs';
export { resolveAgentActivityMetaLine } from './presentation/resolveAgentActivityMetaLine';
export { resolveAgentActivityTitle } from './presentation/resolveAgentActivityTitle';
export {
    AgentActivityList,
    type AgentActivityListFreshness,
    type AgentActivityListProps,
} from './list/AgentActivityList';
export {
    AgentActivitySectionHeader,
    type AgentActivitySectionHeaderProps,
} from './list/AgentActivitySectionHeader';
export {
    LIST_MOTION_SCROLL_IDLE_MS,
    createListMotionQuiet,
    useListMotionQuiet,
    type ListMotionQuiet,
    type ListMotionQuietHandle,
} from './list/listMotionQuiet';
export {
    AGENT_ACTIVITY_MIGRATION_BATCH_CEILING_MS,
    AGENT_ACTIVITY_MIGRATION_DWELL_MS,
} from './list/useAgentActivitySectionMigration';
export {
    AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT,
    AGENT_ACTIVITY_SECTION_IDS,
    buildAgentActivitySectionModel,
    flattenAgentActivitySectionModel,
    resolveAgentActivitySectionId,
    type AgentActivityListItem,
    type AgentActivitySection,
    type AgentActivitySectionId,
    type AgentActivitySectionModel,
} from './list/agentActivitySectionModel';
export {
    BackgroundTaskDetail,
    type BackgroundTaskDetailProps,
} from './background/BackgroundTaskDetail';
export {
    AgentActivityResultDetail,
    type AgentActivityResultDetailProps,
} from './detail/AgentActivityResultDetail';
export {
    RESULT_PREVIEW_MAX_CHARS,
    RESULT_PREVIEW_MAX_LINES,
    clampPreviewLines,
    normalizeResultPreview,
    type ClampedPreviewLines,
    type NormalizedResultPreview,
} from './detail/resultPreview';
export {
    isNavigableAgentActivityOpenTarget,
    resolveAgentActivityOpenTarget,
    type AgentActivityOpenTarget,
    type AgentActivityOpenTargetEntry,
} from './open/resolveAgentActivityOpenTarget';
export {
    AGENT_ACTIVITY_PREVIEW_LINE_MAX_CHARS,
    AGENT_ACTIVITY_PREVIEW_STEP_LIMIT,
    deriveAgentActivityPreview,
    type AgentActivityPreviewMessage,
    type AgentActivityPreviewModel,
    type AgentActivityPreviewStep,
} from './preview/deriveAgentActivityPreview';
export {
    AgentActivityPreview,
    type AgentActivityPreviewProps,
} from './preview/AgentActivityPreview';
export {
    useAgentActivitySidechainPreview,
    type AgentActivitySidechainPreview,
} from './preview/useAgentActivitySidechainPreview';
export { resolveAgentActivityEntryFromWorkflowAgent } from './entry/fromWorkflowAgent';
export {
    resolveAgentActivityEntryFromSubagent,
    resolveSessionSubagentRowActions,
    resolveSessionSubagentTeamId,
    type SessionSubagentEntryParams,
} from './entry/fromSubagent';
export {
    AgentActivityDisclosure,
    type AgentActivityDisclosureProps,
} from './row/AgentActivityDisclosure';
export { AgentActivityRow, type AgentActivityRowProps } from './row/AgentActivityRow';
export {
    AgentActivityRowOverflow,
    type AgentActivityRowOverflowProps,
} from './row/AgentActivityRowOverflow';
export {
    AgentActivityStatusSlot,
    type AgentActivityStatusSlotProps,
} from './row/AgentActivityStatusSlot';
export {
    AgentActivityTimeSlot,
    type AgentActivityTimeSlotProps,
} from './row/AgentActivityTimeSlot';
export {
    AGENT_ROW_DETAIL_INSET_PX,
    AGENT_ROW_DIVIDER_INSET_PX,
    AGENT_ROW_MIN_HEIGHT_PX,
    AGENT_STATUS_COLUMN_PX,
    AGENT_STATUS_GLYPH_PX,
    AGENT_TIME_SLOT_MIN_PX,
} from './row/agentRowMetrics';
export {
    AGENT_ACTIVITY_SURFACE_DENSITY,
    AgentActivitySurface,
    type AgentActivitySurfaceProps,
} from './surface/AgentActivitySurface';
export {
    useAgentActivitySurfaceModel,
    type AgentActivitySurfaceModel,
} from './surface/useAgentActivitySurfaceModel';
export {
    AgentActivityEmptyState,
    type AgentActivityEmptyStateProps,
    type AgentActivityEmptyStateVariant,
} from './states/AgentActivityEmptyState';
export {
    AGENT_ACTIVITY_SKELETON_MAX_ROWS,
    AgentActivitySkeleton,
    type AgentActivitySkeletonProps,
} from './states/AgentActivitySkeleton';
