import * as React from 'react';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { getToolViewComponent } from '@/components/tools/renderers/core/_registry';
import { StructuredResultView } from '@/components/tools/renderers/system/StructuredResultView';
import { knownTools } from '@/components/tools/catalog';
import { ToolHeaderActionsContext } from '@/components/tools/shell/presentation/ToolHeaderActionsContext';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import { ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '@/components/tools/normalization/parse/parseJson';
import { TextSelectabilityScope } from '@/components/ui/text/Text';
import { parseToolUseError } from '@/utils/errors/toolErrorParser';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { t } from '@/text';

type ToolInlineBodyMode = 'card' | 'timeline';

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
    setHeaderActions: (node: React.ReactNode | null) => void;
}) {
    const { tool, normalizedToolName } = props;

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

    const agentId = resolveAgentIdFromFlavor(props.metadata?.flavor);
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

    // When a permission is denied/canceled, the tool body often has no result payload.
    // Render an explicit status so the user understands why the tool did not run.
    if (tool.permission && (tool.permission.status === 'denied' || tool.permission.status === 'canceled')) {
        const canBlameReadOnlyMode = (() => {
            if (props.metadata?.permissionMode !== 'read-only') return false;
            const agentId = resolveAgentIdFromFlavor(props.metadata?.flavor);
            if (!agentId) return false;
            const core = getAgentCore(agentId);
            return core.permissions?.modeGroup === 'codexLike';
        })();
        const message =
            tool.permission.status === 'denied'
                ? canBlameReadOnlyMode
                    ? 'Denied by Read Only mode (write actions are denied).'
                    : t('errors.permissionDenied')
                : 'Permission canceled';
        return (
            <TextSelectabilityScope selectable>
                <ToolError message={message} />
            </TextSelectabilityScope>
        );
    }

    // Try to use a specific tool view component first
    const SpecificToolView = getToolViewComponent(normalizedToolName);
    if (SpecificToolView) {
        return (
            <TextSelectabilityScope selectable>
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
            </TextSelectabilityScope>
        );
    }

    // Minimal tools don't show default INPUT/OUTPUT blocks.
    if (minimal) {
        if (tool.result) {
            return (
                <StructuredResultView
                    tool={tool}
                    metadata={props.metadata}
                    messages={props.messages}
                    sessionId={props.sessionId}
                />
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
                <ToolError
                    message={
                        typeof tool.result === 'string'
                            ? tool.result
                            : JSON.stringify(tool.result, null, 2)
                    }
                />
            </TextSelectabilityScope>
        );
    }

    // Fall back to default view
    if (props.mode === 'timeline' && props.detailLevel === 'summary') {
        if (tool.input) {
            return (
                <TextSelectabilityScope selectable>
                    <ToolSectionView title={t('toolView.input')}>
                        <CodeView code={JSON.stringify(tool.input, null, 2)} />
                    </ToolSectionView>
                </TextSelectabilityScope>
            );
        }
        return null;
    }

    return (
        <TextSelectabilityScope selectable>
            {tool.input ? (
                <ToolSectionView title={t('toolView.input')}>
                    <CodeView code={JSON.stringify(tool.input, null, 2)} />
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
                    <CodeView
                        code={
                            typeof tool.result === 'string'
                                ? tool.result
                                : JSON.stringify(tool.result, null, 2)
                        }
                    />
                </ToolSectionView>
            ) : null}
        </TextSelectabilityScope>
    );
});
