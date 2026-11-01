type Listener = (event: any) => void;

const STATE_KEY = Symbol.for('happier.vitest.expoSpeechRecognitionStub.state');

type ExpoSpeechRecognitionStubState = {
    recognitionAvailable: boolean;
    listeners: Map<string, Set<Listener>>;
    startImpl: ((params: any) => void) | null;
    stopImpl: (() => void) | null;
    abortImpl: (() => void) | null;
    requestPermissionsImpl: (() => Promise<{ granted: boolean }>) | null;
};

function getState(): ExpoSpeechRecognitionStubState {
    const g = globalThis as unknown as Record<symbol, ExpoSpeechRecognitionStubState | undefined>;
    if (!g[STATE_KEY]) {
        g[STATE_KEY] = {
            recognitionAvailable: true,
            listeners: new Map(),
            startImpl: null,
            stopImpl: null,
            abortImpl: null,
            requestPermissionsImpl: null,
        };
    }
    return g[STATE_KEY]!;
}

export const ExpoSpeechRecognitionModule = {
    addListener(eventName: string, cb: Listener) {
        const state = getState();
        const set = state.listeners.get(eventName) ?? new Set<Listener>();
        set.add(cb);
        state.listeners.set(eventName, set);
        return { remove: () => set.delete(cb) };
    },
    start(params: any) {
        getState().startImpl?.(params);
    },
    stop() {
        getState().stopImpl?.();
    },
    abort() {
        getState().abortImpl?.();
    },
    async requestPermissionsAsync() {
        const impl = getState().requestPermissionsImpl;
        if (impl) return await impl();
        return { granted: true };
    },
    isRecognitionAvailable() {
        return getState().recognitionAvailable;
    },
};

export default { ExpoSpeechRecognitionModule };

