type KokoroSynthesisOptions = {
    text: string;
    assetSetId?: string | null;
    voiceId: string;
    speed: number;
    timeoutMs: number;
    signal: AbortSignal;
};

type KokoroPrepareOptions = {
    assetSetId?: string | null;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress?: (progress: unknown) => void;
};

function createRemovedBrowserRuntimeError(): Error {
    return new Error('kokoro_web_runtime_removed');
}

// The web entrypoint is intentionally a dead-end sentinel now that browser Kokoro
// has been removed. Native bundles resolve `synthesizeKokoroWav.native.ts`; any
// import that resolves to this web file must fail closed instead of reviving a
// browser runtime path.
export async function synthesizeKokoroWav(_opts: KokoroSynthesisOptions): Promise<ArrayBuffer> {
    throw createRemovedBrowserRuntimeError();
}

export async function prepareKokoroTts(_opts: KokoroPrepareOptions): Promise<void> {
    throw createRemovedBrowserRuntimeError();
}

export function streamKokoroWavSentences(
    _opts: KokoroSynthesisOptions,
): AsyncIterable<{ wavBytes: ArrayBuffer; sentenceText: string }> {
    return {
        async *[Symbol.asyncIterator]() {
            throw createRemovedBrowserRuntimeError();
        },
    };
}
