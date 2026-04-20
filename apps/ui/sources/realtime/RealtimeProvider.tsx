import React from 'react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { VoiceSessionRuntime } from '@/voice/session/VoiceSessionRuntime';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    return (
        <>
            <RealtimeVoiceSession />
            <VoiceSessionRuntime />
            {children}
        </>
    );
};
