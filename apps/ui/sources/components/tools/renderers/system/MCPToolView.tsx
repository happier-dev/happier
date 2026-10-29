import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { readTranscriptProjectCommandCall } from '@/components/sessions/transcript/references/transcriptProjectCommandReference';
import { ProjectCommandToolBody } from './ProjectCommandToolBody';
import { readTranscriptMachineResourcesCall } from '@/components/sessions/transcript/references/transcriptMachineResourcesReference';
import { MachineResourcesToolBody } from './MachineResourcesToolBody';
import { type ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { readHappierActionCallId, readHappierActionCallInput } from '@/components/sessions/transcript/references/happierActionToolResult';
import { presentActionApproval } from '@/components/approvals/actionApprovalPresentation';
import { resolveActionTitle } from '@/text/actionTitles';
import { Typography } from '@/constants/Typography';
import { resolveToolActionFailure, type ToolActionFailurePresentation } from '@/components/tools/shell/presentation/resolveToolActionFailure';


import { resolveMcpToolTitle } from '@happier-dev/session-core/tools';

export function formatMCPTitle(toolName: string, mcpTool?: ResolvedMcpToolIdentityV1, input?: unknown): string {
    const actionId = readHappierActionCallId(toolName, input);
    return resolveMcpToolTitle(toolName, mcpTool, actionId ? resolveActionTitle(actionId, getActionSpec(actionId)) : null);
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function stringifyShort(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function readDisplaySubtitle(inputObj: UnknownRecord): string | null {
    const display = asRecord(asRecord(inputObj._mcp)?.display);
    return typeof display?.subtitle === 'string' && display.subtitle.trim() ? display.subtitle.trim() : null;
}

/**
 * The row's one line under its title. A Happier Action says what it does through the Action's own
 * presentation (the one confirmation and Inbox read), never as its raw `actionId=… input={…}`; when that
 * only repeats the title, the row has no second line. The recorded `_mcp.display.subtitle` is the CLI
 * normalizer's generic key=value line for every MCP call, so it never speaks for an Action.
 */
export function formatMCPToolSubtitle(toolName: string, input: unknown): string {
    const actionId = readHappierActionCallId(toolName, input);
    if (!actionId) return formatMCPSubtitle(input);
    return presentActionApproval({ actionId, actionArgs: readHappierActionCallInput(toolName, input) }).summary ?? '';
}

export function formatMCPSubtitle(input: unknown): string {
    const inputObj = asRecord(maybeParseJson(input)) ?? {};
    const displaySubtitle = readDisplaySubtitle(inputObj);
    if (displaySubtitle) return displaySubtitle;

    const titleCandidate = typeof inputObj.title === 'string' ? inputObj.title : null;
    if (typeof titleCandidate === 'string' && titleCandidate.trim()) return truncate(titleCandidate.trim(), 140);

    const pathCandidate =
        typeof inputObj.path === 'string'
            ? inputObj.path
            : typeof inputObj.file_path === 'string'
                ? inputObj.file_path
                : typeof inputObj.filePath === 'string'
                    ? inputObj.filePath
                    : null;
    if (typeof pathCandidate === 'string' && pathCandidate.trim()) return truncate(pathCandidate.trim(), 140);

    const urlCandidate = typeof inputObj.url === 'string' ? inputObj.url : null;
    if (typeof urlCandidate === 'string' && urlCandidate.trim()) return truncate(urlCandidate.trim(), 140);

    const queryCandidate = typeof inputObj.query === 'string' ? inputObj.query : null;
    if (typeof queryCandidate === 'string' && queryCandidate.trim()) return truncate(queryCandidate.trim(), 140);

    const keys = Object.keys(inputObj).filter((k) => !k.startsWith('_')).slice(0, 3);
    if (keys.length === 0) return '';
    const parts = keys.map((k) => `${k}=${truncate(stringifyShort(inputObj[k]), 60)}`);
    return truncate(parts.join(' '), 140);
}

function getResultText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (!obj) return typeof parsed === 'string' ? parsed : null;
    const candidates = [obj.text, obj.message, obj.result, obj.output];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
    }
    return null;
}

function getMCPDisplay(tool: ToolViewProps['tool']) {
    return {
        title: formatMCPTitle(tool.name, undefined, tool.input),
        subtitle: formatMCPToolSubtitle(tool.name, tool.input),
        input: JSON.stringify(maybeParseJson(tool.input), null, 2) ?? '',
        output: JSON.stringify(maybeParseJson(tool.result), null, 2) ?? '',
        resultText: getResultText(tool.result),
    };
}

export const projectMCPDisplayText: ToolDisplayTextProjector = (tool) => {
    const display = getMCPDisplay(tool);
    return [
        ...toolTextBlock('tool-body-title', display.title),
        ...toolTextBlock('tool-body-subtitle', display.subtitle),
        ...toolTextBlock('tool-input-label', t('toolView.input')),
        ...toolTextBlock('tool-input', display.input),
        ...toolTextBlock('tool-output-preview', tool.state === 'completed' ? display.resultText : null),
        ...toolTextBlock('tool-output-label', tool.state === 'completed' && tool.result != null ? t('toolView.output') : null),
        ...toolTextBlock('tool-output', tool.state === 'completed' && tool.result != null ? display.output : null),
    ];
};

/** The typed code of a refused or failed Action call as a quiet fact; the outcome and cause already read on its header. */
function ActionFailureCode({ failure }: Readonly<{ failure: ToolActionFailurePresentation }>) {
    return (
        <Text testID="mcp-tool-action-failure" style={styles.failureCode} selectable>
            {failure.cause ? `${failure.code} · ${failure.cause}` : failure.code}
        </Text>
    );
}

export const MCPToolView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId, serverId }) => {
    const find = useToolFindState(messageId);
    if (detailLevel === 'title') return null;

    const { title, subtitle, resultText, input, output } = getMCPDisplay(tool);
    const actionFailure = resolveToolActionFailure(tool);
    const projectCommandCall = readTranscriptProjectCommandCall(tool);
    const machineResourcesCall = projectCommandCall ? null : readTranscriptMachineResourcesCall(tool);

    if (detailLevel === 'summary' && !find.active) {
        // The row header already says what the call is (title and line); the body adds only its outcome.
        const outcome = actionFailure
            ? <ActionFailureCode failure={actionFailure} />
            : tool.state === 'completed' && resultText ? <CodeView code={truncate(resultText, 800)} /> : null;
        const summary = outcome ? (
            <ToolSectionView>
                <View style={styles.container}>{outcome}</View>
            </ToolSectionView>
        ) : null;
        // An agent's finite Project command shows its run's output, not the acknowledgement JSON.
        if (machineResourcesCall) return <MachineResourcesToolBody call={machineResourcesCall} serverId={serverId} />;
        return projectCommandCall
            ? <ProjectCommandToolBody tool={tool} call={projectCommandCall} serverId={serverId} fallback={summary} />
            : summary;
    }

    // Full view: show raw-ish input + output (ToolFullView already provides debug toggles).
    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <ToolFindText style={styles.title} numberOfLines={2} text={title} blockId="tool-body-title" messageId={messageId} />
                {subtitle ? (
                    <ToolFindText style={styles.subtitle} numberOfLines={3} text={subtitle} blockId="tool-body-subtitle" messageId={messageId} />
                ) : null}
                <View style={styles.section}>
                    <ToolFindText style={styles.sectionTitle} text={t('toolView.input')} blockId="tool-input-label" messageId={messageId} />
                    <CodeView code={input} findRanges={find.ranges('tool-input')} />
                </View>
                {tool.state === 'completed' && tool.result != null ? (
                    <View style={styles.section}>
                        <ToolFindText style={styles.sectionTitle} text={t('toolView.output')} blockId="tool-output-label" messageId={messageId} />
                        {find.active && resultText ? <CodeView code={resultText} findRanges={find.ranges('tool-output-preview')} /> : null}
                        <CodeView code={output} findRanges={find.ranges('tool-output')} />
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: theme.space.s12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: theme.space.s10,
    },
    title: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    subtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    section: {
        gap: theme.space.s6,
    },
    failureCode: {
        color: theme.colors.text.tertiary,
        ...Typography.variant('meta'),
        ...Typography.mono(),
    },
    sectionTitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));
