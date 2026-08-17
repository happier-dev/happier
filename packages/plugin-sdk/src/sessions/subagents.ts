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
export type {
    PluginExecutionRunProfileContributionV2 as ExecutionRunProfileContribution,
} from '@happier-dev/protocol/sessions/subagents';
import {
    isGenericSubAgentToolName,
} from '@happier-dev/protocol/tools/v2/subAgentFamilies';
