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
export { formatElapsedDuration } from './presentation/formatElapsedDuration';
export { resolveAgentActivityMetaLine } from './presentation/resolveAgentActivityMetaLine';
export { resolveAgentActivityTitle } from './presentation/resolveAgentActivityTitle';
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
