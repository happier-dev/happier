import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    disposeTranscriptViewportElementObservers,
    ensureTranscriptViewportElementObservers,
    isTranscriptViewportDiagnosticsEnabled,
    observeTranscriptPhysicalScrollMethods,
    readTranscriptPhysicalWriteCensus,
    recordTranscriptHeldIntentLifecycle,
    recordTranscriptScrollSample,
    recordTranscriptViewportWrite,
    resetTranscriptViewportDiagnosticsForTests,
} from './transcriptViewportWriteDiagnostics';

/** A scroller stand-in whose `scrollTo` actually moves, so a missed write is observable. */
function scrollerStub(id: string, clientWidth: number) {
    return {
        clientHeight: 600,
        clientWidth,
        id,
        scrollHeight: 12_000,
        scrollTop: 0,
        getAttribute: () => null,
        scrollBy(optionsOrX: ScrollToOptions | number, y?: number) {
            this.scrollTop += typeof optionsOrX === 'number' ? (y ?? 0) : (optionsOrX.top ?? 0);
        },
        scrollTo(optionsOrX: ScrollToOptions | number, y?: number) {
            this.scrollTop = typeof optionsOrX === 'number'
                ? (y ?? 0)
                : (optionsOrX.top ?? this.scrollTop);
        },
    };
}

describe('transcriptViewportWriteDiagnostics', () => {
    afterEach(() => {
        resetTranscriptViewportDiagnosticsForTests();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('is a no-op when the debug flag is off', () => {
        vi.stubGlobal('localStorage', { getItem: () => null });
        expect(isTranscriptViewportDiagnosticsEnabled()).toBe(false);
        recordTranscriptViewportWrite({
            landedScrollHeight: 1000,
            landedScrollTop: 500,
            preWriteScrollTop: 100,
            targetScrollTop: 500,
        });
        expect((globalThis as Record<string, unknown>).__happierViewportDiagnostics).toBeUndefined();
    });

    it('records writes with delta and stack when enabled, warning on large jumps', () => {
        vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'happier.debug.viewportWrites' ? '1' : null) });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        recordTranscriptViewportWrite({
            landedScrollHeight: 1000,
            landedScrollTop: 180,
            preWriteScrollTop: 100,
            targetScrollTop: 180,
        });
        const sink = (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
            writes: Array<{ deltaPx: number; stack: string }>;
        };
        expect(sink.writes).toHaveLength(1);
        expect(sink.writes[0]!.deltaPx).toBe(80);
        expect(sink.writes[0]!.stack.length).toBeGreaterThan(0);
        expect(warn).toHaveBeenCalledTimes(1);

        // Small corrections stay quiet but are still recorded.
        recordTranscriptViewportWrite({
            landedScrollHeight: 1000,
            landedScrollTop: 184,
            preWriteScrollTop: 180,
            targetScrollTop: 184,
        });
        expect(sink.writes).toHaveLength(2);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('bounds the ring buffer', () => {
        vi.stubGlobal('localStorage', { getItem: () => '1' });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (let index = 0; index < 80; index += 1) {
            recordTranscriptViewportWrite({
                landedScrollHeight: 1000,
                landedScrollTop: index,
                preWriteScrollTop: index,
                targetScrollTop: index,
            });
        }
        const sink = (globalThis as Record<string, unknown>).__happierViewportDiagnostics as { writes: unknown[] };
        expect(sink.writes.length).toBe(64);
    });

    it('records only distinct held-intent lifecycle transitions in the bounded debug sink', () => {
        vi.stubGlobal('localStorage', { getItem: () => '1' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const landing = {
            basis: 'web-dom' as const,
            currentOffset: 44_703,
            event: 'landing-read' as const,
            intentId: 'msg:cvv0m1h50mu',
            intentKind: 'anchor' as const,
            residual: -19_754,
            targetOffset: 24_949,
        };

        recordTranscriptHeldIntentLifecycle(landing);
        recordTranscriptHeldIntentLifecycle(landing);
        recordTranscriptHeldIntentLifecycle({ ...landing, event: 'materialization-start' });

        const sink = (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
            heldIntents: Array<{ event: string; residual?: number }>;
        };
        expect(sink.heldIntents).toEqual([
            expect.objectContaining({ event: 'landing-read', residual: -19_754 }),
            expect.objectContaining({ event: 'materialization-start', residual: -19_754 }),
        ]);
        expect(warn).not.toHaveBeenCalled();

        for (let index = 0; index < 80; index += 1) {
            recordTranscriptHeldIntentLifecycle({
                ...landing,
                currentOffset: index,
            });
        }
        expect(sink.heldIntents).toHaveLength(64);
    });

    it('supports a lightweight held-intent probe without enabling physical scroll interception', () => {
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => key === 'happier.debug.viewportHeldIntents' ? '1' : null,
        });
        const element = {
            scrollHeight: 1200,
            scrollTop: 100,
            scrollBy: vi.fn(),
            scrollTo: vi.fn(),
        };

        recordTranscriptHeldIntentLifecycle({
            event: 'settle-request',
            intentId: 'msg:target',
            intentKind: 'anchor',
        });

        const sink = (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
            heldIntents: Array<{ event: string }>;
        };
        expect(sink.heldIntents).toEqual([
            expect.objectContaining({ event: 'settle-request' }),
        ]);
        expect(observeTranscriptPhysicalScrollMethods(element)).toBeNull();
    });

    it('attributes physical scroll methods and restores the element on dispose', () => {
        vi.stubGlobal('localStorage', { getItem: () => '1' });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const element = {
            scrollHeight: 1200,
            scrollTop: 100,
            scrollBy(optionsOrX: ScrollToOptions | number, y?: number) {
                this.scrollTop += typeof optionsOrX === 'number' ? (y ?? 0) : (optionsOrX.top ?? 0);
            },
            scrollTo(optionsOrX: ScrollToOptions | number, y?: number) {
                this.scrollTop = typeof optionsOrX === 'number'
                    ? (y ?? 0)
                    : (optionsOrX.top ?? this.scrollTop);
            },
        };
        const originalScrollBy = element.scrollBy;
        const originalScrollTo = element.scrollTo;

        const dispose = observeTranscriptPhysicalScrollMethods(element);
        expect(dispose).not.toBeNull();
        element.scrollTo({ top: 180 });
        element.scrollBy({ top: 25 });

        const sink = (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
            physicalWrites: Array<{
                deltaPx: number;
                method: string;
                stack: string;
                targetScrollTop: number;
                writer: string;
            }>;
        };
        expect(sink.physicalWrites).toHaveLength(2);
        expect(sink.physicalWrites.map(({ deltaPx, method, targetScrollTop }) => ({
            deltaPx,
            method,
            targetScrollTop,
        }))).toEqual([
            { deltaPx: 80, method: 'scrollTo', targetScrollTop: 180 },
            { deltaPx: 25, method: 'scrollBy', targetScrollTop: 205 },
        ]);
        expect(sink.physicalWrites.every(({ stack }) => stack.length > 0)).toBe(true);
        expect(sink.physicalWrites.every(({ writer }) => writer === 'unknown-physical')).toBe(true);

        dispose?.();
        expect(element.scrollBy).toBe(originalScrollBy);
        expect(element.scrollTo).toBe(originalScrollTo);
        element.scrollTo({ top: 240 });
        expect(sink.physicalWrites).toHaveLength(2);
    });

    it('opens the ring on a native runtime through the sync-tuning env channel', () => {
        // React Native has no `localStorage`, so the localStorage-only enable check left
        // every native capture empty and made native A/B comparisons unfalsifiable.
        vi.stubGlobal('localStorage', undefined);
        vi.stubEnv(
            'EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON',
            JSON.stringify({ transcriptViewportDiagnosticsEnabled: true }),
        );
        resetTranscriptViewportDiagnosticsForTests();

        expect(isTranscriptViewportDiagnosticsEnabled()).toBe(true);

        recordTranscriptScrollSample({ cause: 'user', offset: 1_280, platform: 'native' });
        recordTranscriptScrollSample({ cause: null, offset: 1_284, platform: 'native' });

        const sink = (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
            scrollSamples: Array<{ cause: string | null; offset: number; platform: string }>;
        };
        expect(sink.scrollSamples.map(({ cause, offset, platform }) => ({ cause, offset, platform })))
            .toEqual([
                { cause: 'user', offset: 1_280, platform: 'native' },
                { cause: null, offset: 1_284, platform: 'native' },
            ]);
    });

    it('stays closed on a native runtime when the sync-tuning env channel does not enable it', () => {
        vi.stubGlobal('localStorage', undefined);
        vi.stubEnv(
            'EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON',
            JSON.stringify({ transcriptNativeHotTailItemCount: 4 }),
        );
        resetTranscriptViewportDiagnosticsForTests();

        expect(isTranscriptViewportDiagnosticsEnabled()).toBe(false);

        recordTranscriptScrollSample({ cause: 'user', offset: 1_280, platform: 'native' });

        expect((globalThis as Record<string, unknown>).__happierViewportDiagnostics).toBeUndefined();
    });

    /**
     * THE RING MUST FOLLOW THE SCROLLER, NOT THE FIRST ELEMENT IT EVER SAW.
     *
     * At mount the transcript content does not overflow yet, so the app's scroller
     * resolution falls back past the transcript root to an ANCESTOR scroller (live: the
     * 384px left rail). The old install was a `useEffect` with unchanging deps: it armed on
     * that element once and could never re-arm, so every later write to the real scroller
     * went unseen and three lanes read the resulting empty ring as "the app never writes".
     */
    it('re-arms on the transcript scroller once it attaches and then sees its writes', () => {
        vi.stubGlobal('localStorage', { getItem: () => '1' });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const transcriptScroller = scrollerStub('transcript-scroller', 800);
        const railScroller = scrollerStub('left-rail', 384);
        const transcriptRoot = {
            contains: (candidate: unknown) => candidate === transcriptScroller,
        };

        // Mount-time resolution escapes the transcript root: refused, and loudly unarmed.
        ensureTranscriptViewportElementObservers({ element: railScroller, transcriptRoot });
        railScroller.scrollTo({ top: 5_000 });
        expect(readTranscriptPhysicalWriteCensus()).toMatchObject({
            observer: { installed: false, reason: 'scroller-outside-transcript-root' },
            status: 'unarmed',
            writes: null,
        });

        // The real scroller attaches on a later resolution tick.
        ensureTranscriptViewportElementObservers({ element: transcriptScroller, transcriptRoot });
        transcriptScroller.scrollTo({ top: 1_800 });
        transcriptScroller.scrollBy({ top: -40 });

        const census = readTranscriptPhysicalWriteCensus();
        expect(census.observer.installed).toBe(true);
        expect(census.observer.armedOnElement).toBe(transcriptScroller);
        expect(census.observer.armedOnElementLabel).toContain('800x600');
        expect(census.status).toBe('armed');
        expect(census.writes?.map(({ deltaPx, method }) => ({ deltaPx, method }))).toEqual([
            { deltaPx: 1_800, method: 'scrollTo' },
            { deltaPx: -40, method: 'scrollBy' },
        ]);

        // Re-arming leaves exactly one live wrap: the rail must not double-record.
        railScroller.scrollTo({ top: 10 });
        expect(census.writes).toHaveLength(2);

        disposeTranscriptViewportElementObservers();
        transcriptScroller.scrollTo({ top: 20 });
        expect(readTranscriptPhysicalWriteCensus()).toMatchObject({
            observer: { installed: false, reason: 'disposed' },
            status: 'unarmed',
            writes: null,
        });
    });

    /**
     * AN UNARMED RING IS NOT SILENCE. `physicalWrites: []` is what an uninstalled observer and
     * a quiet page both look like; the census refuses to render that ambiguity as a count.
     */
    it('reports an unarmed ring as unarmed rather than as zero writes', () => {
        vi.stubGlobal('localStorage', { getItem: () => '1' });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        ensureTranscriptViewportElementObservers({ element: null, transcriptRoot: null });

        const sink = (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
            physicalWriteObserver: { installed: boolean; reason: string };
            physicalWrites: unknown[];
            readPhysicalWriteCensus: () => { status: string; writes: unknown[] | null };
        };
        // The naive read that misled three lanes still returns an empty array...
        expect(sink.physicalWrites).toEqual([]);
        // ...while the census makes the absent instrument impossible to miss.
        expect(sink.physicalWriteObserver).toMatchObject({ installed: false, reason: 'no-scroller-element' });
        expect(sink.readPhysicalWriteCensus()).toMatchObject({ status: 'unarmed', writes: null });
        expect(error).toHaveBeenCalledTimes(1);

        resetTranscriptViewportDiagnosticsForTests();
        vi.stubGlobal('localStorage', { getItem: () => null });
        expect(readTranscriptPhysicalWriteCensus()).toMatchObject({
            observer: { reason: 'diagnostics-disabled' },
            status: 'unarmed',
            writes: null,
        });
        expect((globalThis as Record<string, unknown>).__happierViewportDiagnostics).toBeUndefined();
    });

    it('does not wrap physical scroll methods when diagnostics are disabled', () => {
        vi.stubGlobal('localStorage', { getItem: () => null });
        const element = {
            scrollHeight: 1200,
            scrollTop: 100,
            scrollBy: vi.fn(),
            scrollTo: vi.fn(),
        };
        const originalScrollBy = element.scrollBy;
        const originalScrollTo = element.scrollTo;

        expect(observeTranscriptPhysicalScrollMethods(element)).toBeNull();
        expect(element.scrollBy).toBe(originalScrollBy);
        expect(element.scrollTo).toBe(originalScrollTo);
    });
});
