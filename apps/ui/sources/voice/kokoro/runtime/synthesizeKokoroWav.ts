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

// NOTE: This `.ts` file is the non-platform fallback used by Vitest/Node module
// resolution. The web bundle should resolve `synthesizeKokoroWav.web.ts`, while
// native bundles resolve `synthesizeKokoroWav.native.ts`.
//
// Keep this as a fail-closed sentinel so non-native execution can never revive a
// browser Kokoro runtime path.
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
