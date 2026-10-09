import * as React from 'react';
import { Platform } from 'react-native';
import { useSetting } from '@/sync/domains/state/storage';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { useTranscriptToolCallsExpansionState } from './useTranscriptToolCallsExpansionState';

export function useTranscriptExpansionState(params: Readonly<{
    showToolCalls?: boolean;
    recordLocalTranscriptInteractionIntent: () => void;
    prepareLocalHeightChange: (mutation: TranscriptRowLayoutMutation) => 'anchor' | 'bottom' | 'none';
}>) {
    const {
        recordLocalTranscriptInteractionIntent,
        prepareLocalHeightChange,
    } = params;
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
        () => new Map<string, boolean>(),
    );

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
            recordLocalTranscriptInteractionIntent();
        }
    }, [prepareLocalHeightChange, recordLocalTranscriptInteractionIntent]);

    const toolCallsExpansion = useTranscriptToolCallsExpansionState({
        showToolCalls: params.showToolCalls,
        prepareExpansionStateChange,
    });

    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) === expanded) return;
        prepareExpansionStateChange({
            reason: expanded ? 'expand' : 'collapse',
            sourceId: messageId,
        });
        applyThinkingExpanded(messageId, expanded);
    }, [applyThinkingExpanded, prepareExpansionStateChange, resolveThinkingExpanded]);

    return {
        ...toolCallsExpansion,
        resolveThinkingExpanded,
        setThinkingExpanded,
    };
}
