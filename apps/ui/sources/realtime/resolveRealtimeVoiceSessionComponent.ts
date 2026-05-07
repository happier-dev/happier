import type { ComponentType } from 'react';

import { captureExceptionIfEnabled } from '@/utils/system/sentry';

type RealtimeVoiceSessionModule = Readonly<{
    RealtimeVoiceSession?: ComponentType;
}>;

type RealtimeVoiceSessionModuleLoader = () => RealtimeVoiceSessionModule | undefined;

function loadRealtimeVoiceSessionModule(): RealtimeVoiceSessionModule | undefined {
    return require('./RealtimeVoiceSession') as RealtimeVoiceSessionModule | undefined;
}

export function resolveRealtimeVoiceSessionComponent(
    platform: 'native' | 'web',
    loadModule: RealtimeVoiceSessionModuleLoader = loadRealtimeVoiceSessionModule,
): ComponentType | null {
    try {
        const voiceSessionModule = loadModule();
        const RealtimeVoiceSession = voiceSessionModule?.RealtimeVoiceSession;
        return typeof RealtimeVoiceSession === 'function' ? RealtimeVoiceSession : null;
    } catch (error) {
        captureExceptionIfEnabled(error, {
            tags: {
                area: 'realtime_provider',
                platform,
            },
        });
        return null;
    }
}
