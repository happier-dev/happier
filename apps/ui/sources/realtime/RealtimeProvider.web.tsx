import React from 'react';
import { VoiceSessionRuntime } from '@/voice/session/VoiceSessionRuntime';
import { resolveRealtimeVoiceSessionComponent } from './resolveRealtimeVoiceSessionComponent';

const ResolvedRealtimeVoiceSession = resolveRealtimeVoiceSessionComponent('web');

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    return (
        <>
            {ResolvedRealtimeVoiceSession ? <ResolvedRealtimeVoiceSession /> : null}
            <VoiceSessionRuntime />
            {children}
        </>
    );
};
