import { segmentSentencesForSynthesis } from '@/voice/kokoro/runtime/segmentSentences';

export type KokoroSentenceChunk = Readonly<{ wavBytes: ArrayBuffer; sentenceText: string }>;

export type SynthesizeSentence = (sentence: string) => Promise<ArrayBuffer>;

/**
 * Guard a prefetched synthesis promise against leaking an unhandled rejection.
 *
 * The double-buffer keeps the NEXT sentence's synthesis in flight while the
 * consumer plays the current one. On barge-in/abort the consumer stops pulling
 * (or the loop rethrows) and that prefetched promise is abandoned without ever
 * being awaited; when it then rejects (e.g. `synthesizeKokoroWav`'s abort race)
 * it would surface as an unhandled promise rejection on the interrupt path.
 *
 * Attaching a no-op rejection handler at creation neutralises that: the returned
 * promise is the SAME instance, so a consumer that does await it still observes
 * the rejection, but an abandoned one can never go unhandled.
 */
export function guardAbandonedPrefetch<T>(promise: Promise<T> | null): Promise<T> | null {
    if (promise) {
        void promise.catch(() => {});
    }
    return promise;
}

/**
 * Drive incremental, double-buffered sentence synthesis.
 *
 * Segments `text` into sentences and synthesizes them one at a time, but keeps
 * the *next* sentence's synthesis in flight while the consumer is playing the
 * current one (prefetch depth 1 = double buffer). This overlaps the synth of
 * sentence `n+1` with playback of sentence `n`, so after the first sentence the
 * pipeline rarely stalls waiting for audio.
 *
 * The returned async iterable is pull-driven: each `for await` step yields the
 * already-synthesized current sentence and, before awaiting it, eagerly starts
 * synthesizing the following one. Aborts surface as a rejection.
 */
export function createSentenceStream(opts: Readonly<{
    text: string;
    synthesizeSentence: SynthesizeSentence;
    signal: AbortSignal;
}>): AsyncIterable<KokoroSentenceChunk> {
    const sentences = segmentSentencesForSynthesis(opts.text);

    return {
        async *[Symbol.asyncIterator]() {
            if (sentences.length === 0) {
                return;
            }

            const throwIfAborted = () => {
                if (opts.signal.aborted) {
                    throw new Error('aborted');
                }
            };

            const synthAt = (index: number): Promise<ArrayBuffer> | null => {
                if (index >= sentences.length) return null;
                // Guard every synth promise the moment it is created: the
                // double-buffer prefetch may abandon it on barge-in, and an
                // abandoned rejection must never leak as unhandled.
                return guardAbandonedPrefetch(opts.synthesizeSentence(sentences[index]));
            };

            throwIfAborted();
            // Prime the first synth, then keep one extra in flight (double-buffer).
            let current: Promise<ArrayBuffer> | null = synthAt(0);
            let next: Promise<ArrayBuffer> | null = opts.signal.aborted ? null : synthAt(1);

            for (let index = 0; index < sentences.length; index += 1) {
                throwIfAborted();
                const wavBytes = await (current as Promise<ArrayBuffer>);
                throwIfAborted();

                // Hand the current sentence to the consumer; the next sentence is
                // already (or about to be) synthesizing in the background.
                yield { wavBytes, sentenceText: sentences[index] };

                current = next;
                next = opts.signal.aborted ? null : synthAt(index + 2);
            }
        },
    };
}
