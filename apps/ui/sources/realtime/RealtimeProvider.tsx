import React from 'react';
import { ElevenLabsProvider } from "@elevenlabs/react-native";
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { VoiceSessionRuntime } from '@/voice/session/VoiceSessionRuntime';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    return (
        <ElevenLabsProvider>
            <RealtimeVoiceSession />
            <VoiceSessionRuntime />
            {children}
        </ElevenLabsProvider>
    );
};
