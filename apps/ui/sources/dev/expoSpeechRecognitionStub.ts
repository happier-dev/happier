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

export function __resetExpoSpeechRecognitionStub(): void {
    const state = getState();
    state.recognitionAvailable = true;
    state.listeners.clear();
    state.startImpl = null;
    state.stopImpl = null;
    state.abortImpl = null;
    state.requestPermissionsImpl = null;
}

export function __setRecognitionAvailable(next: boolean): void {
    getState().recognitionAvailable = next;
}

export function __emitSpeechRecognitionEvent(eventName: string, event: any = {}): void {
    const set = getState().listeners.get(eventName);
    if (!set) return;
    for (const cb of set) cb(event);
}

export function __setExpoSpeechRecognitionImpls(next: {
    start?: ((params: any) => void) | null;
    stop?: (() => void) | null;
    abort?: (() => void) | null;
    requestPermissionsAsync?: (() => Promise<{ granted: boolean }>) | null;
}): void {
    const state = getState();
    if ('start' in next) state.startImpl = next.start ?? null;
    if ('stop' in next) state.stopImpl = next.stop ?? null;
    if ('abort' in next) state.abortImpl = next.abort ?? null;
    if ('requestPermissionsAsync' in next) state.requestPermissionsImpl = next.requestPermissionsAsync ?? null;
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

