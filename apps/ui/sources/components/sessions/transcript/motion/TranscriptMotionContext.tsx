import * as React from 'react';

import type { TranscriptFreshnessGate } from './transcriptFreshnessGate';

export type TranscriptMotionPreset = 'off' | 'subtle' | 'full';

export type TranscriptMotionConfig = {
    preset: TranscriptMotionPreset;
    freshnessMs: number;
    animateNewItemsEnabled: boolean;
    animateToolExpandCollapseEnabled: boolean;
    animateToolExpandCollapseFreshOnly: boolean;
    animateThinkingEnabled: boolean;
};

export type TranscriptMotionRuntime = {
    gate: TranscriptFreshnessGate;
    config: TranscriptMotionConfig;
};

export const TranscriptMotionContext = React.createContext<TranscriptMotionRuntime | null>(null);

export function useTranscriptMotion(): TranscriptMotionRuntime | null {
    return React.useContext(TranscriptMotionContext);
}
