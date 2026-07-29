import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    isTranscriptViewportDiagnosticsEnabled,
    observeTranscriptPhysicalScrollMethods,
    recordTranscriptHeldIntentLifecycle,
    recordTranscriptScrollSample,
    recordTranscriptViewportWrite,
    resetTranscriptViewportDiagnosticsForTests,
} from './transcriptViewportWriteDiagnostics';

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
