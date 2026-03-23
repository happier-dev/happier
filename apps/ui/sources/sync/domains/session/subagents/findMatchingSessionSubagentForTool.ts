import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { readExecutionRunIdFromToolPayload } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';

import type { SessionSubagent } from './types';

export function findMatchingSessionSubagentForTool(
    params: Readonly<{
        tool: ToolCall;
        subagents: readonly SessionSubagent[];
    }>,
): SessionSubagent | null {
    const runId = params.tool.name === 'SubAgentRun' ? readExecutionRunIdFromToolPayload(params.tool) : null;
    const sidechainId = resolveToolTranscriptSidechainId({
        tool: params.tool,
        normalizedToolName: params.tool.name,
    });
    const toolId = typeof params.tool.id === 'string' ? params.tool.id.trim() : '';

    return params.subagents.find((subagent) => {
        if (runId && subagent.kind === 'execution_run' && subagent.runRef?.runId === runId) return true;
        if (sidechainId && subagent.transcript.sidechainId === sidechainId) return true;
        if (toolId && subagent.transcript.toolId === toolId) return true;
        return false;
    }) ?? null;
}
