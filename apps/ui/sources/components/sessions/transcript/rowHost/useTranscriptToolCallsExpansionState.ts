import * as React from 'react';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

export type ToolCallsGroupExpansionRequest = Readonly<{
    toolCallsGroupId: string;
    toolMessageIds: readonly string[];
    expanded: boolean;
}>;

/** One disclosure owner for the main and Chain transcript hosts. */
export function useTranscriptToolCallsExpansionState(params: Readonly<{
    showToolCalls?: boolean;
    prepareExpansionStateChange: (mutation: TranscriptRowLayoutMutation) => void;
}>) {
    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const showToolCalls = params.showToolCalls !== false;
    const previouslyShowedToolCalls = React.useRef(showToolCalls);
    React.useLayoutEffect(() => {
        const shouldCollapse = previouslyShowedToolCalls.current && !showToolCalls;
        previouslyShowedToolCalls.current = showToolCalls;
        if (!shouldCollapse || expandedToolCallsAnchorMessageIds.size === 0) return;
        params.prepareExpansionStateChange({ reason: 'collapse', sourceId: 'tool-calls-visibility' });
        setExpandedToolCallsAnchorMessageIds(new Set<string>());
    }, [expandedToolCallsAnchorMessageIds, params.prepareExpansionStateChange, showToolCalls]);
    const applyToolCallsGroupExpanded = React.useCallback((request: ToolCallsGroupExpansionRequest) => {
        setExpandedToolCallsAnchorMessageIds((prev) => {
            const next = new Set(prev);
            if (request.expanded) {
                const anchor = request.toolMessageIds.length > 0
                    ? request.toolMessageIds[request.toolMessageIds.length - 1] : null;
                if (typeof anchor === 'string' && anchor) next.add(anchor);
            } else {
                for (const id of request.toolMessageIds) next.delete(id);
            }
            return next;
        });
    }, []);
    const setToolCallsGroupExpanded = React.useCallback((request: ToolCallsGroupExpansionRequest) => {
        params.prepareExpansionStateChange({
            reason: request.expanded ? 'expand' : 'collapse',
            sourceId: request.toolCallsGroupId,
        });
        applyToolCallsGroupExpanded(request);
    }, [applyToolCallsGroupExpanded, params.prepareExpansionStateChange]);
    return { applyToolCallsGroupExpanded, expandedToolCallsAnchorMessageIds,
        setExpandedToolCallsAnchorMessageIds, setToolCallsGroupExpanded };
}
