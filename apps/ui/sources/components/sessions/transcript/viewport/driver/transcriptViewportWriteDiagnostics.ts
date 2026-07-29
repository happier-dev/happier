/**
 * Opt-in live diagnostics for rare viewport defects (off unless the operator sets
 * `localStorage['happier.debug.viewportWrites'] = '1'` and reloads — same pattern as
 * `happier.debug.messageDecrypt` — or, on a native build, sets
 * `transcriptViewportDiagnosticsEnabled: true` inside the
 * `EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON` object).
 *
 * Two rare defect classes need a writer identified from a SINGLE in-the-wild
 * occurrence, because they do not reproduce on demand:
 * - the transcript sliding ~50-80px behind the composer on an idle session: every
 *   programmatic web scroll write flows through `writeWebScrollTopAndObserve`, so
 *   recording each write with its call stack either names the writer, or proves by
 *   absence that the slide was a LAYOUT shift (composer inset growth without scroll
 *   compensation) rather than a scroll write;
 * - the residual one-shot whole-transcript flicker: Legend's web build hides the list
 *   via container opacity, so timestamped opacity flips with the container's child
 *   count distinguish a data collapse from any other reset.
 *
 * Native has neither `localStorage` nor a DOM scroller to intercept, so its only
 * observation of viewport movement is the list's own `onScroll` offset; those samples
 * land in the same sink so a native capture is comparable to a web one.
 *
 * Findings land in `globalThis.__happierViewportDiagnostics` (bounded ring buffers) and
 * large jumps warn on the console with the captured stack.
 */

export type TranscriptViewportWriteDiagnosticEntry = Readonly<{
    atMs: number;
    deltaPx: number;
    landedScrollHeight: number;
    landedScrollTop: number;
    preWriteScrollTop: number | null;
    stack: string;
    targetScrollTop: number;
}>;

export type TranscriptPhysicalScrollDiagnosticEntry = Readonly<{
    atMs: number;
    deltaPx: number;
    landedScrollHeight: number;
    landedScrollTop: number;
    method: 'scrollBy' | 'scrollTo';
    preWriteScrollTop: number;
    stack: string;
    targetScrollTop: number;
    writer:
        | 'legend-imperative-index'
        | 'legend-imperative-offset'
        | 'legend-initial'
        | 'legend-maintain'
        | 'legend-scroll-adjust'
        | 'unknown-physical';
}>;

export type TranscriptRevealFlipDiagnosticEntry = Readonly<{
    atMs: number;
    childCount: number;
    opacity: string;
}>;

/**
 * One observed scroll offset as reported by the list. `cause` mirrors the renderer's
 * pending viewport mutation cause at observation time (see `TranscriptViewportMutationCause`);
 * it is recorded, never decided, here.
 */
export type TranscriptScrollSampleDiagnosticEntry = Readonly<{
    atMs: number;
    cause: 'command' | 'layout' | 'user' | null;
    offset: number;
    platform: 'native' | 'web';
}>;

export type TranscriptHeldIntentDiagnosticEntry = Readonly<{
    atMs: number;
    basis?: 'legend-state' | 'native-physical' | 'web-dom';
    currentOffset?: number;
    estimateBasis?: boolean;
    event:
        | 'hold-release'
        | 'hold-set'
        | 'identity-expired'
        | 'landing-missing'
        | 'landing-read'
        | 'materialization-settled'
        | 'materialization-start'
        | 'residual-write'
        | 'settle-request';
    intentId: string | null;
    intentKind: 'anchor' | 'end' | 'index';
    residual?: number;
    targetOffset?: number;
}>;

const RING_LIMIT = 64;
const LARGE_WRITE_DELTA_WARN_PX = 24;

type DiagnosticsSink = {
    heldIntents: TranscriptHeldIntentDiagnosticEntry[];
    physicalWrites: TranscriptPhysicalScrollDiagnosticEntry[];
    revealFlips: TranscriptRevealFlipDiagnosticEntry[];
    scrollSamples: TranscriptScrollSampleDiagnosticEntry[];
    writes: TranscriptViewportWriteDiagnosticEntry[];
};

let cachedEnabled: boolean | null = null;
let cachedHeldIntentEnabled: boolean | null = null;

/**
 * Native override channel. `EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON` is the only build-time
 * JSON bag that reaches a native binary; `sync/runtime/syncTuning.ts` owns the sync knobs
 * inside it and ignores unknown keys, so this debug switch travels on the same transport
 * without joining that schema.
 */
function isSyncTuningDiagnosticsFlagSet(): boolean {
    // Expo only inlines EXPO_PUBLIC_* variables when they are read with dot notation.
    const raw = typeof process === 'undefined'
        ? undefined
        : process.env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON;
    if (typeof raw !== 'string' || raw.trim() === '') return false;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        return (parsed as Record<string, unknown>).transcriptViewportDiagnosticsEnabled === true;
    } catch {
        return false;
    }
}

export function isTranscriptViewportDiagnosticsEnabled(): boolean {
    if (cachedEnabled !== null) return cachedEnabled;
    let enabledByWebStorage = false;
    try {
        enabledByWebStorage =
            typeof localStorage !== 'undefined' &&
            localStorage.getItem('happier.debug.viewportWrites') === '1';
    } catch {
        enabledByWebStorage = false;
    }
    cachedEnabled = enabledByWebStorage || isSyncTuningDiagnosticsFlagSet();
    return cachedEnabled;
}

/** Test seam: reset the cached flag so enable/disable transitions are testable. */
export function resetTranscriptViewportDiagnosticsForTests(): void {
    cachedEnabled = null;
    cachedHeldIntentEnabled = null;
    delete (globalThis as Record<string, unknown>).__happierViewportDiagnostics;
}

function isTranscriptHeldIntentDiagnosticsEnabled(): boolean {
    if (cachedHeldIntentEnabled !== null) return cachedHeldIntentEnabled;
    try {
        cachedHeldIntentEnabled =
            isTranscriptViewportDiagnosticsEnabled()
            || (
                typeof localStorage !== 'undefined'
                && localStorage.getItem('happier.debug.viewportHeldIntents') === '1'
            );
    } catch {
        cachedHeldIntentEnabled = false;
    }
    return cachedHeldIntentEnabled;
}

function resolveSink(): DiagnosticsSink {
    const host = globalThis as Record<string, unknown>;
    const existing = host.__happierViewportDiagnostics as DiagnosticsSink | undefined;
    if (existing) {
        existing.heldIntents ??= [];
        existing.physicalWrites ??= [];
        existing.scrollSamples ??= [];
        return existing;
    }
    const created: DiagnosticsSink = {
        heldIntents: [],
        physicalWrites: [],
        revealFlips: [],
        scrollSamples: [],
        writes: [],
    };
    host.__happierViewportDiagnostics = created;
    return created;
}

function pushBounded<T>(list: T[], entry: T): void {
    list.push(entry);
    if (list.length > RING_LIMIT) list.splice(0, list.length - RING_LIMIT);
}

export function recordTranscriptHeldIntentLifecycle(
    params: Omit<TranscriptHeldIntentDiagnosticEntry, 'atMs'>,
): void {
    if (!isTranscriptHeldIntentDiagnosticsEnabled()) return;
    const entries = resolveSink().heldIntents;
    const previous = entries.at(-1);
    if (
        previous != null
        && previous.basis === params.basis
        && previous.currentOffset === params.currentOffset
        && previous.estimateBasis === params.estimateBasis
        && previous.event === params.event
        && previous.intentId === params.intentId
        && previous.intentKind === params.intentKind
        && previous.residual === params.residual
        && previous.targetOffset === params.targetOffset
    ) {
        return;
    }
    pushBounded(entries, {
        ...params,
        atMs: Date.now(),
    });
}

/**
 * Record one observed scroll offset. This is the only viewport-movement observation a
 * native runtime can make: there is no DOM scroller to intercept, so the physical-write
 * ring stays web-only and native attribution is reconstructed by pairing these samples
 * with the held-intent lifecycle entries.
 */
export function recordTranscriptScrollSample(
    params: Omit<TranscriptScrollSampleDiagnosticEntry, 'atMs'>,
): void {
    if (!isTranscriptViewportDiagnosticsEnabled()) return;
    pushBounded(resolveSink().scrollSamples, {
        ...params,
        atMs: Date.now(),
    });
}

export function recordTranscriptViewportWrite(params: Readonly<{
    landedScrollHeight: number;
    landedScrollTop: number;
    preWriteScrollTop: number | null;
    targetScrollTop: number;
}>): void {
    if (!isTranscriptViewportDiagnosticsEnabled()) return;
    const deltaPx =
        typeof params.preWriteScrollTop === 'number' && Number.isFinite(params.preWriteScrollTop)
            ? params.landedScrollTop - params.preWriteScrollTop
            : 0;
    const entry: TranscriptViewportWriteDiagnosticEntry = {
        atMs: Date.now(),
        deltaPx,
        landedScrollHeight: params.landedScrollHeight,
        landedScrollTop: params.landedScrollTop,
        preWriteScrollTop: params.preWriteScrollTop,
        stack: new Error('transcript viewport write').stack ?? '',
        targetScrollTop: params.targetScrollTop,
    };
    pushBounded(resolveSink().writes, entry);
    if (Math.abs(deltaPx) >= LARGE_WRITE_DELTA_WARN_PX) {
        // eslint-disable-next-line no-console
        console.warn(
            `[happier.debug.viewportWrites] programmatic scroll write moved viewport by ${Math.round(deltaPx)}px`,
            entry,
        );
    }
}

type TranscriptPhysicalScrollTarget = {
    scrollBy: CallableFunction;
    scrollHeight: number;
    scrollTo: CallableFunction;
    scrollTop: number;
};

function resolvePhysicalWriter(
    stack: string,
    method: TranscriptPhysicalScrollDiagnosticEntry['method'],
): TranscriptPhysicalScrollDiagnosticEntry['writer'] {
    if (stack.includes('doMaintainScrollAtEnd')) return 'legend-maintain';
    if (stack.includes('dispatchInitialScroll') || stack.includes('advanceMeasuredInitialScroll')) {
        return 'legend-initial';
    }
    if (stack.includes('scrollToIndex')) return 'legend-imperative-index';
    if (stack.includes('scrollToOffset')) return 'legend-imperative-offset';
    if (method === 'scrollBy' && (stack.includes('ScrollAdjust') || stack.includes('scrollAdjustBy'))) {
        return 'legend-scroll-adjust';
    }
    return 'unknown-physical';
}

function requestedScrollTop(
    method: TranscriptPhysicalScrollDiagnosticEntry['method'],
    optionsOrX: ScrollToOptions | number,
    y: number | undefined,
    preWriteScrollTop: number,
): number {
    const verticalValue = typeof optionsOrX === 'number'
        ? (y ?? 0)
        : (optionsOrX.top ?? (method === 'scrollBy' ? 0 : preWriteScrollTop));
    return method === 'scrollBy' ? preWriteScrollTop + verticalValue : verticalValue;
}

/**
 * Debug-only interception of the browser's physical scroll methods. This observes
 * Legend-owned writes that bypass the app's canonical `scrollTop=` writer without
 * changing their ordering or semantics.
 */
export function observeTranscriptPhysicalScrollMethods(
    element: TranscriptPhysicalScrollTarget,
): (() => void) | null {
    if (!isTranscriptViewportDiagnosticsEnabled()) return null;
    const scrollByDescriptor = Object.getOwnPropertyDescriptor(element, 'scrollBy');
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(element, 'scrollTo');
    const originalScrollBy = element.scrollBy;
    const originalScrollTo = element.scrollTo;

    const wrap = (
        method: TranscriptPhysicalScrollDiagnosticEntry['method'],
        original: TranscriptPhysicalScrollTarget[typeof method],
    ) => (optionsOrX: ScrollToOptions | number, y?: number): void => {
        const preWriteScrollTop = element.scrollTop;
        const targetScrollTop = requestedScrollTop(method, optionsOrX, y, preWriteScrollTop);
        const stack = new Error(`transcript physical ${method}`).stack ?? '';
        Reflect.apply(
            original,
            element,
            typeof optionsOrX === 'number' ? [optionsOrX, y ?? 0] : [optionsOrX],
        );
        const entry: TranscriptPhysicalScrollDiagnosticEntry = {
            atMs: Date.now(),
            deltaPx: element.scrollTop - preWriteScrollTop,
            landedScrollHeight: element.scrollHeight,
            landedScrollTop: element.scrollTop,
            method,
            preWriteScrollTop,
            stack,
            targetScrollTop,
            writer: resolvePhysicalWriter(stack, method),
        };
        pushBounded(resolveSink().physicalWrites, entry);
        if (Math.abs(entry.deltaPx) >= LARGE_WRITE_DELTA_WARN_PX) {
            // eslint-disable-next-line no-console
            console.warn(
                `[happier.debug.viewportWrites] ${entry.writer} ${method} moved viewport by ${Math.round(entry.deltaPx)}px`,
                entry,
            );
        }
    };

    try {
        Object.defineProperty(element, 'scrollBy', {
            configurable: true,
            value: wrap('scrollBy', originalScrollBy),
            writable: true,
        });
        Object.defineProperty(element, 'scrollTo', {
            configurable: true,
            value: wrap('scrollTo', originalScrollTo),
            writable: true,
        });
    } catch {
        if (scrollByDescriptor) Object.defineProperty(element, 'scrollBy', scrollByDescriptor);
        else delete (element as Partial<TranscriptPhysicalScrollTarget>).scrollBy;
        if (scrollToDescriptor) Object.defineProperty(element, 'scrollTo', scrollToDescriptor);
        else delete (element as Partial<TranscriptPhysicalScrollTarget>).scrollTo;
        return null;
    }

    return () => {
        if (scrollByDescriptor) Object.defineProperty(element, 'scrollBy', scrollByDescriptor);
        else delete (element as Partial<TranscriptPhysicalScrollTarget>).scrollBy;
        if (scrollToDescriptor) Object.defineProperty(element, 'scrollTo', scrollToDescriptor);
        else delete (element as Partial<TranscriptPhysicalScrollTarget>).scrollTo;
    };
}

/**
 * Observe container opacity flips under the transcript scroller (Legend's web hide
 * gate). Returns a dispose function; no-op (returns null) when diagnostics are off or
 * MutationObserver is unavailable.
 */
export function observeTranscriptRevealVisibility(element: Readonly<{
    childElementCount?: number;
}> & object): (() => void) | null {
    if (!isTranscriptViewportDiagnosticsEnabled()) return null;
    if (typeof MutationObserver === 'undefined') return null;
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            const target = mutation.target as HTMLElement;
            const opacity = target?.style?.opacity ?? '';
            if (opacity !== '0' && opacity !== '1') continue;
            const entry: TranscriptRevealFlipDiagnosticEntry = {
                atMs: Date.now(),
                childCount: target.childElementCount ?? -1,
                opacity,
            };
            pushBounded(resolveSink().revealFlips, entry);
            if (opacity === '0') {
                // eslint-disable-next-line no-console
                console.warn('[happier.debug.viewportWrites] transcript container hidden (opacity 0)', entry);
            }
        }
    });
    observer.observe(element as Node, {
        attributeFilter: ['style'],
        attributes: true,
        subtree: true,
    });
    return () => observer.disconnect();
}
