import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { getToolViewComponent } from '@/components/tools/renderers/core/_registry';
import { StructuredResultView } from '@/components/tools/renderers/system/StructuredResultView';
import { knownTools } from '@/components/tools/catalog';
import { ToolHeaderActionsContext } from '@/components/tools/shell/presentation/ToolHeaderActionsContext';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import { ToolSectionSpacingProvider, ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '@/components/tools/normalization/parse/parseJson';
import { Text, TextSelectabilityScope } from '@/components/ui/text/Text';
import { parseToolUseError } from '@/utils/errors/toolErrorParser';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { resolveToolPermissionTerminalErrorMessage } from '@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage';
import { useSetting } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { useHistoricalTranscriptAgentId } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';

type ToolInlineBodyMode = 'card' | 'timeline';
type ToolPayloadKind = 'input' | 'output';

type ToolPayloadPreview = Readonly<{
    code: string;
    clamped: boolean;
}>;

function normalizePayloadDisplayBudget(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value));
    }
    const fallback = settingsDefaults.filesDiffTokenizationMaxBytes;
    return typeof fallback === 'number' && Number.isFinite(fallback)
        ? Math.max(0, Math.trunc(fallback))
        : 250_000;
}

function appendBounded(parts: string[], state: { length: number; clamped: boolean }, value: string, maxChars: number): void {
    if (state.clamped) return;
    if (maxChars <= 0 || state.length + value.length <= maxChars) {
        parts.push(value);
        state.length += value.length;
        return;
    }
    const remaining = Math.max(0, maxChars - state.length);
    if (remaining > 0) {
        parts.push(value.slice(0, remaining));
        state.length += remaining;
    }
    state.clamped = true;
}

function buildBoundedJsonPreview(value: unknown, maxChars: number): ToolPayloadPreview {
    const parts: string[] = [];
    const state = { length: 0, clamped: false };
    const seen = new WeakSet<object>();

    const write = (nextValue: unknown, depth: number): void => {
        if (state.clamped) return;
        if (nextValue == null || typeof nextValue === 'number' || typeof nextValue === 'boolean') {
            appendBounded(parts, state, JSON.stringify(nextValue), maxChars);
            return;
        }
        if (typeof nextValue === 'string') {
            appendBounded(parts, state, JSON.stringify(nextValue), maxChars);
            return;
        }
        if (typeof nextValue !== 'object') {
            appendBounded(parts, state, JSON.stringify(String(nextValue)), maxChars);
            return;
        }
        if (seen.has(nextValue)) {
            appendBounded(parts, state, JSON.stringify('[Circular]'), maxChars);
            return;
        }
        seen.add(nextValue);

        const indent = '  '.repeat(depth);
        const childIndent = '  '.repeat(depth + 1);
        if (Array.isArray(nextValue)) {
            appendBounded(parts, state, '[', maxChars);
            for (let index = 0; index < nextValue.length && !state.clamped; index++) {
                appendBounded(parts, state, `${index === 0 ? '\n' : ',\n'}${childIndent}`, maxChars);
                write(nextValue[index], depth + 1);
            }
            appendBounded(parts, state, nextValue.length > 0 ? `\n${indent}]` : ']', maxChars);
            return;
        }

        appendBounded(parts, state, '{', maxChars);
        let index = 0;
        for (const key in nextValue as Record<string, unknown>) {
            if (!Object.prototype.hasOwnProperty.call(nextValue, key)) continue;
            appendBounded(parts, state, `${index === 0 ? '\n' : ',\n'}${childIndent}${JSON.stringify(key)}: `, maxChars);
            write((nextValue as Record<string, unknown>)[key], depth + 1);
            index += 1;
            if (state.clamped) break;
        }
        appendBounded(parts, state, index > 0 ? `\n${indent}}` : '}', maxChars);
    };

    write(value, 0);
    return { code: parts.join(''), clamped: state.clamped };
}

function buildToolPayloadPreview(value: unknown, maxChars: number): ToolPayloadPreview {
    if (typeof value === 'string') {
        if (maxChars > 0 && value.length > maxChars) {
            return { code: value.slice(0, maxChars), clamped: true };
        }
        return { code: value, clamped: false };
    }
    if (maxChars <= 0) {
        return {
            code: JSON.stringify(value, null, 2),
            clamped: false,
        };
    }
    return buildBoundedJsonPreview(value, maxChars);
}

function buildFullToolPayloadCode(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const ToolPayloadCodeView = React.memo(function ToolPayloadCodeView(props: {
    value: unknown;
    maxChars: number;
    payloadKind: ToolPayloadKind;
}) {
    const [expanded, setExpanded] = React.useState(false);
    const preview = React.useMemo(
        () => buildToolPayloadPreview(props.value, props.maxChars),
        [props.maxChars, props.value],
    );
    const code = React.useMemo(
        () => expanded ? buildFullToolPayloadCode(props.value) : preview.code,
        [expanded, preview.code, props.value],
    );

    return (
        <View style={styles.payload}>
            <CodeView code={code} />
            {preview.clamped ? (
                <View style={styles.payloadClampFooter}>
                    <Text style={styles.payloadClampText}>
                        {t('toolView.payloadTruncated')}
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={expanded ? t('toolView.showLessPayload') : t('toolView.showFullPayload')}
                        hitSlop={8}
                        onPress={() => setExpanded((current) => !current)}
                        style={styles.payloadClampButton}
                        testID={`tool-inline-body-show-full-${props.payloadKind}`}
                    >
                        <Text style={styles.payloadClampButtonText}>
                            {expanded ? t('toolView.showLessPayload') : t('toolView.showFullPayload')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
});

export const ToolInlineBody = React.memo(function ToolInlineBody(props: {
    mode: ToolInlineBodyMode;
    tool: ToolCall;
    normalizedToolName: string;
    metadata: Metadata | null;
    messages: Message[];
    sessionId?: string;
    messageId?: string;
    interaction?: TranscriptInteraction;
    detailLevel: 'summary' | 'full';
    sectionSpacing?: 'default' | 'compact';
    setHeaderActions: (node: React.ReactNode | null) => void;
}) {
    const { tool, normalizedToolName } = props;
    // A Session can change Agent without changing identity, so the row's own
    // Agent — not the Session's current one — owns how this body renders.
    const historicalAgentId = useHistoricalTranscriptAgentId();
    const sectionSpacing = props.sectionSpacing ?? 'default';
    const toolPayloadDisplayMaxBytes = normalizePayloadDisplayBudget(useSetting('filesDiffTokenizationMaxBytes'));

    const isSubAgentRunLikeErrorResult = React.useMemo(() => {
        const parsed = maybeParseJson(tool.result);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const record = parsed as Record<string, unknown>;
        const hasRunId = typeof record.runId === 'string' && record.runId.trim().length > 0;
        const hasCallRef =
            (typeof record.callId === 'string' && record.callId.trim().length > 0) ||
            (typeof record.sidechainId === 'string' && record.sidechainId.trim().length > 0);
        const status = typeof record.status === 'string' ? record.status : null;
        const hasError = Boolean(record.error);
        return hasRunId && hasCallRef && (hasError || status === 'timeout' || status === 'failed');
    }, [tool.result]);

    const knownTool = knownTools[normalizedToolName as keyof typeof knownTools] as any;
    const isSubAgentRunTool = normalizedToolName === 'SubAgentRun' || tool.name === 'SubAgentRun';
    const shouldUseSubAgentRunErrorFallback = isSubAgentRunTool || isSubAgentRunLikeErrorResult;

    const isToolUseError =
        tool.state === 'error' &&
        tool.result &&
        parseToolUseError(tool.result).isToolUseError;

    let minimal = false;
    let hideDefaultError = false;

    if (knownTool && typeof knownTool.hideDefaultError === 'boolean') {
        hideDefaultError = knownTool.hideDefaultError;
    }
    if (shouldUseSubAgentRunErrorFallback) {
        hideDefaultError = true;
    }

    const agentId = historicalAgentId ?? resolveAgentIdFromFlavor(props.metadata?.flavor);
    const hideUnknownToolsByDefault = agentId ? getAgentCore(agentId).toolRendering.hideUnknownToolsByDefault : false;
    if (!knownTool && hideUnknownToolsByDefault) {
        minimal = true;
    }

    if (knownTool && knownTool.minimal !== undefined) {
        if (typeof knownTool.minimal === 'function') {
            minimal = knownTool.minimal({ tool, metadata: props.metadata, messages: props.messages });
        } else {
            minimal = knownTool.minimal;
        }
    }

    if (isToolUseError) {
        hideDefaultError = true;
        minimal = true;
    }

    const permissionTerminalErrorMessage = resolveToolPermissionTerminalErrorMessage({
        tool,
        metadata: props.metadata ?? null,
        permissionDisabledReason: props.interaction?.permissionDisabledReason,
        historicalAgentId,
    });
    if (permissionTerminalErrorMessage) {
        // When a permission is denied/canceled, the tool body often has no result payload.
        // Render an explicit status so the user understands why the tool did not run.
        return (
            <TextSelectabilityScope selectable>
                <ToolError message={permissionTerminalErrorMessage} />
            </TextSelectabilityScope>
        );
    }

    // Try to use a specific tool view component first
    const SpecificToolView = getToolViewComponent(normalizedToolName);
    if (SpecificToolView) {
        return (
            <TextSelectabilityScope selectable>
                <ToolSectionSpacingProvider spacing={sectionSpacing}>
                    <ToolHeaderActionsContext.Provider value={{ setHeaderActions: props.setHeaderActions }}>
                        <SpecificToolView
                            tool={tool}
                            metadata={props.metadata}
                            messages={props.messages}
                            sessionId={props.sessionId}
                            messageId={props.messageId}
                            detailLevel={props.detailLevel}
                            interaction={props.interaction}
                        />
                    </ToolHeaderActionsContext.Provider>
                    {tool.state === 'error' && tool.result && !hideDefaultError && (
                        <ToolError
                            message={
                                typeof tool.result === 'string'
                                    ? tool.result
                                    : JSON.stringify(tool.result, null, 2)
                            }
                        />
                    )}
                </ToolSectionSpacingProvider>
            </TextSelectabilityScope>
        );
    }

    // Minimal tools don't show default INPUT/OUTPUT blocks.
    if (minimal) {
        if (tool.result) {
            return (
                <ToolSectionSpacingProvider spacing={sectionSpacing}>
                    <StructuredResultView
                        tool={tool}
                        metadata={props.metadata}
                        messages={props.messages}
                        sessionId={props.sessionId}
                    />
                </ToolSectionSpacingProvider>
            );
        }
        return null;
    }

    // Show error state if present (not a tool-use error)
    if (tool.state === 'error' && tool.result && !isToolUseError) {
        if (shouldUseSubAgentRunErrorFallback) {
            return (
                <StructuredResultView
                    tool={{ ...tool, state: 'completed' }}
                    metadata={props.metadata}
                    messages={props.messages}
                    sessionId={props.sessionId}
                />
            );
        }
        return (
            <TextSelectabilityScope selectable>
                <ToolSectionSpacingProvider spacing={sectionSpacing}>
                    <ToolError
                        message={
                            typeof tool.result === 'string'
                                ? tool.result
                                : JSON.stringify(tool.result, null, 2)
                        }
                    />
                </ToolSectionSpacingProvider>
            </TextSelectabilityScope>
        );
    }

    // Fall back to default view
    if (props.mode === 'timeline' && props.detailLevel === 'summary') {
        if (tool.input) {
            return (
                <TextSelectabilityScope selectable>
                    <ToolSectionSpacingProvider spacing={sectionSpacing}>
                        <ToolSectionView title={t('toolView.input')}>
                            <ToolPayloadCodeView
                                value={tool.input}
                                maxChars={toolPayloadDisplayMaxBytes}
                                payloadKind="input"
                            />
                        </ToolSectionView>
                    </ToolSectionSpacingProvider>
                </TextSelectabilityScope>
            );
        }
        return null;
    }

    return (
        <TextSelectabilityScope selectable>
            <ToolSectionSpacingProvider spacing={sectionSpacing}>
                {tool.input ? (
                    <ToolSectionView title={t('toolView.input')}>
                        <ToolPayloadCodeView
                            value={tool.input}
                            maxChars={toolPayloadDisplayMaxBytes}
                            payloadKind="input"
                        />
                    </ToolSectionView>
                ) : null}
                {tool.state === 'running' && tool.result ? (
                    <StructuredResultView
                        tool={tool}
                        metadata={props.metadata}
                        messages={props.messages}
                        sessionId={props.sessionId}
                    />
                ) : null}
                {tool.state === 'completed' && tool.result ? (
                    <ToolSectionView title={t('toolView.output')}>
                        <ToolPayloadCodeView
                            value={tool.result}
                            maxChars={toolPayloadDisplayMaxBytes}
                            payloadKind="output"
                        />
                    </ToolSectionView>
                ) : null}
            </ToolSectionSpacingProvider>
        </TextSelectabilityScope>
    );
});

const styles = StyleSheet.create((theme) => ({
    payload: {
        gap: 8,
    },
    payloadClampFooter: {
        gap: 6,
        alignItems: 'flex-start',
    },
    payloadClampText: {
        color: theme.colors.text.secondary,
    },
    payloadClampButton: {
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
        backgroundColor: theme.colors.surface.pressed,
    },
    payloadClampButtonText: {
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
}));
