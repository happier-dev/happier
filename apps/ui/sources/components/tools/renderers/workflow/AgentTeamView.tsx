import * as React from 'react';
import {
    AgentTeamCreateInputV2Schema,
    AgentTeamCreateResultV2Schema,
    AgentTeamDeleteInputV2Schema,
    AgentTeamDeleteResultV2Schema,
    AgentTeamSendMessageInputV2Schema,
    AgentTeamSendMessageResultV2Schema,
} from '@happier-dev/protocol';

import { StructuredToolCard } from '@/components/tools/renderers/core/StructuredToolCard';
import type { ToolViewProps } from '@/components/tools/renderers/core/_registry';
import {
    appendStructuredToolFact,
    formatStructuredToolTitle,
    omitStructuredToolKnownKeys,
    type StructuredToolFact,
} from '@/components/tools/renderers/core/structuredToolFacts';
import { t } from '@/text';

function extractStructuredSections(tool: ToolViewProps['tool']): Readonly<{
    inputFacts: readonly StructuredToolFact[];
    resultFacts: readonly StructuredToolFact[];
    rawInput: unknown | null;
    rawResult: unknown | null;
}> {
    const inputFacts: StructuredToolFact[] = [];
    const resultFacts: StructuredToolFact[] = [];

    if (tool.name === 'AgentTeamCreate') {
        const parsedInput = AgentTeamCreateInputV2Schema.safeParse(tool.input);
        if (parsedInput.success) {
            appendStructuredToolFact(inputFacts, t('tools.agentTeamView.team'), parsedInput.data.team_name ?? parsedInput.data.teamName);
            appendStructuredToolFact(inputFacts, t('tools.agentTeamView.description'), parsedInput.data.description);
        }
        const parsedResult = AgentTeamCreateResultV2Schema.safeParse(tool.result);
        if (parsedResult.success) {
            appendStructuredToolFact(resultFacts, t('tools.agentTeamView.status'), parsedResult.data.status ?? parsedResult.data.tool_use_result?.status);
            appendStructuredToolFact(resultFacts, t('tools.agentTeamView.team'), parsedResult.data.team_name ?? parsedResult.data.teamName ?? parsedResult.data.tool_use_result?.team_name ?? parsedResult.data.tool_use_result?.teamName);
        }
        return {
            inputFacts,
            resultFacts,
            rawInput: omitStructuredToolKnownKeys(tool.input, ['team_name', 'teamName', 'description', 'lead_agent_id', 'leadAgentId']),
            rawResult: omitStructuredToolKnownKeys(tool.result, ['status', 'team_name', 'teamName', 'description', 'lead_agent_id', 'leadAgentId', 'tool_use_result']),
        };
    }

    if (tool.name === 'AgentTeamDelete') {
        const parsedInput = AgentTeamDeleteInputV2Schema.safeParse(tool.input);
        if (parsedInput.success) {
            appendStructuredToolFact(inputFacts, t('tools.agentTeamView.team'), parsedInput.data.team_name ?? parsedInput.data.teamName);
        }
        const parsedResult = AgentTeamDeleteResultV2Schema.safeParse(tool.result);
        if (parsedResult.success) {
            appendStructuredToolFact(resultFacts, t('tools.agentTeamView.status'), parsedResult.data.status ?? parsedResult.data.tool_use_result?.status);
            appendStructuredToolFact(resultFacts, t('tools.agentTeamView.team'), parsedResult.data.team_name ?? parsedResult.data.teamName ?? parsedResult.data.tool_use_result?.team_name ?? parsedResult.data.tool_use_result?.teamName);
        }
        return {
            inputFacts,
            resultFacts,
            rawInput: omitStructuredToolKnownKeys(tool.input, ['team_name', 'teamName']),
            rawResult: omitStructuredToolKnownKeys(tool.result, ['status', 'team_name', 'teamName', 'tool_use_result']),
        };
    }

    const parsedInput = AgentTeamSendMessageInputV2Schema.safeParse(tool.input);
    if (parsedInput.success) {
        appendStructuredToolFact(inputFacts, t('tools.agentTeamView.team'), parsedInput.data.team_name ?? parsedInput.data.teamName);
        appendStructuredToolFact(inputFacts, t('tools.agentTeamView.member'), parsedInput.data.name ?? parsedInput.data.agent_id ?? parsedInput.data.teammate_id);
        appendStructuredToolFact(inputFacts, t('tools.agentTeamView.type'), parsedInput.data.type);
        appendStructuredToolFact(inputFacts, t('tools.agentTeamView.content'), parsedInput.data.content ?? parsedInput.data.message);
    }
    const parsedResult = AgentTeamSendMessageResultV2Schema.safeParse(tool.result);
    if (parsedResult.success) {
        appendStructuredToolFact(resultFacts, t('tools.agentTeamView.status'), parsedResult.data.status ?? parsedResult.data.tool_use_result?.status);
        appendStructuredToolFact(resultFacts, t('tools.agentTeamView.team'), parsedResult.data.team_name ?? parsedResult.data.teamName ?? parsedResult.data.tool_use_result?.team_name ?? parsedResult.data.tool_use_result?.teamName);
        appendStructuredToolFact(resultFacts, t('tools.agentTeamView.type'), parsedResult.data.type ?? parsedResult.data.tool_use_result?.type);
        appendStructuredToolFact(resultFacts, t('tools.agentTeamView.content'), parsedResult.data.content ?? parsedResult.data.tool_use_result?.content);
    }
    return {
        inputFacts,
        resultFacts,
        rawInput: omitStructuredToolKnownKeys(tool.input, ['team_name', 'teamName', 'type', 'content', 'message', 'agent_id', 'teammate_id', 'name']),
        rawResult: omitStructuredToolKnownKeys(tool.result, ['status', 'team_name', 'teamName', 'type', 'content', 'tool_use_result']),
    };
}

export const AgentTeamView = React.memo<ToolViewProps>(({ tool }) => {
    const { inputFacts, resultFacts, rawInput, rawResult } = extractStructuredSections(tool);
    const hasInput = inputFacts.length > 0 || rawInput !== null;
    const hasResult = resultFacts.length > 0 || rawResult !== null;
    if (!hasInput && !hasResult) return null;

    return (
        <StructuredToolCard
            title={formatStructuredToolTitle(tool.name)}
            inputFacts={inputFacts}
            resultFacts={resultFacts}
            rawInput={rawInput}
            rawResult={rawResult}
        />
    );
});
