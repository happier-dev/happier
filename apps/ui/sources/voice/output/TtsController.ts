import { createAttemptGuard } from '@/utils/timing/attemptGuard';

/**
 * Ordering envelope shared by every chunk in the ordered TTS playback queue.
 *
 * Keyed by `{ groupId, chunkIndex, isLastChunk }` (the ordered-queue
 * contract): chunks for one assistant turn share a `groupId`, are ordered by
 * `chunkIndex`, and the final chunk sets `isLastChunk`. Chunks may arrive out of
 * order; the controller buffers and advances only contiguously.
 *
 * The controller is payload-agnostic: it only reads the ordering keys. The
 * concrete payload is handed back, opaque, to `playChunk`/`confirmPlayback`.
 * `TPayload` defaults to the byte-oriented {@link TtsAudioChunkPayload} so the
 * pre-streaming byte contract keeps working unchanged, while the live
 * text-streaming path supplies a `{ text }` payload (see `sendVoiceTextTurn`).
 */
export type TtsChunkEnvelope = Readonly<{
    groupId: string;
    chunkIndex: number;
    isLastChunk: boolean;
}>;

/** Byte payload for chunks that already carry decoded/encoded audio. */
export type TtsAudioChunkPayload = Readonly<{
    bytes: ArrayBuffer;
    format: 'mp3' | 'wav';
}>;

export type TtsChunk<TPayload = TtsAudioChunkPayload> = TtsChunkEnvelope & TPayload;

/** @deprecated Prefer {@link TtsChunk}; retained for the byte-oriented callers. */
export type TtsAudioChunk = TtsChunk<TtsAudioChunkPayload>;

export type TtsSpeakHandle = Readonly<{
    /** Resolves when the queue drains (last chunk played) or is aborted. */
    done: Promise<void>;
    /** Stop playback for this speak generation; resolves `done`. */
    abort: () => void;
    /** Monotonic generation token for this speak() (latest-wins). */
    epoch: number;
}>;

export type TtsPlaybackControllerDeps<TPayload = TtsAudioChunkPayload> = Readonly<{
    /** Play a single chunk; resolves when its audio finishes (or is stopped). */
    playChunk: (chunk: TtsChunk<TPayload>) => Promise<void>;
    /** Optional per-chunk playback confirmation/ack (fire after playback). */
    confirmPlayback?: (chunk: TtsChunk<TPayload>) => Promise<void> | void;
    /** Optional notification when playback fails; the queue still advances. */
    onPlaybackError?: (chunk: TtsChunk<TPayload>, error: unknown) => Promise<void> | void;
    /** Optional terminal notification when remote playback confirmation fails. */
    onConfirmationError?: (chunk: TtsChunk<TPayload>, error: unknown) => Promise<void> | void;
    /** Bounded prefetch depth (how many chunks ahead to request). Default 2. */
    prefetchDepth?: number;
    /** Notified with the bounded count of chunks to prefetch. */
    onPrefetch?: (count: number) => void;
}>;

export type TtsPlaybackController<TPayload = TtsAudioChunkPayload> = Readonly<{
    /** Start a new speak generation; advances the epoch (latest-wins). */
    speak: () => TtsSpeakHandle;
    /** Enqueue an audio chunk against the current speak generation. */
    enqueue: (chunk: TtsChunk<TPayload>) => void;
}>;

type QueueGroup<TPayload> = {
    groupId: string;
    chunks: Map<number, TtsChunk<TPayload>>;
    nextChunkToPlay: number;
    finalChunkIndex: number | null;
    confirmedChunkKeys: Set<string>;
};

const DEFAULT_PREFETCH_DEPTH = 2;

function chunkKey(groupId: string, chunkIndex: number): string {
    return `${groupId}#${chunkIndex}`;
}

/**
 * Ordered, ack'd, back-pressured TTS playback queue.
 *
 * - Buffers out-of-order chunks per `groupId` and advances only on a contiguous
 *   `chunkIndex` run.
 * - Playback remains contiguous: the next ready chunk starts after local
 *   playback resolves, without waiting for remote confirmation RTT.
 * - Bounded prefetch (default ~2) requested via `onPrefetch`.
 * Epoch/latest-wins staleness is backed by the shared {@link createAttemptGuard}.
 */
export function createTtsPlaybackController<TPayload = TtsAudioChunkPayload>(
    deps: TtsPlaybackControllerDeps<TPayload>,
): TtsPlaybackController<TPayload> {
    const epochGuard = createAttemptGuard();
    const prefetchDepth = Math.max(1, deps.prefetchDepth ?? DEFAULT_PREFETCH_DEPTH);

    let activeEpoch = epochGuard.next();
    let group: QueueGroup<TPayload> | null = null;
    let processing = false;
    let aborted = false;
    let finished = false;
    let resolveDone: (() => void) | null = null;
    const pendingConfirmations = new Set<Promise<void>>();

    const settleDone = () => {
        if (finished) return;
        finished = true;
        const resolve = resolveDone;
        resolveDone = null;
        resolve?.();
    };

    const requestPrefetch = () => {
        if (!group) return;
        const buffered = group.chunks.size;
        const want = Math.max(0, prefetchDepth - buffered);
        deps.onPrefetch?.(Math.min(prefetchDepth, want === 0 ? prefetchDepth : want));
    };

    const groupIsFinished = (g: QueueGroup<TPayload>): boolean =>
        g.finalChunkIndex !== null && g.nextChunkToPlay > g.finalChunkIndex;

    const settleWhenConfirmationsComplete = (generation: number) => {
        if (pendingConfirmations.size === 0) {
            settleDone();
            return;
        }
        void Promise.allSettled([...pendingConfirmations]).then(() => {
            if (generation === activeEpoch && (aborted || group === null)) {
                settleDone();
            }
        });
    };

    const processQueue = async () => {
        if (processing) return;
        processing = true;
        const generation = activeEpoch;
        try {
            while (group && !aborted) {
                if (generation !== activeEpoch) return;

                const g = group;
                const nextChunk = g.chunks.get(g.nextChunkToPlay);
                if (!nextChunk) {
                    if (groupIsFinished(g)) {
                        group = null;
                        settleWhenConfirmationsComplete(generation);
                    }
                    // Otherwise wait for the contiguous chunk to arrive.
                    return;
                }

                g.chunks.delete(g.nextChunkToPlay);
                requestPrefetch();

                let playbackSucceeded = false;
                try {
                    await deps.playChunk(nextChunk);
                    playbackSucceeded = true;
                } catch (error) {
                    // Playback failure of one chunk must not wedge the queue.
                    try {
                        await deps.onPlaybackError?.(nextChunk, error);
                    } catch {
                        // Error reporting is best-effort.
                    }
                }

                if (aborted || generation !== activeEpoch) return;

                const key = chunkKey(nextChunk.groupId, nextChunk.chunkIndex);
                if (playbackSucceeded && !g.confirmedChunkKeys.has(key)) {
                    g.confirmedChunkKeys.add(key);
                    let confirmation: Promise<void>;
                    confirmation = Promise.resolve(deps.confirmPlayback?.(nextChunk))
                        .catch(async (error) => {
                            if (generation !== activeEpoch || aborted) return;
                            aborted = true;
                            group = null;
                            await deps.onConfirmationError?.(nextChunk, error);
                        })
                        .finally(() => {
                            pendingConfirmations.delete(confirmation);
                            if (generation === activeEpoch && (aborted || group === null)) {
                                settleWhenConfirmationsComplete(generation);
                            }
                        });
                    pendingConfirmations.add(confirmation);
                }

                if (aborted || generation !== activeEpoch) return;
                g.nextChunkToPlay += 1;
            }
        } finally {
            if (generation === activeEpoch) {
                processing = false;
                // An enqueue can race the narrow window after the loop observes
                // a missing contiguous chunk but before this flag is cleared.
                // That enqueue correctly sees `processing === true`; once the
                // owner is idle, re-check the queue so a terminal marker or the
                // next contiguous chunk cannot remain stranded forever.
                const pendingGroup = group;
                if (
                    pendingGroup
                    && !aborted
                    && (
                        pendingGroup.chunks.has(pendingGroup.nextChunkToPlay)
                        || groupIsFinished(pendingGroup)
                    )
                ) {
                    queueMicrotask(() => {
                        void processQueue();
                    });
                }
            }
        }
    };

    return {
        speak: () => {
            // Advance the generation: any in-flight chunks for the old epoch drop.
            settleDone();
            activeEpoch = epochGuard.next();
            aborted = false;
            finished = false;
            processing = false;
            pendingConfirmations.clear();
            group = null;
            const epoch = activeEpoch;
            const done = new Promise<void>((resolve) => {
                resolveDone = resolve;
            });
            requestPrefetch();
            // Initial prefetch request (no group yet → request the full depth).
            deps.onPrefetch?.(prefetchDepth);
            return {
                done,
                epoch,
                abort: () => {
                    if (!epochGuard.isCurrent(epoch)) return;
                    aborted = true;
                    group = null;
                    settleDone();
                },
            };
        },
        enqueue: (chunk) => {
            if (aborted || finished) return;
            if (!group) {
                group = {
                    groupId: chunk.groupId,
                    chunks: new Map(),
                    nextChunkToPlay: 0,
                    finalChunkIndex: null,
                    confirmedChunkKeys: new Set(),
                };
            }
            if (group.groupId !== chunk.groupId) {
                // A new turn's group: only adopt it once the current one retired.
                return;
            }
            group.chunks.set(chunk.chunkIndex, chunk);
            if (chunk.isLastChunk) {
                group.finalChunkIndex = chunk.chunkIndex;
            }
            void processQueue();
        },
    };
}
