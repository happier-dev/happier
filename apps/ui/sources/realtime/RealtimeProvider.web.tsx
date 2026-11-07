import React from 'react';
import { VoiceSessionRuntimeHost } from '@/voice/session/VoiceSessionRuntimeHost';
import { VoiceSpeechModelCatalogRuntime } from '@/voice/session/VoiceSpeechModelCatalogRuntime';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    return (
        <>
            <VoiceSpeechModelCatalogRuntime />
            <VoiceSessionRuntimeHost />
            {children}
        </>
    );
};
