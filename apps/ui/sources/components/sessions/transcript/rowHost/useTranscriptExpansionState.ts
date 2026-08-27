import * as React from 'react';
import { Platform } from 'react-native';
import { useSetting } from '@/sync/domains/state/storage';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

export function useTranscriptExpansionState(params: Readonly<{
    deferAutoPinAfterLocalTranscriptInteraction: () => void;
    prepareLocalHeightChange: (mutation: TranscriptRowLayoutMutation) => 'anchor' | 'bottom' | 'none';
}>) {
    const {
        deferAutoPinAfterLocalTranscriptInteraction,
        prepareLocalHeightChange,
    } = params;
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
        () => new Map<string, boolean>(),
    );

    const applyToolCallsGroupExpanded = React.useCallback((request: {
        toolCallsGroupId: string;
        toolMessageIds: readonly string[];
        expanded: boolean;
    }) => {
        setExpandedToolCallsAnchorMessageIds((prev) => {
            const next = new Set(prev);
            if (request.expanded) {
                const toolMessageIds = request.toolMessageIds;
                const anchor = toolMessageIds.length > 0 ? toolMessageIds[toolMessageIds.length - 1] : null;
                if (typeof anchor === 'string' && anchor) {
                    next.add(anchor);
                }
            } else {
                for (const id of request.toolMessageIds) {
                    next.delete(id);
                }
            }
            return next;
        });
    }, []);

    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);

    const applyThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        setThinkingExpandedByMessageId((prev) => {
            const prevValue = prev.get(messageId);
            if (prevValue === expanded) return prev;
            const next = new Map(prev);
            if (expanded === thinkingDefaultExpanded) {
                next.delete(messageId);
            } else {
                next.set(messageId, expanded);
            }
            return next;
        });
    }, [thinkingDefaultExpanded]);

    const prepareExpansionStateChange = React.useCallback((mutation: TranscriptRowLayoutMutation) => {
        const heightPolicy = prepareLocalHeightChange(mutation);
        if (Platform.OS !== 'web' || heightPolicy !== 'bottom') {
            deferAutoPinAfterLocalTranscriptInteraction();
        }
    }, [deferAutoPinAfterLocalTranscriptInteraction, prepareLocalHeightChange]);

    const setToolCallsGroupExpanded = React.useCallback((request: {
        toolCallsGroupId: string;
        toolMessageIds: readonly string[];
        expanded: boolean;
    }) => {
        prepareExpansionStateChange({
            reason: request.expanded ? 'expand' : 'collapse',
            sourceId: request.toolCallsGroupId,
        });
        applyToolCallsGroupExpanded(request);
    }, [applyToolCallsGroupExpanded, prepareExpansionStateChange]);

    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) === expanded) return;
        prepareExpansionStateChange({
            reason: expanded ? 'expand' : 'collapse',
            sourceId: messageId,
        });
        applyThinkingExpanded(messageId, expanded);
    }, [applyThinkingExpanded, prepareExpansionStateChange, resolveThinkingExpanded]);

    return {
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        thinkingExpandedByMessageId,
        resolveThinkingExpanded,
        setExpandedToolCallsAnchorMessageIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
    };
}
