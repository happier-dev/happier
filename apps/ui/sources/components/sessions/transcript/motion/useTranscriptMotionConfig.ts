import * as React from 'react';
import { useSetting } from '@/sync/domains/state/storage';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveTranscriptMotionConfig } from '@/components/sessions/transcript/motion/resolveTranscriptMotionConfig';

export function useTranscriptMotionConfig() {
    const transcriptMotionPreset = useSetting('transcriptMotionPreset');
    const transcriptMotionFreshnessMs = useSetting('transcriptMotionFreshnessMs');
    const transcriptAnimateNewItemsEnabled = useSetting('transcriptAnimateNewItemsEnabled');
    const transcriptAnimateToolExpandCollapseEnabled = useSetting('transcriptAnimateToolExpandCollapseEnabled');
    const transcriptAnimateToolExpandCollapseFreshOnly = useSetting('transcriptAnimateToolExpandCollapseFreshOnly');
    const transcriptAnimateThinkingEnabled = useSetting('transcriptAnimateThinkingEnabled');
    const reducedMotionPreferred = useReducedMotionPreference();
    const motionConfig = React.useMemo(() => {
        return resolveTranscriptMotionConfig({
            reducedMotionPreferred,
            transcriptMotionPreset,
            transcriptMotionFreshnessMs,
            transcriptAnimateNewItemsEnabled,
            transcriptAnimateToolExpandCollapseEnabled,
            transcriptAnimateToolExpandCollapseFreshOnly,
            transcriptAnimateThinkingEnabled,
        });
    }, [
        reducedMotionPreferred,
        transcriptAnimateNewItemsEnabled,
        transcriptAnimateThinkingEnabled,
        transcriptAnimateToolExpandCollapseEnabled,
        transcriptAnimateToolExpandCollapseFreshOnly,
        transcriptMotionFreshnessMs,
        transcriptMotionPreset,
    ]);

    return {
        motionConfig,
        reducedMotionPreferred,
    };
}
