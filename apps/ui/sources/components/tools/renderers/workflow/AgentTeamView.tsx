import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    AgentTeamCreateInputV2Schema,
    AgentTeamCreateResultV2Schema,
    AgentTeamDeleteInputV2Schema,
    AgentTeamDeleteResultV2Schema,
    AgentTeamSendMessageInputV2Schema,
    AgentTeamSendMessageResultV2Schema,
} from '@happier-dev/protocol';

import type { ToolViewProps } from '@/components/tools/renderers/core/_registry';
import { ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

function formatToolTitle(name: string): string {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return 'Tool';
    return trimmed
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

function toCode(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        try {
            return String(value);
        } catch {
            return '[unprintable]';
        }
    }
}

type Fact = Readonly<{ label: string; value: string }>;

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function appendFact(facts: Fact[], label: string, value: unknown): void {
    const normalized = normalizeString(value);
    if (normalized) facts.push({ label, value: normalized });
}

function omitKnownKeys(value: unknown, knownKeys: readonly string[]): unknown | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
    const rest = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([key]) => !knownKeys.includes(key)),
    );
    return Object.keys(rest).length > 0 ? rest : null;
}

function extractStructuredSections(tool: ToolViewProps['tool']): Readonly<{
    inputFacts: readonly Fact[];
    resultFacts: readonly Fact[];
    rawInput: unknown | null;
    rawResult: unknown | null;
}> {
    const inputFacts: Fact[] = [];
    const resultFacts: Fact[] = [];

    if (tool.name === 'AgentTeamCreate') {
        const parsedInput = AgentTeamCreateInputV2Schema.safeParse(tool.input);
        if (parsedInput.success) {
            appendFact(inputFacts, t('tools.agentTeamView.team'), parsedInput.data.team_name ?? parsedInput.data.teamName);
            appendFact(inputFacts, t('tools.agentTeamView.description'), parsedInput.data.description);
        }
        const parsedResult = AgentTeamCreateResultV2Schema.safeParse(tool.result);
        if (parsedResult.success) {
            appendFact(resultFacts, t('tools.agentTeamView.status'), parsedResult.data.status ?? parsedResult.data.tool_use_result?.status);
            appendFact(resultFacts, t('tools.agentTeamView.team'), parsedResult.data.team_name ?? parsedResult.data.teamName ?? parsedResult.data.tool_use_result?.team_name ?? parsedResult.data.tool_use_result?.teamName);
        }
        return {
            inputFacts,
            resultFacts,
            rawInput: omitKnownKeys(tool.input, ['team_name', 'teamName', 'description', 'lead_agent_id', 'leadAgentId']),
            rawResult: omitKnownKeys(tool.result, ['status', 'team_name', 'teamName', 'description', 'lead_agent_id', 'leadAgentId', 'tool_use_result']),
        };
    }

    if (tool.name === 'AgentTeamDelete') {
        const parsedInput = AgentTeamDeleteInputV2Schema.safeParse(tool.input);
        if (parsedInput.success) {
            appendFact(inputFacts, t('tools.agentTeamView.team'), parsedInput.data.team_name ?? parsedInput.data.teamName);
        }
        const parsedResult = AgentTeamDeleteResultV2Schema.safeParse(tool.result);
        if (parsedResult.success) {
            appendFact(resultFacts, t('tools.agentTeamView.status'), parsedResult.data.status ?? parsedResult.data.tool_use_result?.status);
            appendFact(resultFacts, t('tools.agentTeamView.team'), parsedResult.data.team_name ?? parsedResult.data.teamName ?? parsedResult.data.tool_use_result?.team_name ?? parsedResult.data.tool_use_result?.teamName);
        }
        return {
            inputFacts,
            resultFacts,
            rawInput: omitKnownKeys(tool.input, ['team_name', 'teamName']),
            rawResult: omitKnownKeys(tool.result, ['status', 'team_name', 'teamName', 'tool_use_result']),
        };
    }

    const parsedInput = AgentTeamSendMessageInputV2Schema.safeParse(tool.input);
    if (parsedInput.success) {
        appendFact(inputFacts, t('tools.agentTeamView.team'), parsedInput.data.team_name ?? parsedInput.data.teamName);
        appendFact(inputFacts, t('tools.agentTeamView.member'), parsedInput.data.name ?? parsedInput.data.agent_id ?? parsedInput.data.teammate_id);
        appendFact(inputFacts, t('tools.agentTeamView.type'), parsedInput.data.type);
        appendFact(inputFacts, t('tools.agentTeamView.content'), parsedInput.data.content ?? parsedInput.data.message);
    }
    const parsedResult = AgentTeamSendMessageResultV2Schema.safeParse(tool.result);
    if (parsedResult.success) {
        appendFact(resultFacts, t('tools.agentTeamView.status'), parsedResult.data.status ?? parsedResult.data.tool_use_result?.status);
        appendFact(resultFacts, t('tools.agentTeamView.team'), parsedResult.data.team_name ?? parsedResult.data.teamName ?? parsedResult.data.tool_use_result?.team_name ?? parsedResult.data.tool_use_result?.teamName);
        appendFact(resultFacts, t('tools.agentTeamView.type'), parsedResult.data.type ?? parsedResult.data.tool_use_result?.type);
        appendFact(resultFacts, t('tools.agentTeamView.content'), parsedResult.data.content ?? parsedResult.data.tool_use_result?.content);
    }
    return {
        inputFacts,
        resultFacts,
        rawInput: omitKnownKeys(tool.input, ['team_name', 'teamName', 'type', 'content', 'message', 'agent_id', 'teammate_id', 'name']),
        rawResult: omitKnownKeys(tool.result, ['status', 'team_name', 'teamName', 'type', 'content', 'tool_use_result']),
    };
}

export const AgentTeamView = React.memo<ToolViewProps>(({ tool }) => {
    const { inputFacts, resultFacts, rawInput, rawResult } = extractStructuredSections(tool);
    const hasInput = inputFacts.length > 0 || rawInput !== null;
    const hasResult = resultFacts.length > 0 || rawResult !== null;
    if (!hasInput && !hasResult) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.title}>{formatToolTitle(tool.name)}</Text>
                {inputFacts.length > 0 ? (
                    <View style={styles.section}>
                        {inputFacts.map((fact) => (
                            <View key={`input-${fact.label}-${fact.value}`} style={styles.factRow}>
                                <Text style={styles.label}>{fact.label}</Text>
                                <Text style={styles.value}>{fact.value}</Text>
                            </View>
                        ))}
                    </View>
                ) : null}
                {rawInput !== null ? <CodeView code={toCode(rawInput)} /> : null}
                {resultFacts.length > 0 ? (
                    <View style={styles.section}>
                        {resultFacts.map((fact) => (
                            <View key={`result-${fact.label}-${fact.value}`} style={styles.factRow}>
                                <Text style={styles.label}>{fact.label}</Text>
                                <Text style={styles.value}>{fact.value}</Text>
                            </View>
                        ))}
                    </View>
                ) : null}
                {rawResult !== null ? <CodeView code={toCode(rawResult)} /> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 10,
    },
    section: {
        gap: 8,
    },
    factRow: {
        gap: 4,
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    value: {
        fontSize: 14,
        color: theme.colors.text.primary,
    },
}));
