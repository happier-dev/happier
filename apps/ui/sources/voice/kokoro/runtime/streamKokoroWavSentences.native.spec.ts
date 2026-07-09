import { describe, expect, it, vi } from 'vitest';

import { segmentSentencesForSynthesis } from '@/voice/kokoro/runtime/segmentSentences';
import { createSentenceStream, guardAbandonedPrefetch } from '@/voice/kokoro/runtime/streamKokoroWavSentences';

describe('segmentSentencesForSynthesis', () => {
    it('splits prose into sentence-level segments on terminators', () => {
        expect(segmentSentencesForSynthesis('First sentence. Second one! Third?')).toEqual([
            'First sentence.',
            'Second one!',
            'Third?',
        ]);
    });

    it('does not split decimals or known abbreviations', () => {
        expect(segmentSentencesForSynthesis('Pi is 3.14 today. See e.g. the docs.')).toEqual([
            'Pi is 3.14 today.',
            'See e.g. the docs.',
        ]);
    });

    it('keeps a trailing fragment without a terminator', () => {
        expect(segmentSentencesForSynthesis('Done. trailing bit')).toEqual(['Done.', 'trailing bit']);
    });

    it('returns the whole text as one segment when there is no terminator', () => {
        expect(segmentSentencesForSynthesis('no terminator here')).toEqual(['no terminator here']);
    });

    it('ignores empty/whitespace-only input', () => {
        expect(segmentSentencesForSynthesis('   ')).toEqual([]);
    });
});

describe('createSentenceStream (incremental + double-buffer)', () => {
    it('yields one chunk per sentence, in order', async () => {
        const synth = vi.fn(async (sentence: string) => new TextEncoder().encode(sentence).buffer);
        const out: string[] = [];
        for await (const chunk of createSentenceStream({
            text: 'Alpha. Beta. Gamma.',
            synthesizeSentence: synth,
            signal: new AbortController().signal,
        })) {
            out.push(chunk.sentenceText);
            expect(chunk.wavBytes).toBeInstanceOf(ArrayBuffer);
        }
        expect(out).toEqual(['Alpha.', 'Beta.', 'Gamma.']);
        expect(synth).toHaveBeenCalledTimes(3);
    });

    it('prefetches the next sentence while the current one is being consumed (double-buffer)', async () => {
        const synthOrder: string[] = [];
        const consumeOrder: string[] = [];
        const synth = vi.fn(async (sentence: string) => {
            synthOrder.push(sentence);
            return new Uint8Array([sentence.length]).buffer;
        });

        const iterator = createSentenceStream({
            text: 'One. Two. Three.',
            synthesizeSentence: synth,
            signal: new AbortController().signal,
        })[Symbol.asyncIterator]();

        // Pull the first sentence. By the time it resolves, the stream should have
        // already started synthesizing the second (prefetch depth 1).
        const first = await iterator.next();
        consumeOrder.push((first.value as any).sentenceText);
        // Allow the prefetch microtask to schedule.
        await Promise.resolve();
        await Promise.resolve();
        expect(synthOrder).toContain('Two.');

        const second = await iterator.next();
        consumeOrder.push((second.value as any).sentenceText);
        const third = await iterator.next();
        consumeOrder.push((third.value as any).sentenceText);
        expect((await iterator.next()).done).toBe(true);

        expect(consumeOrder).toEqual(['One.', 'Two.', 'Three.']);
    });

    it('stops synthesizing once aborted and rejects', async () => {
        const controller = new AbortController();
        const synth = vi.fn(async (sentence: string) => {
            if (sentence.startsWith('Second')) controller.abort();
            return new Uint8Array([0]).buffer;
        });

        const seen: string[] = [];
        await expect((async () => {
            for await (const chunk of createSentenceStream({
                text: 'First sentence here. Second sentence here. Third one here. Fourth one here.',
                synthesizeSentence: synth,
                signal: controller.signal,
            })) {
                seen.push(chunk.sentenceText);
            }
        })()).rejects.toThrow(/aborted/i);

        // Must not have synthesized every sentence after the abort.
        expect(synth.mock.calls.length).toBeLessThan(4);
    });

});

describe('guardAbandonedPrefetch (L4-3 barge-in unhandled-rejection guard)', () => {
    // The double-buffer keeps the NEXT sentence's synthesis in flight while the
    // consumer plays the current one. On barge-in that prefetch is abandoned
    // without ever being awaited; when it later rejects (synthesizeKokoroWav's
    // abort race) it must NOT surface as an unhandled rejection. This is verified
    // at the guard seam directly: the async-generator path cannot reproduce the
    // leak under Vitest because the async-generator transform attaches its own
    // handlers to in-flight operands (native Hermes/RN does not), so the
    // chokepoint guard is the honestly testable contract.
    it('attaches a rejection handler synchronously while returning the same promise', async () => {
        let rejectionHandlerAttached = false;
        let rejectPrefetch: (error: Error) => void = () => {};
        const prefetch = new Promise<ArrayBuffer>((_resolve, reject) => {
            rejectPrefetch = reject;
        });
        const originalThen = prefetch.then.bind(prefetch);
        (prefetch as unknown as { then: PromiseLike<ArrayBuffer>['then'] }).then = ((
            onFulfilled?: any,
            onRejected?: any,
        ) => {
            if (typeof onRejected === 'function') {
                rejectionHandlerAttached = true;
            }
            return originalThen(onFulfilled, onRejected);
        }) as PromiseLike<ArrayBuffer>['then'];

        const guarded = guardAbandonedPrefetch(prefetch);

        // The guard attaches a rejection handler at creation (so an abandoned
        // prefetch cannot leak)...
        expect(rejectionHandlerAttached).toBe(true);
        // ...and returns the SAME promise so an awaiting consumer still observes
        // the rejection.
        expect(guarded).toBe(prefetch);

        rejectPrefetch(new Error('aborted'));
        await expect(guarded as Promise<ArrayBuffer>).rejects.toThrow(/aborted/i);
    });

    it('passes a null prefetch (end of stream) through unchanged', () => {
        expect(guardAbandonedPrefetch(null)).toBeNull();
    });
});
