type Input = Readonly<{
    voiceProviderId: string;
    voiceStatus: string;
    onMicPress: (() => void) | undefined;
}>;

export type SessionViewMicButtonState = Readonly<{
    onMicPress: (() => void) | undefined;
    isMicActive: boolean;
}>;

type CachedMicButtonStateEntry = {
    state: SessionViewMicButtonState;
};

const EMPTY_SESSION_VIEW_MIC_BUTTON_STATE: SessionViewMicButtonState = Object.freeze({
    onMicPress: undefined,
    isMicActive: false,
});

const SESSION_VIEW_MIC_BUTTON_STATE_CACHE = new Map<string, CachedMicButtonStateEntry>();

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
        (cached.state as { onMicPress: (() => void) | undefined }).onMicPress = input.onMicPress;
        return cached.state;
    }

    const entry: CachedMicButtonStateEntry = {
        state: {
            onMicPress: input.onMicPress,
            isMicActive: input.voiceStatus !== 'disconnected',
        },
    };
    SESSION_VIEW_MIC_BUTTON_STATE_CACHE.set(cacheKey, entry);
    return entry.state;
}
