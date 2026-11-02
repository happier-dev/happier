import React from 'react';
import { VoiceSessionRuntimeHost } from '@/voice/session/VoiceSessionRuntimeHost';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    return (
        <>
            <VoiceSessionRuntimeHost />
            {children}
        </>
    );
};
