import React from 'react';
import { VoiceSessionRuntime } from '@/voice/session/VoiceSessionRuntime';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    return (
        <>
            <VoiceSessionRuntime />
            {children}
        </>
    );
};
