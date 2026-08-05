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

/**
 * Why the physical-write ring is (not) observing anything.
 *
 * `physicalWrites: []` is ambiguous on its own and that ambiguity has already cost this
 * program three lanes: they read an empty ring on a live page and concluded "the app never
 * writes", while the observer was wrapped around an element outside the transcript entirely
 * (the mount-time resolution falls back to an ANCESTOR scroller when nothing inside the
 * transcript root overflows yet — see `resolveWebScrollableElement`). A ring that cannot see
 * the writes reports zero exactly like a quiet one.
 */
export type TranscriptPhysicalScrollObserverReason =
    | 'armed'
    | 'diagnostics-disabled'
    | 'disposed'
    | 'install-failed'
    | 'never-armed'
    | 'no-scroller-element'
    | 'scroller-outside-transcript-root';

export type TranscriptPhysicalScrollObserverState = Readonly<{
    /**
     * The element whose `scrollTo`/`scrollBy` are wrapped, so a caller can verify identity by
     * construction. Deliberately NON-ENUMERABLE: the sink must stay `JSON.stringify`-able for
     * console captures, and a live DOM node is circular through its React fiber.
     */
    armedOnElement: TranscriptViewportObservableElement | null;
    /** Console-readable identity (`id`/`data-testid` + box) so a rail is visible as a rail. */
    armedOnElementLabel: string | null;
    atMs: number;
    installed: boolean;
    reason: TranscriptPhysicalScrollObserverReason;
}>;

/**
 * The physical-write reading that consumers must go through: when the observer is not armed
 * the entry count is `null`, not `0`, so "nothing happened" cannot be read off an instrument
 * that was never installed.
 */
export type TranscriptPhysicalWriteCensus =
    | Readonly<{
        observer: TranscriptPhysicalScrollObserverState;
        status: 'armed';
        writes: readonly TranscriptPhysicalScrollDiagnosticEntry[];
    }>
    | Readonly<{
        observer: TranscriptPhysicalScrollObserverState;
        status: 'unarmed';
        writes: null;
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
    physicalWriteObserver: TranscriptPhysicalScrollObserverState;
    physicalWrites: TranscriptPhysicalScrollDiagnosticEntry[];
    /** Console entrypoint: reading the ring through this cannot skip the armed check. */
    readPhysicalWriteCensus: () => TranscriptPhysicalWriteCensus;
    revealFlips: TranscriptRevealFlipDiagnosticEntry[];
    scrollSamples: TranscriptScrollSampleDiagnosticEntry[];
    writes: TranscriptViewportWriteDiagnosticEntry[];
};

function observerState(
    state: Omit<TranscriptPhysicalScrollObserverState, 'armedOnElement' | 'atMs'>,
    armedOnElement: TranscriptViewportObservableElement | null,
    atMs: number,
): TranscriptPhysicalScrollObserverState {
    const result: Record<string, unknown> = { ...state, atMs };
    Object.defineProperty(result, 'armedOnElement', {
        configurable: true,
        enumerable: false,
        value: armedOnElement,
        writable: false,
    });
    return result as unknown as TranscriptPhysicalScrollObserverState;
}

const NEVER_ARMED_OBSERVER_STATE = observerState(
    { armedOnElementLabel: null, installed: false, reason: 'never-armed' },
    null,
    0,
);

const DIAGNOSTICS_DISABLED_OBSERVER_STATE = observerState(
    { armedOnElementLabel: null, installed: false, reason: 'diagnostics-disabled' },
    null,
    0,
);

let cachedEnabled: boolean | null = null;
let cachedHeldIntentEnabled: boolean | null = null;
let armedObserverElement: TranscriptViewportObservableElement | null = null;
let armedObserverDispose: (() => void) | null = null;

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
    armedObserverDispose?.();
    armedObserverDispose = null;
    armedObserverElement = null;
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
        existing.physicalWriteObserver ??= NEVER_ARMED_OBSERVER_STATE;
        existing.readPhysicalWriteCensus ??= readTranscriptPhysicalWriteCensus;
        existing.scrollSamples ??= [];
        return existing;
    }
    const created: DiagnosticsSink = {
        heldIntents: [],
        physicalWriteObserver: NEVER_ARMED_OBSERVER_STATE,
        physicalWrites: [],
        readPhysicalWriteCensus: readTranscriptPhysicalWriteCensus,
        revealFlips: [],
        scrollSamples: [],
        writes: [],
    };
    host.__happierViewportDiagnostics = created;
    return created;
}

/**
 * The armed-state guard. An unarmed observer yields `writes: null` and shouts, so an absent
 * instrument can never be reported as an absence of writes.
 */
export function readTranscriptPhysicalWriteCensus(): TranscriptPhysicalWriteCensus {
    if (!isTranscriptViewportDiagnosticsEnabled()) {
        // eslint-disable-next-line no-console
        console.error(
            '[happier.debug.viewportWrites] physical-write census read while diagnostics are OFF: '
            + 'no writes were observed because nothing was observing. This is NOT evidence of silence.',
        );
        return { observer: DIAGNOSTICS_DISABLED_OBSERVER_STATE, status: 'unarmed', writes: null };
    }
    const sink = resolveSink();
    const observer = sink.physicalWriteObserver;
    if (!observer.installed) {
        // eslint-disable-next-line no-console
        console.error(
            `[happier.debug.viewportWrites] physical-write census read while UNARMED (${observer.reason}): `
            + 'the ring observed nothing because it is not installed on the transcript scroller. '
            + 'This is NOT evidence of silence.',
            observer,
        );
        return { observer, status: 'unarmed', writes: null };
    }
    return { observer, status: 'armed', writes: sink.physicalWrites };
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

export type TranscriptViewportObservableElement = TranscriptPhysicalScrollTarget & Readonly<{
    childElementCount?: number;
    clientHeight?: number;
    clientWidth?: number;
    getAttribute?: (name: string) => string | null;
    id?: string;
}>;

type TranscriptViewportRootElement = Readonly<{
    contains?: (other: Node | null) => boolean;
}>;

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

function describeObservableElement(element: TranscriptViewportObservableElement): string {
    const id = typeof element.id === 'string' && element.id !== '' ? `#${element.id}` : '';
    const testId = typeof element.getAttribute === 'function'
        ? element.getAttribute('data-testid')
        : null;
    const width = typeof element.clientWidth === 'number' ? element.clientWidth : '?';
    const height = typeof element.clientHeight === 'number' ? element.clientHeight : '?';
    return `${id}${testId ? `[data-testid=${testId}]` : ''} ${width}x${height}`.trim();
}

function recordPhysicalScrollObserverState(state: Omit<TranscriptPhysicalScrollObserverState, 'atMs'>): void {
    const { armedOnElement, ...serializable } = state;
    resolveSink().physicalWriteObserver = observerState(serializable, armedOnElement, Date.now());
}

function disarmPhysicalScrollObserver(): void {
    armedObserverDispose?.();
    armedObserverDispose = null;
    armedObserverElement = null;
}

/**
 * Arm (or re-arm) the transcript viewport observers on the scroller the app itself resolved.
 *
 * WHY THIS IS NOT A MOUNT-TIME EFFECT. The previous install ran once, in a `useEffect` whose
 * deps could not change, against whatever `readWebScrollMetrics()` resolved at mount. At that
 * instant the transcript content does not overflow yet, so the resolver's ancestor walk (or
 * its root fallback) hands back an element that is NOT the transcript scroller — in the live
 * capture, the 384px left-rail scroller. The effect then had no way to re-arm once the real
 * scroller attached, so the ring stayed pointed at the wrong element for the entire session.
 *
 * Calling this from the canonical resolution point instead means the observers follow the
 * app's own notion of "the transcript scroller" for free: identical element -> no work,
 * changed element -> dispose and re-arm, and a resolution that escaped the transcript root is
 * refused loudly rather than silently certifying an unrelated element's silence.
 */
export function ensureTranscriptViewportElementObservers(params: Readonly<{
    element: TranscriptViewportObservableElement | null;
    transcriptRoot?: TranscriptViewportRootElement | null;
}>): void {
    if (!isTranscriptViewportDiagnosticsEnabled()) return;
    const element = params.element;
    if (element !== null && element === armedObserverElement) return;

    const root = params.transcriptRoot ?? null;
    const escapedTranscriptRoot = element !== null
        && root != null
        && typeof root.contains === 'function'
        && root.contains(element as unknown as Node) !== true;
    const reason: TranscriptPhysicalScrollObserverReason = element === null
        ? 'no-scroller-element'
        : escapedTranscriptRoot ? 'scroller-outside-transcript-root' : 'armed';

    if (reason !== 'armed') {
        // Idempotent while the same obstruction persists: the resolver is polled on every
        // scroll/layout tick and must not churn the observer state or the console.
        if (armedObserverElement === null && resolveSink().physicalWriteObserver.reason === reason) return;
        disarmPhysicalScrollObserver();
        recordPhysicalScrollObserverState({ armedOnElement: null, armedOnElementLabel: null, installed: false, reason });
        // eslint-disable-next-line no-console
        console.warn(
            `[happier.debug.viewportWrites] physical-write ring NOT armed (${reason}); `
            + 'an empty ring proves nothing until it is.',
            element ? describeObservableElement(element) : null,
        );
        return;
    }

    disarmPhysicalScrollObserver();
    const disposePhysicalWrites = observeTranscriptPhysicalScrollMethods(element!);
    if (!disposePhysicalWrites) {
        recordPhysicalScrollObserverState({
            armedOnElement: null,
            armedOnElementLabel: describeObservableElement(element!),
            installed: false,
            reason: 'install-failed',
        });
        // eslint-disable-next-line no-console
        console.warn('[happier.debug.viewportWrites] physical-write ring install FAILED; an empty ring proves nothing.');
        return;
    }
    const disposeRevealVisibility = observeTranscriptRevealVisibility(element!);
    armedObserverElement = element!;
    armedObserverDispose = () => {
        disposePhysicalWrites();
        disposeRevealVisibility?.();
    };
    recordPhysicalScrollObserverState({
        armedOnElement: element!,
        armedOnElementLabel: describeObservableElement(element!),
        installed: true,
        reason: 'armed',
    });
}

/** Unmount teardown for {@link ensureTranscriptViewportElementObservers}. */
export function disposeTranscriptViewportElementObservers(): void {
    if (armedObserverElement === null && armedObserverDispose === null) return;
    disarmPhysicalScrollObserver();
    if (!isTranscriptViewportDiagnosticsEnabled()) return;
    recordPhysicalScrollObserverState({
        armedOnElement: null,
        armedOnElementLabel: null,
        installed: false,
        reason: 'disposed',
    });
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
