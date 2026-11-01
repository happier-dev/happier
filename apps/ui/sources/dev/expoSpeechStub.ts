type SpeakOptions = Record<string, unknown> & {
    onDone?: () => void;
    onStopped?: () => void;
    onError?: (error: unknown) => void;
};

type SpeakImpl = (text: string, options?: SpeakOptions) => void;
type StopImpl = () => void;

const STATE_KEY = Symbol.for('happier.vitest.expoSpeechStub.state');

type ExpoSpeechStubState = {
    speakImpl: SpeakImpl | null;
    stopImpl: StopImpl | null;
};

function getState(): ExpoSpeechStubState {
    const g = globalThis as unknown as Record<symbol, ExpoSpeechStubState | undefined>;
    if (!g[STATE_KEY]) {
        g[STATE_KEY] = { speakImpl: null, stopImpl: null };
    }
    return g[STATE_KEY]!;
}

export function speak(text: string, options?: SpeakOptions): void {
    const impl = getState().speakImpl;
    impl?.(text, options);
}

export function stop(): void {
    const impl = getState().stopImpl;
    impl?.();
}

export default { speak, stop };

