export type {
    SubagentLifecycleDetailV1,
    SubagentRefInputV1,
    SubagentRefV1,
    SubagentStatusV1,
} from '@happier-dev/protocol/sessions/subagents';
export {
    parseParticipantMessageV1,
    parseSubagentCommandV1,
    parseSubagentLaunchV1,
} from '@happier-dev/protocol/sessions/subagents';
export type {
    ParticipantMessageV1,
    ParticipantRecipientV1,
    SubagentCommandV1,
    SubagentLaunchV1,
} from '@happier-dev/protocol/sessions/subagents';
export const isGenericSubagentToolName: (
    toolName: string,
) => toolName is 'SubAgent' | 'Task' | 'Agent' = isGenericSubAgentToolName;
/**
 * Does this sub-agent tool result merely acknowledge that the agent was *launched*?
 *
 * The generic sub-agent tool is asynchronous: it answers within milliseconds and the agent's real
 * outcome arrives later against the same tool-use id. An agent runtime that reads the
 * acknowledgement as the answer terminalizes every agent at launch.
 */
export const isAsyncSubagentLaunchToolResult: (value: unknown) => boolean =
    isAsyncSubAgentLaunchToolResult;
export type {
    PluginExecutionRunProfileContributionV2 as ExecutionRunProfileContribution,
} from '@happier-dev/protocol/sessions/subagents';
import {
    isAsyncSubAgentLaunchToolResult,
    isGenericSubAgentToolName,
} from '@happier-dev/protocol/tools/v2/subAgentFamilies';
