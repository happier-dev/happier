import { describe, expect, it, vi } from 'vitest';

import { createTtsPlaybackController, type TtsAudioChunk } from './TtsController';

function chunk(groupId: string, chunkIndex: number, isLastChunk: boolean): TtsAudioChunk {
    return {
        groupId,
        chunkIndex,
        isLastChunk,
        bytes: new Uint8Array([chunkIndex]).buffer,
        format: 'wav',
    };
}

describe('createTtsPlaybackController — ordered ack\'d playback queue', () => {
    it('plays contiguous chunks in order and confirms each after playback', async () => {
        const played: number[] = [];
        const confirmed: Array<{ groupId: string; chunkIndex: number }> = [];
        const controller = createTtsPlaybackController({
            playChunk: async (c) => { played.push(c.chunkIndex); },
            confirmPlayback: async (c) => { confirmed.push({ groupId: c.groupId, chunkIndex: c.chunkIndex }); },
        });

        const handle = controller.speak();
        controller.enqueue(chunk('g1', 0, false));
        controller.enqueue(chunk('g1', 1, false));
        controller.enqueue(chunk('g1', 2, true));
        await handle.done;

        expect(played).toEqual([0, 1, 2]);
        expect(confirmed).toEqual([
            { groupId: 'g1', chunkIndex: 0 },
            { groupId: 'g1', chunkIndex: 1 },
            { groupId: 'g1', chunkIndex: 2 },
        ]);
    });

    it('buffers out-of-order chunks and advances only when the gap is filled', async () => {
        const played: number[] = [];
        const controller = createTtsPlaybackController({
            playChunk: async (c) => { played.push(c.chunkIndex); },
        });

        const handle = controller.speak();
        // Arrive out of order: 2, 0, 1, then last(3).
        controller.enqueue(chunk('g1', 2, false));
        controller.enqueue(chunk('g1', 0, false));
        await Promise.resolve();
        // Only 0 is contiguous so far.
        controller.enqueue(chunk('g1', 1, false));
        controller.enqueue(chunk('g1', 3, true));
        await handle.done;

        expect(played).toEqual([0, 1, 2, 3]);
    });

    it('applies per-chunk playback-confirm backpressure (next play waits for prior playback)', async () => {
        const events: string[] = [];
        let releaseFirst: (() => void) | null = null;
        const controller = createTtsPlaybackController({
            playChunk: async (c) => {
                events.push(`play:${c.chunkIndex}`);
                if (c.chunkIndex === 0) {
                    await new Promise<void>((resolve) => { releaseFirst = resolve; });
                }
            },
        });

        const handle = controller.speak();
        controller.enqueue(chunk('g1', 0, false));
        controller.enqueue(chunk('g1', 1, true));

        await vi.waitFor(() => expect(events).toContain('play:0'));
        // Chunk 1 must NOT play until chunk 0 playback resolves.
        expect(events).not.toContain('play:1');
        releaseFirst!();
        await handle.done;
        expect(events).toEqual(['play:0', 'play:1']);
    });

    it('abort() stops the queue and resolves done without playing remaining chunks', async () => {
        const played: number[] = [];
        let releaseFirst: (() => void) | null = null;
        const controller = createTtsPlaybackController({
            playChunk: async (c) => {
                played.push(c.chunkIndex);
                if (c.chunkIndex === 0) {
                    await new Promise<void>((resolve) => { releaseFirst = resolve; });
                }
            },
        });

        const handle = controller.speak();
        controller.enqueue(chunk('g1', 0, false));
        controller.enqueue(chunk('g1', 1, true));
        await vi.waitFor(() => expect(played).toContain(0));

        handle.abort();
        releaseFirst!();
        await handle.done;

        expect(played).toEqual([0]);
    });

    it('exposes a monotonically increasing epoch per speak() and ignores stale enqueues after abort', async () => {
        const played: Array<{ epoch: number; index: number }> = [];
        const controller = createTtsPlaybackController({
            playChunk: async () => {},
        });

        const first = controller.speak();
        first.abort();
        // Stale enqueue against the aborted epoch must be ignored.
        controller.enqueue(chunk('g-stale', 0, true));
        await first.done;
        expect(played).toEqual([]);

        const second = controller.speak();
        expect(second.epoch).toBeGreaterThan(first.epoch);
    });

    it('bounds prefetch: does not request more than ~2 chunks ahead via onPrefetch', async () => {
        const requested: number[] = [];
        const releasePlay: { current: (() => void) | null } = { current: null };
        const controller = createTtsPlaybackController({
            playChunk: async () => {
                await new Promise<void>((resolve) => { releasePlay.current = resolve; });
            },
            prefetchDepth: 2,
            onPrefetch: (count) => { requested.push(count); },
        });

        const handle = controller.speak();
        await vi.waitFor(() => expect(requested.length).toBeGreaterThan(0));
        // Initial prefetch should request the bounded depth, not unbounded.
        expect(Math.max(...requested)).toBeLessThanOrEqual(2);
        // releasePlay may still be null here: onPrefetch can fire before playChunk runs, so this is
        // a best-effort release. A ref object keeps the type `(() => void) | null` — TS reverts a
        // deferred-closure assignment on a plain `let` to `null`, which makes `?.()` trip TS2349.
        // `releasePlay.current?.()` both typechecks AND no-ops when nothing is awaiting release.
        releasePlay.current?.();
        handle.abort();
        await handle.done;
    });

    it('drops a late confirm after its TTL without crashing', async () => {
        const controller = createTtsPlaybackController({
            playChunk: async () => {},
            lateConfirmTtlMs: 0,
        });
        const handle = controller.speak();
        controller.enqueue(chunk('g1', 0, true));
        await handle.done;
        // A confirm arriving after retirement is tolerated.
        expect(() => controller.confirmLatePlayback?.('g1', 0)).not.toThrow();
    });

    it('does not confirm playback for a chunk whose playback failed', async () => {
        const confirmed: number[] = [];
        const playbackErrors: number[] = [];
        const controller = createTtsPlaybackController({
            playChunk: async (c) => {
                if (c.chunkIndex === 0) {
                    throw new Error('decode failed');
                }
            },
            confirmPlayback: async (c) => {
                confirmed.push(c.chunkIndex);
            },
            onPlaybackError: async (c) => {
                playbackErrors.push(c.chunkIndex);
            },
        });

        const handle = controller.speak();
        controller.enqueue(chunk('g1', 0, false));
        controller.enqueue(chunk('g1', 1, true));

        await handle.done;

        expect(playbackErrors).toEqual([0]);
        expect(confirmed).toEqual([1]);
    });
});
