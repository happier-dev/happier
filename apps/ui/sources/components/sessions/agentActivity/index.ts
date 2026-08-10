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
} from './presentation/agentActivityStaleness';
export {
    useAgentActivityStalenessResolver,
    type AgentActivityStalenessResolver,
} from './presentation/useAgentActivityStaleness';
export { formatElapsedDuration } from './presentation/formatElapsedDuration';
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
    resolveAgentActivityEntryFromSubagent,
    resolveSessionSubagentRowActions,
    resolveSessionSubagentTeamId,
    type SessionSubagentEntryParams,
} from './sources/fromSessionSubagents';
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
    AGENT_ATTENTION_RAIL_INSET_PX,
    AGENT_ATTENTION_RAIL_PX,
    AGENT_ROW_DIVIDER_INSET_PX,
    AGENT_ROW_MIN_HEIGHT_PX,
    AGENT_STATUS_COLUMN_PX,
    AGENT_STATUS_GLYPH_PX,
    AGENT_TIME_SLOT_MIN_PX,
} from './row/agentRowMetrics';
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
