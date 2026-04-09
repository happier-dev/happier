import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

type Input = Readonly<{
    voiceProviderId: string;
    voiceStatus: string;
    onMicPress: (() => void) | undefined;
}>;

export type SessionViewMicButtonState = Readonly<{
    onMicPress: (() => void) | undefined;
    isMicActive: boolean;
}>;

const EMPTY_SESSION_VIEW_MIC_BUTTON_STATE: SessionViewMicButtonState = Object.freeze({
    onMicPress: undefined,
    isMicActive: false,
});

const SESSION_VIEW_MIC_BUTTON_STATE_CACHE = new LruMap<string, SessionViewMicButtonState>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

function buildCacheKey(input: Input): string {
    return JSON.stringify([
        input.voiceProviderId,
        input.voiceStatus,
    ]);
}

export function resolveSessionViewMicButtonState(input: Input): SessionViewMicButtonState {
    if (input.voiceProviderId === 'off' && input.voiceStatus === 'disconnected') {
        return EMPTY_SESSION_VIEW_MIC_BUTTON_STATE;
    }

    const cacheKey = buildCacheKey(input);
    const cached = SESSION_VIEW_MIC_BUTTON_STATE_CACHE.get(cacheKey);
    if (cached) {
        (cached as { onMicPress: (() => void) | undefined }).onMicPress = input.onMicPress;
        return cached;
    }

    const state: SessionViewMicButtonState = {
        onMicPress: input.onMicPress,
        isMicActive: input.voiceStatus !== 'disconnected',
    };
    SESSION_VIEW_MIC_BUTTON_STATE_CACHE.set(cacheKey, state);
    return state;
}
