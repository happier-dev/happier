import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import * as React from 'react';
import { Pressable } from 'react-native';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import {
    getToolViewComponent,
} from '@/components/tools/renderers/core/_registry';
import { StructuredResultView } from '@/components/tools/renderers/system/StructuredResultView';
import { knownTools } from '@/components/tools/catalog';
import { ToolHeaderActionsContext } from '@/components/tools/shell/presentation/ToolHeaderActionsContext';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import {
    ToolSectionSpacingProvider,
    ToolSectionView,
} from '@/components/tools/shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSetting } from '@/sync/domains/state/storage';
import { maybeParseJson } from '@/components/tools/normalization/parse/parseJson';
import { Text, TextSelectabilityScope } from '@/components/ui/text/Text';
import { parseToolUseError } from '@/utils/errors/toolErrorParser';
import {
    getAgentCore,
    } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { resolveToolPermissionTerminalErrorMessage } from '@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { useHistoricalTranscriptAgentId } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';

type ToolInlineBodyMode = 'card' | 'timeline';
type DisplayCode = Readonly<{
    code: string;
    truncated: boolean;
}>;

function serializeToolDisplayValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function clampToolDisplayCode(value: unknown, maxChars: number): DisplayCode {
    const code = serializeToolDisplayValue(value);
    if (code.length <= maxChars) return { code, truncated: false };
    return {
        code: `${code.slice(0, Math.max(0, maxChars))}\n...`,
        truncated: true,
    };
}

function ToolCodeViewWithClamp(props: Readonly<{
    value: unknown;
    maxChars: number;
    sourceId: string;
}>) {
    const [expanded, setExpanded] = React.useState(false);
    const rowLayoutMutation = useTranscriptRowLayoutMutation();
    const display = React.useMemo(
        () => clampToolDisplayCode(props.value, props.maxChars),
        [props.maxChars, props.value],
    );
    const fullCode = React.useMemo(() => serializeToolDisplayValue(props.value), [props.value]);
    const code = expanded ? fullCode : display.code;
    return (
        <>
            <CodeView code={code} />
            {display.truncated ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        rowLayoutMutation({
                            reason: expanded ? 'collapse' : 'expand',
                            sourceId: props.sourceId,
                        });
                        setExpanded(!expanded);
                    }}
                >
                    <Text>{expanded ? t('toolView.showLessContent') : t('toolView.showFullContent')}</Text>
                </Pressable>
            ) : null}
        </>
    );
}

export const ToolInlineBody = React.memo(function ToolInlineBody(props: {
    mode: ToolInlineBodyMode;
    tool: ToolCall;
    normalizedToolName: string;
    metadata: Metadata | null;
    messages: Message[];
    sessionId?: string;
    messageId?: string;
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    };
    detailLevel: 'summary' | 'full';
    sectionSpacing?: 'default' | 'compact';
    setHeaderActions: (node: React.ReactNode | null) => void;
}) {
    const { tool, normalizedToolName } = props;
    // A Session can change Agent without changing identity, so the row's own
    // Agent — not the Session's current one — owns how this body renders.
    const historicalAgentId = useHistoricalTranscriptAgentId();
    const sectionSpacing = props.sectionSpacing ?? 'default';
    const displayMaxBytesSetting = useSetting('filesDiffTokenizationMaxBytes');
    const displayMaxChars = typeof displayMaxBytesSetting === 'number' && Number.isFinite(displayMaxBytesSetting) && displayMaxBytesSetting > 0
        ? Math.trunc(displayMaxBytesSetting)
        : (settingsDefaults.filesDiffTokenizationMaxBytes as number);
    const headerActionsContextValue = React.useMemo(
        () => ({ setHeaderActions: props.setHeaderActions }),
        [props.setHeaderActions],
    );

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

    const agentId = historicalAgentId ?? resolveAgentIdFromSessionMetadata(props.metadata);
    const hideUnknownToolsByDefault = getAgentCore(agentId ?? '')?.toolRendering.hideUnknownToolsByDefault === true;
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
                    <ToolHeaderActionsContext.Provider value={headerActionsContextValue}>
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
                            <ToolCodeViewWithClamp
                                value={tool.input}
                                maxChars={displayMaxChars}
                                sourceId={`tool-code:${props.messageId ?? tool.id}:input`}
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
                        <ToolCodeViewWithClamp
                            value={tool.input}
                            maxChars={displayMaxChars}
                            sourceId={`tool-code:${props.messageId ?? tool.id}:input`}
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
                        <ToolCodeViewWithClamp
                            value={tool.result}
                            maxChars={displayMaxChars}
                            sourceId={`tool-code:${props.messageId ?? tool.id}:output`}
                        />
                    </ToolSectionView>
                ) : null}
            </ToolSectionSpacingProvider>
        </TextSelectabilityScope>
    );
});
