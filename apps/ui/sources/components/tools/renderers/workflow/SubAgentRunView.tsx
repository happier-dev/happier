import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ToolViewProps } from '@/components/tools/renderers/core/_registry';
import { StructuredResultView, projectStructuredResultDisplayText } from '@/components/tools/renderers/system/StructuredResultView';
import type { Message } from "@happier-dev/session-core/messages";
import {
    deriveTranscriptExecutionRunStatus,
    valueHasRequestInterruptedSignal,
} from '@/sync/domains/session/subagents/executionRuns/executionRunSubagentStatus';
import { SubAgentSummarySection, projectSubAgentSummaryDisplayText } from './SubAgentSummarySection';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';


type FindingsDigest = Readonly<{
    total: number;
    items: ReadonlyArray<
        Readonly<{
            id: string;
            title: string;
            severity: string;
            category: string;
            filePath?: string;
            startLine?: number;
            endLine?: number;
        }>
    >;
}>;

function getFindingsDigest(toolResult: unknown): FindingsDigest | null {
    if (!toolResult || typeof toolResult !== 'object' || Array.isArray(toolResult)) return null;
    const record = toolResult as Record<string, unknown>;
    const digest = record.findingsDigest;
    if (!digest || typeof digest !== 'object' || Array.isArray(digest)) return null;
    const digestRecord = digest as Record<string, unknown>;
    if (typeof digestRecord.total !== 'number' || !Number.isFinite(digestRecord.total) || digestRecord.total < 0) return null;
    if (!Array.isArray(digestRecord.items)) return null;
    const items: FindingsDigest['items'] = digestRecord.items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map((i) => ({
            id: typeof i.id === 'string' ? i.id : '',
            title: typeof i.title === 'string' ? i.title : '',
            severity: typeof i.severity === 'string' ? i.severity : '',
            category: typeof i.category === 'string' ? i.category : '',
            ...(typeof i.filePath === 'string' ? { filePath: i.filePath } : {}),
            ...(typeof i.startLine === 'number' ? { startLine: i.startLine } : {}),
            ...(typeof i.endLine === 'number' ? { endLine: i.endLine } : {}),
        }))
        .filter((i) => i.id.length > 0 && i.title.length > 0 && i.severity.length > 0 && i.category.length > 0);

    if (items.length === 0) return null;
    return { total: digestRecord.total, items };
}

function shouldRenderInterruptedSidechain(tool: ToolViewProps['tool'], messages: readonly Message[]): boolean {
    return deriveTranscriptExecutionRunStatus(tool) === 'unknown'
        && valueHasRequestInterruptedSignal(tool.result) && messages.length > 0;
}

function readString(value: unknown, key: string): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const text = (value as Record<string, unknown>)[key];
    return typeof text === 'string' ? text : null;
}

export const projectSubAgentRunDisplayText: ToolDisplayTextProjector = (tool, _metadata, context) => {
    if (tool.state === 'running') return projectSubAgentSummaryDisplayText(tool, null, context);
    if (shouldRenderInterruptedSidechain(tool, context?.messages ?? [])) {
        return projectSubAgentSummaryDisplayText({ ...tool, state: 'running', result: null }, null, context);
    }
    if (tool.state === 'error') return projectStructuredResultDisplayText({ ...tool, state: 'completed' });
    if (tool.state !== 'completed' || !tool.result) return [];
    const digest = getFindingsDigest(tool.result);
    if (digest) return [
        ...toolTextBlock('tool-digest-title', t('tools.subAgentRunView.reviewDigestTitle')),
        ...digest.items.flatMap((item, index) => toolTextBlock(`tool-finding-${index}`, item.title)),
    ];
    const intent = readString(tool.input, 'intent') ?? readString(tool.result, 'intent');
    return [
        ...(intent === 'plan' || intent === 'delegate' ? [
            ...toolTextBlock('tool-intent-title', t(intent === 'plan' ? 'tools.subAgentRunView.planTitle' : 'tools.subAgentRunView.delegateTitle')),
            ...toolTextBlock('tool-summary', readString(tool.result, 'summary')),
        ] : []),
        ...projectStructuredResultDisplayText(tool),
    ];
};

export const SubAgentRunView = React.memo<ToolViewProps>(({ tool, messages, detailLevel, sessionId, serverId, messageId, interaction }) => {
    const find = useToolFindState(messageId);
    if (tool.state === 'running') {
        return (
            <SubAgentSummarySection
                tool={tool}
                metadata={null}
                messages={messages ?? []}
                detailLevel={detailLevel}
                sessionId={sessionId}
                serverId={serverId}
                messageId={messageId}
                interaction={interaction}
                opts={{ hideResultInlineWhenBackgroundRun: false }}
            />
        );
    }

    // An interrupted outer SubAgentRun call (e.g. turn cancel) leaves an abort placeholder while the
    // sidechain it launched keeps streaming, and the placeholder settles into `error` or `completed`
    // depending on when the interrupt landed — so this cannot sit inside the error branch.
    //
    // The status owner decides whether the run is ambiguous, rather than this renderer re-deriving
    // it: a reported outcome outranks the marker there, and a second copy of that precedence here is
    // how the two surfaces silently drifted into showing the same run as finished and as running.
    if (
        shouldRenderInterruptedSidechain(tool, messages ?? [])
    ) {
        return (
            <SubAgentSummarySection
                tool={{ ...tool, state: 'running', result: null }}
                metadata={null}
                messages={messages ?? []}
                detailLevel={detailLevel}
                sessionId={sessionId}
                serverId={serverId}
                messageId={messageId}
                interaction={interaction}
                opts={{ hideResultInlineWhenBackgroundRun: false }}
            />
        );
    }

    if (tool.state === 'error') {
        if (tool.result) {
            return (
                <StructuredResultView
                    tool={{ ...tool, state: 'completed' }}
                    messageId={messageId}
                    metadata={null}
                    messages={[]}
                />
            );
        }
    }

    if (tool.state !== 'completed') return null;
    if (!tool.result) return null;

    const intent = readString(tool.input, 'intent') ?? readString(tool.result, 'intent');

    const digest = getFindingsDigest(tool.result);
    if (!digest || digest.items.length === 0) {
        if (intent === 'plan') {
            const summary = readString(tool.result, 'summary') ?? '';
            return (
                <View style={styles.container}>
                    <ToolFindText messageId={messageId} blockId="tool-intent-title" text={t('tools.subAgentRunView.planTitle')} style={styles.title} />
                    {summary ? <ToolFindText messageId={messageId} blockId="tool-summary" text={summary} style={styles.line} /> : null}
                    <StructuredResultView tool={tool} messageId={messageId} metadata={null} messages={[]} />
                </View>
            );
        }

        if (intent === 'delegate') {
            const summary = readString(tool.result, 'summary') ?? '';
            return (
                <View style={styles.container}>
                    <ToolFindText messageId={messageId} blockId="tool-intent-title" text={t('tools.subAgentRunView.delegateTitle')} style={styles.title} />
                    {summary ? <ToolFindText messageId={messageId} blockId="tool-summary" text={summary} style={styles.line} /> : null}
                    <StructuredResultView tool={tool} messageId={messageId} metadata={null} messages={[]} />
                </View>
            );
        }

        return <StructuredResultView tool={tool} messageId={messageId} metadata={null} messages={[]} />;
    }

    return (
        <View style={styles.container}>
            <ToolFindText messageId={messageId} blockId="tool-digest-title" text={t('tools.subAgentRunView.reviewDigestTitle')} style={styles.title} />
            {(find.active ? digest.items : digest.items.slice(0, 20)).map((item, idx) => (
                <ToolFindText key={item.id || String(idx)} messageId={messageId} blockId={`tool-finding-${idx}`} text={item.title} style={styles.line} />
            ))}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 6,
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    line: {
        fontSize: 12,
        color: theme.colors.text.primary,
        fontFamily: 'Menlo',
    },
}));
