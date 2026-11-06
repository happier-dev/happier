import * as React from 'react';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';

// The public hook reads context without loading a Voice presenter or starting an attempt.
export const PluginVoiceContext = React.createContext<VoiceAttemptControlProjection | null>(null);

export function usePluginVoiceAttempt() {
    return React.useContext(PluginVoiceContext)?.publicPresentation ?? null;
}
