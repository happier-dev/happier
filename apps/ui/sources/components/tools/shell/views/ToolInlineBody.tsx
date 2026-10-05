import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import * as React from 'react';
import { Pressable } from 'react-native';

import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Metadata } from '@happier-dev/session-core/state';

import {
    getToolViewComponent,
} from '@/components/tools/renderers/core/_registry';
import { StructuredResultView } from '@/components/tools/renderers/system/StructuredResultView';
import { knownTools } from '@/components/tools/catalog';
import type { KnownToolDefinition } from '@/components/tools/catalog/_types';
import { ToolHeaderActionsContext } from '@/components/tools/shell/presentation/ToolHeaderActionsContext';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import {
    ToolSectionSpacingProvider,
    ToolSectionView,
} from '@/components/tools/shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSetting } from '@/sync/domains/state/storage';
import { Text, TextSelectabilityScope } from '@/components/ui/text/Text';
import { parseToolUseError } from '@/utils/errors/toolErrorParser';
import {
    getAgentCore,
    } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { isSubAgentRunErrorResult, resolveToolInlineErrorDisplay } from '@/components/tools/shell/presentation/resolveToolInlineErrorDisplay';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { useHistoricalTranscriptAgentId } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import type { ExecutionRunPromptResponseTarget } from '@/components/tools/shell/permissions/executionRunPromptResponseTarget';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { useTranscriptFindRow } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { sliceFindRanges } from '@/components/ui/text/FindHighlightedText';

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

export function ToolCodeViewWithClamp(props: Readonly<{
    value: unknown;
    maxChars: number;
    sourceId: string;
    messageId?: string;
    blockId?: string;
}>) {
    const [expanded, setExpanded] = React.useState(false);
    const find = useTranscriptFindRow(props.messageId);
    const ranges = find?.blocks.find((block) => block.id === props.blockId)?.sourceRanges;
    const reveal = find?.reveal;
    const revealId = reveal && reveal.blockId === props.blockId ? reveal.requestId : undefined;
    const rowLayoutMutation = useTranscriptRowLayoutMutation();
    React.useEffect(() => {
        if (revealId === undefined) return;
        rowLayoutMutation({ reason: 'expand', sourceId: props.sourceId });
        setExpanded(true);
    }, [props.sourceId, revealId, rowLayoutMutation]);
    const display = React.useMemo(
        () => clampToolDisplayCode(props.value, props.maxChars),
        [props.maxChars, props.value],
    );
    const fullCode = React.useMemo(() => serializeToolDisplayValue(props.value), [props.value]);
    const code = expanded ? fullCode : display.code;
    return (
        <>
            <CodeView code={code} findRanges={sliceFindRanges(ranges, 0, expanded || !display.truncated ? fullCode.length : props.maxChars)} />
            {display.truncated ? (
                <Pressable
                    testID={`tool-code-clamp:${props.sourceId}`}
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
    serverId?: string;
    session?: Session;
    messageId?: string;
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: TranscriptPermissionDisabledReason;
    };
    findBodyBlockId?: string;
    detailLevel: 'summary' | 'full';
    executionRun?: ExecutionRunPromptResponseTarget;
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

    const isSubAgentRunLikeErrorResult = React.useMemo(() => isSubAgentRunErrorResult(tool.result), [tool.result]);

    const knownTool: KnownToolDefinition | undefined = knownTools[normalizedToolName as keyof typeof knownTools];
    const isSubAgentRunTool = normalizedToolName === 'SubAgentRun' || tool.name === 'SubAgentRun';
    const shouldUseSubAgentRunErrorFallback = isSubAgentRunTool || isSubAgentRunLikeErrorResult;

    const isToolUseError =
        tool.state === 'error' &&
        tool.result &&
        parseToolUseError(tool.result).isToolUseError;

    let minimal = false;

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
        minimal = true;
    }

    const errorDisplay = resolveToolInlineErrorDisplay({
        tool,
        normalizedToolName,
        metadata: props.metadata ?? null,
        permissionDisabledReason: props.interaction?.permissionDisabledReason,
        historicalAgentId,
    });
    if (errorDisplay.override) {
        // When a permission is denied/canceled, the tool body often has no result payload.
        // Render an explicit status so the user understands why the tool did not run.
        return (
            <TextSelectabilityScope selectable>
                <ToolError message={errorDisplay.override} messageId={props.messageId} blockId="tool-error-override" />
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
                            serverId={props.serverId}
                            session={props.session}
                            messageId={props.messageId}
                            findBodyBlockId={props.findBodyBlockId}
                            detailLevel={props.detailLevel}
                            interaction={props.interaction}
                            executionRun={props.executionRun}
                        />
                    </ToolHeaderActionsContext.Provider>
                    {errorDisplay.append && (
                        <ToolError
                            message={errorDisplay.append}
                            messageId={props.messageId}
                            blockId="tool-error-append"
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
                        serverId={props.serverId}
                        session={props.session}
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
                    serverId={props.serverId}
                    session={props.session}
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
                        messageId={props.messageId}
                        blockId="tool-error-append"
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
                                messageId={props.messageId}
                                blockId="tool-input"
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
                            messageId={props.messageId}
                            blockId="tool-input"
                        />
                    </ToolSectionView>
                ) : null}
                {tool.state === 'running' && tool.result ? (
                    <StructuredResultView
                        tool={tool}
                        metadata={props.metadata}
                        messages={props.messages}
                        sessionId={props.sessionId}
                        serverId={props.serverId}
                        session={props.session}
                    />
                ) : null}
                {tool.state === 'completed' && tool.result ? (
                    <ToolSectionView title={t('toolView.output')}>
                        <ToolCodeViewWithClamp
                            value={tool.result}
                            maxChars={displayMaxChars}
                            sourceId={`tool-code:${props.messageId ?? tool.id}:output`}
                            messageId={props.messageId}
                            blockId="tool-output"
                        />
                    </ToolSectionView>
                ) : null}
            </ToolSectionSpacingProvider>
        </TextSelectabilityScope>
    );
});
