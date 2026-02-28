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
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    };
    detailLevel: 'summary' | 'full';
    setHeaderActions: (node: React.ReactNode | null) => void;
}) {
    const { tool, normalizedToolName } = props;

    const knownTool = knownTools[normalizedToolName as keyof typeof knownTools] as any;

    const isToolUseError =
        tool.state === 'error' &&
        tool.result &&
        parseToolUseError(tool.result).isToolUseError;

    let minimal = false;
    let hideDefaultError = false;

    if (knownTool && typeof knownTool.hideDefaultError === 'boolean') {
        hideDefaultError = knownTool.hideDefaultError;
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
        return <ToolError message={message} />;
    }

    // Try to use a specific tool view component first
    const SpecificToolView = getToolViewComponent(normalizedToolName);
    if (SpecificToolView) {
        return (
            <>
                <ToolHeaderActionsContext.Provider value={{ setHeaderActions: props.setHeaderActions }}>
                    <SpecificToolView
                        tool={tool}
                        metadata={props.metadata}
                        messages={props.messages}
                        sessionId={props.sessionId}
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
            </>
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
        return (
            <ToolError
                message={
                    typeof tool.result === 'string'
                        ? tool.result
                        : JSON.stringify(tool.result, null, 2)
                }
            />
        );
    }

    // Fall back to default view
    if (props.mode === 'timeline' && props.detailLevel === 'summary') {
        if (tool.input) {
            return (
                <ToolSectionView title={t('toolView.input')}>
                    <CodeView code={JSON.stringify(tool.input, null, 2)} />
                </ToolSectionView>
            );
        }
        return null;
    }

    return (
        <>
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
        </>
    );
});
