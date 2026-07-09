import type {
    TranscriptViewportTelemetryEvent,
    TranscriptViewportTelemetryObservationReason,
    TranscriptViewportTelemetryOwner,
    TranscriptViewportTelemetryScrollReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

/**
 * Pure acceptance assertions over `TranscriptViewportTelemetryEvent[]` traces, implementing the
 * scenario invariants A–G of the transcript viewport single-owner plan. Invariant H (pagination
 * loading UI, ≤1 page in flight) is not observable from viewport telemetry alone and is covered
 * by the pagination machine tests instead.
 *
 * Invariant G note: the `follow` owner is governed per content version (invariant F allows one
 * write per content change while pinned), so the distinct-target spread budget applies to the
 * transaction owners (`entry`, `prepend`, `explicit`) across a phase.
 *
 * Used by unit/integration tests and by manual-QA snapshot analysis of
 * `__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__()` traces.
 */

export type ViewportTelemetryPhaseWindow = Readonly<{
    owner: TranscriptViewportTelemetryOwner;
    startMs: number;
    endMs: number;
    label?: string;
}>;

export type ViewportTelemetryWriteBudget = Readonly<{
    phase: ViewportTelemetryPhaseWindow;
    maxWrites: number;
    maxDistinctTargets: number;
}>;

export type ViewportTelemetryScenario =
    | 'cold-open'
    | 'warm-reopen'
    | 'prepend'
    | 'manual-scroll'
    | 'streaming-pinned';

export type ViewportTelemetryScenarioOptions = Readonly<{
    pinThresholdPx?: number;
}>;

type ScrollWriteEvent = Extract<TranscriptViewportTelemetryEvent, { type: 'scroll-write' }>;
type ObservationEvent = Exclude<TranscriptViewportTelemetryEvent, { type: 'scroll-write' | 'scroll-write-rejected' }>;
type WebWregDiagnosticEvent = ObservationEvent;

const DEFAULT_PIN_THRESHOLD_PX = 72;

const WRITE_REASON_OWNERS: Partial<Record<TranscriptViewportTelemetryScrollReason, TranscriptViewportTelemetryOwner>> = {
    'initial-open': 'entry',
    'entry-restore': 'entry',
    'prepend-restore': 'prepend',
    'jump-to-bottom': 'explicit',
    'jump-to-seq': 'explicit',
    'stream-append': 'follow',
    'mount-settle': 'follow',
    'content-size-change': 'follow',
    'layout-change': 'follow',
};

const TRANSACTION_OUTCOME_REASONS: ReadonlySet<TranscriptViewportTelemetryObservationReason> = new Set([
    'mvcp-preserved',
    'fallback-restored',
    'abandoned-layout-timeout',
    'abandoned-identity',
    'abandoned-user-scroll',
]);

const TERMINAL_DECISION_REASONS: ReadonlySet<TranscriptViewportTelemetryObservationReason> = new Set([
    ...TRANSACTION_OUTCOME_REASONS,
    'observed',
    'not-ready',
    'restored',
    'skipped',
    'missing-anchor',
    'entry-anchor-missing',
]);

function isCommittedScrollWrite(event: TranscriptViewportTelemetryEvent): event is ScrollWriteEvent {
    return event.type === 'scroll-write' && event.writer !== 'mvcp-skip';
}

function isObservationEvent(event: TranscriptViewportTelemetryEvent): event is ObservationEvent {
    return event.type !== 'scroll-write' && event.type !== 'scroll-write-rejected';
}

export function deriveViewportWriteOwner(event: ScrollWriteEvent): TranscriptViewportTelemetryOwner | null {
    return WRITE_REASON_OWNERS[event.reason] ?? null;
}

function describeEvent(event: TranscriptViewportTelemetryEvent): string {
    const parts = [`t=${event.timestampMs}`, event.type];
    if (event.type === 'scroll-write' || event.type === 'scroll-write-rejected') {
        parts.push(`writer=${event.writer}`, `reason=${event.reason}`, `mode=${event.mode}`);
        if (event.targetOffsetY !== undefined) parts.push(`target=${event.targetOffsetY}`);
        if (event.contentHeight !== undefined) parts.push(`contentHeight=${event.contentHeight}`);
    } else {
        parts.push(`mode=${event.mode}`);
        if (event.reason !== undefined) parts.push(`reason=${event.reason}`);
        if (event.offsetY !== undefined) parts.push(`offset=${event.offsetY}`);
        if (event.distanceFromBottom !== undefined) parts.push(`dfb=${event.distanceFromBottom}`);
    }
    parts.push(`session=${event.sessionId}`);
    return parts.join(' ');
}

function failWithEvents(message: string, offenders: readonly TranscriptViewportTelemetryEvent[]): never {
    const lines = offenders.map((event) => `  - ${describeEvent(event)}`);
    throw new Error([message, ...lines].join('\n'));
}

function hasOwn(event: TranscriptViewportTelemetryEvent, key: keyof TranscriptViewportTelemetryEvent): boolean {
    return Object.prototype.hasOwnProperty.call(event, key);
}

function isWebWregDiagnosticEvent(event: TranscriptViewportTelemetryEvent): event is WebWregDiagnosticEvent {
    return event.platform === 'web' && (event.type === 'scroll-observed' || event.type === 'restore-decision');
}

function collectMissingWebWregFields(event: WebWregDiagnosticEvent): string[] {
    const required: (keyof TranscriptViewportTelemetryEvent)[] = [
        'trigger',
        'domScrollTop',
        'domScrollHeight',
        'domClientHeight',
        'flashListContentHeight',
        'flashListLayoutHeight',
        'scrollable',
        'distanceFromBottom',
        'paginationPhase',
        'paginationSuspendedReasons',
        'coldCount',
        'hotCount',
        'pendingWebPrependAnchorKind',
        'programmaticWebWrite',
    ];
    const missing = required.filter((field) => !hasOwn(event, field));
    if (
        event.pendingWebPrependAnchorKind !== undefined &&
        event.pendingWebPrependAnchorKind !== 'none'
    ) {
        if (!hasOwn(event, 'pendingWebPrependAnchorId')) missing.push('pendingWebPrependAnchorId');
        if (!hasOwn(event, 'pendingWebPrependAnchorIndex')) missing.push('pendingWebPrependAnchorIndex');
    }
    if (
        event.type === 'restore-decision' ||
        event.trigger === 'restore' ||
        event.trigger === 'prepend-restore'
    ) {
        if (!hasOwn(event, 'firstVisibleAnchorTestId')) missing.push('firstVisibleAnchorTestId');
    }
    return missing;
}

export function assertWebWregDiagnostics(events: readonly TranscriptViewportTelemetryEvent[]): void {
    const offenders: TranscriptViewportTelemetryEvent[] = [];
    const missingByEvent = new Map<TranscriptViewportTelemetryEvent, string[]>();
    for (const event of events) {
        if (!isWebWregDiagnosticEvent(event)) continue;
        const missing = collectMissingWebWregFields(event);
        if (missing.length === 0) continue;
        offenders.push(event);
        missingByEvent.set(event, missing);
    }
    if (offenders.length === 0) return;

    const details = offenders.map((event) => {
        const missing = missingByEvent.get(event) ?? [];
        return `  - missing ${missing.join(', ')} :: ${describeEvent(event)}`;
    });
    throw new Error([
        'WREG telemetry diagnostics missing required web pagination/restore fields:',
        ...details,
    ].join('\n'));
}

function describePhase(phase: ViewportTelemetryPhaseWindow): string {
    const label = phase.label ? `${phase.label} ` : '';
    return `${label}[${phase.startMs},${phase.endMs}) owner=${phase.owner}`;
}

function writesInPhase(
    events: readonly TranscriptViewportTelemetryEvent[],
    phase: ViewportTelemetryPhaseWindow,
): ScrollWriteEvent[] {
    return events
        .filter(isCommittedScrollWrite)
        .filter((event) => event.timestampMs >= phase.startMs && event.timestampMs < phase.endMs);
}

function distinctTargetCount(writes: readonly ScrollWriteEvent[]): number {
    const targets = new Set<number | 'unknown'>();
    for (const write of writes) {
        targets.add(write.targetOffsetY ?? 'unknown');
    }
    return targets.size;
}

export function assertOneOwnerPerPhase(
    events: readonly TranscriptViewportTelemetryEvent[],
    phaseWindows: readonly ViewportTelemetryPhaseWindow[],
): void {
    for (const phase of phaseWindows) {
        const offenders = writesInPhase(events, phase).filter((event) => {
            const owner = deriveViewportWriteOwner(event);
            return owner === null || owner !== phase.owner;
        });
        if (offenders.length > 0) {
            failWithEvents(
                `Viewport phase ${describePhase(phase)} has ${offenders.length} write(s) from other or unattributable owners:`,
                offenders,
            );
        }
    }
}

export function assertWriteBudget(
    events: readonly TranscriptViewportTelemetryEvent[],
    budget: ViewportTelemetryWriteBudget,
): void {
    const writes = writesInPhase(events, budget.phase)
        .filter((event) => deriveViewportWriteOwner(event) === budget.phase.owner);
    const distinctTargets = distinctTargetCount(writes);
    if (writes.length > budget.maxWrites || distinctTargets > budget.maxDistinctTargets) {
        failWithEvents(
            `Viewport write budget exceeded for phase ${describePhase(budget.phase)}: `
            + `writes=${writes.length} (max ${budget.maxWrites}), `
            + `distinct targets=${distinctTargets} (max ${budget.maxDistinctTargets}):`,
            writes,
        );
    }
}

export function assertNoSilentBails(events: readonly TranscriptViewportTelemetryEvent[]): void {
    const openPendingBySession = new Map<string, TranscriptViewportTelemetryEvent[]>();
    for (const event of events) {
        if (event.type !== 'restore-decision' || event.reason === undefined) continue;
        if (event.reason === 'pending') {
            const open = openPendingBySession.get(event.sessionId) ?? [];
            open.push(event);
            openPendingBySession.set(event.sessionId, open);
            continue;
        }
        if (TERMINAL_DECISION_REASONS.has(event.reason)) {
            openPendingBySession.get(event.sessionId)?.pop();
        }
    }
    const unclosed = [...openPendingBySession.values()].flat();
    if (unclosed.length > 0) {
        failWithEvents(
            `Found ${unclosed.length} pending restore decision(s) without a terminal outcome (silent bail):`,
            unclosed,
        );
    }
}

function assertOwnerTargetSpread(events: readonly TranscriptViewportTelemetryEvent[]): void {
    const writesByOwner = new Map<TranscriptViewportTelemetryOwner, ScrollWriteEvent[]>();
    for (const event of events.filter(isCommittedScrollWrite)) {
        const owner = deriveViewportWriteOwner(event);
        if (owner === null || owner === 'follow') continue;
        const writes = writesByOwner.get(owner) ?? [];
        writes.push(event);
        writesByOwner.set(owner, writes);
    }
    for (const [owner, writes] of writesByOwner) {
        const distinctTargets = distinctTargetCount(writes);
        if (distinctTargets > 2) {
            failWithEvents(
                `Invariant G violated: owner '${owner}' wrote distinct targets=${distinctTargets} (max 2) within one phase:`,
                writes,
            );
        }
    }
}

function assertFinalWriteConfirmed(
    events: readonly TranscriptViewportTelemetryEvent[],
    writes: readonly ScrollWriteEvent[],
): void {
    if (writes.length === 0) return;
    const lastWrite = writes[writes.length - 1]!;
    const confirmed = events.some((event) =>
        event.type === 'scroll-observed' && event.timestampMs >= lastWrite.timestampMs);
    if (!confirmed) {
        failWithEvents(
            'Final viewport write was never confirmed by a scroll observation (E3):',
            [lastWrite],
        );
    }
}

function assertColdOpen(
    events: readonly TranscriptViewportTelemetryEvent[],
    options: ViewportTelemetryScenarioOptions,
): void {
    const writes = events.filter(isCommittedScrollWrite);
    const disallowed = writes.filter((event) => event.reason !== 'initial-open' && event.reason !== 'mount-settle');
    if (disallowed.length > 0) {
        failWithEvents('Invariant A violated: cold open issued writes outside {initial-open, mount-settle}:', disallowed);
    }
    if (writes.length > 2) {
        failWithEvents(`Invariant A violated: cold open issued writes=${writes.length} (max 2):`, writes);
    }
    assertFinalWriteConfirmed(events, writes);
    const observations = events.filter(isObservationEvent)
        .filter((event) => event.type === 'scroll-observed' && event.distanceFromBottom !== undefined);
    const finalObservation = observations[observations.length - 1];
    const pinThresholdPx = options.pinThresholdPx ?? DEFAULT_PIN_THRESHOLD_PX;
    if (finalObservation?.distanceFromBottom !== undefined && finalObservation.distanceFromBottom > pinThresholdPx) {
        failWithEvents(
            `Invariant A violated: cold open settled at distanceFromBottom=${finalObservation.distanceFromBottom} `
            + `(pin threshold ${pinThresholdPx}):`,
            [finalObservation],
        );
    }
    assertOwnerTargetSpread(events);
}

function assertWarmReopen(events: readonly TranscriptViewportTelemetryEvent[]): void {
    const writes = events.filter(isCommittedScrollWrite);
    const prependWrites = writes.filter((event) => deriveViewportWriteOwner(event) === 'prepend');
    if (prependWrites.length > 0) {
        failWithEvents('Invariant B violated: prepend writes issued during entry restore:', prependWrites);
    }
    const entryWrites = writes.filter((event) => deriveViewportWriteOwner(event) === 'entry');
    // N2b slice-from-anchor (NATIVE only — web keeps its write-based restore path):
    // anchored native entries land write-free (the data window starts at the anchor;
    // the observe-only transaction confirms by observation). An anchored entry is
    // identified by its slice decision pair (pending/restored, mode restore-anchor);
    // anchor-mode native entry WRITES no longer exist at all. The degraded
    // identity-less distance one-shot (missing-anchor lookups → restore-distance
    // write) keeps the legacy ≤2 budget below.
    const anchoredNativeEntryDecision = events.some((event) =>
        event.type === 'restore-decision' &&
        event.mode === 'restore-anchor' &&
        (event.reason === 'pending' || event.reason === 'restored') &&
        event.platform !== 'web');
    const anchorModeNativeEntryWrites = entryWrites.filter((event) =>
        event.mode === 'restore-anchor' && event.platform !== 'web');
    const nativeEntryWrites = entryWrites.filter((event) => event.platform !== 'web');
    if ((anchoredNativeEntryDecision || anchorModeNativeEntryWrites.length > 0) && nativeEntryWrites.length > 0) {
        failWithEvents(
            `Invariant B violated: anchored entry must land write-free (N2b slice) but issued writes=${nativeEntryWrites.length}:`,
            nativeEntryWrites,
        );
    }
    const distinctTargets = distinctTargetCount(entryWrites);
    if (entryWrites.length > 2 || distinctTargets > 2) {
        failWithEvents(
            `Invariant B violated: entry transaction wrote writes=${entryWrites.length} (max 2), `
            + `distinct targets=${distinctTargets} (max 2):`,
            entryWrites,
        );
    }
    assertFinalWriteConfirmed(events, entryWrites);
    assertOwnerTargetSpread(events);
}

/**
 * Invariant D: exactly one transaction outcome per prepend, with the write budget derived from
 * the outcome — `fallback-restored` = exactly ONE prepend write; every other outcome
 * (`mvcp-preserved` incl. the N2d.1 corrector-covered classification, and the abandoned family)
 * = ZERO writes. Since N2d.1 the expected-dominant outcome is `mvcp-preserved`: the transaction
 * defers to FlashList's own offset corrector, and the fallback write remains only for commits
 * the corrector demonstrably did not cover.
 */
function assertPrepend(events: readonly TranscriptViewportTelemetryEvent[]): void {
    const outcomes = events.filter(isObservationEvent)
        .filter((event) => event.reason !== undefined && TRANSACTION_OUTCOME_REASONS.has(event.reason));
    if (outcomes.length === 0) {
        failWithEvents('Invariant D violated: no prepend transaction outcome was emitted (silent prepend):', []);
    }
    if (outcomes.length > 1) {
        failWithEvents(`Invariant D violated: found ${outcomes.length} transaction outcomes (expected exactly 1):`, outcomes);
    }
    const outcome = outcomes[0]!;
    const prependWrites = events.filter(isCommittedScrollWrite)
        .filter((event) => deriveViewportWriteOwner(event) === 'prepend');
    const expectedWrites = outcome.reason === 'fallback-restored' ? 1 : 0;
    if (prependWrites.length !== expectedWrites) {
        failWithEvents(
            `Invariant D violated: outcome '${outcome.reason}' expects ${expectedWrites} prepend write(s) `
            + `but found ${prependWrites.length}:`,
            prependWrites,
        );
    }
    assertNoSilentBails(events);
    assertOwnerTargetSpread(events);
}

function assertManualScroll(events: readonly TranscriptViewportTelemetryEvent[]): void {
    const writes = events.filter(isCommittedScrollWrite);
    if (writes.length > 0) {
        failWithEvents(`Invariant E violated: manual scroll produced writes=${writes.length} (expected 0):`, writes);
    }
}

function assertStreamingPinned(events: readonly TranscriptViewportTelemetryEvent[]): void {
    const writes = events.filter(isCommittedScrollWrite);
    const foreignWrites = writes.filter((event) => deriveViewportWriteOwner(event) !== 'follow');
    if (foreignWrites.length > 0) {
        failWithEvents('Invariant F violated: non-follow owner wrote during pinned streaming:', foreignWrites);
    }
    const unpinnedWrites = writes.filter((event) => event.mode === 'user-unpinned');
    if (unpinnedWrites.length > 0) {
        failWithEvents('Invariant F violated: writes issued while mode=user-unpinned (pull-back):', unpinnedWrites);
    }
    const unattributable = writes.filter((event) => event.contentHeight === undefined);
    if (unattributable.length > 0) {
        failWithEvents('Invariant F violated: stream writes not attributable to a content version:', unattributable);
    }
    const writesByContentHeight = new Map<number, ScrollWriteEvent[]>();
    for (const write of writes) {
        const contentHeight = write.contentHeight!;
        const sameVersion = writesByContentHeight.get(contentHeight) ?? [];
        sameVersion.push(write);
        writesByContentHeight.set(contentHeight, sameVersion);
    }
    for (const [contentHeight, sameVersion] of writesByContentHeight) {
        if (sameVersion.length > 1) {
            failWithEvents(
                `Invariant F violated: ${sameVersion.length} writes for the same content version ${contentHeight}:`,
                sameVersion,
            );
        }
    }
}

export function assertScenario(
    events: readonly TranscriptViewportTelemetryEvent[],
    scenario: ViewportTelemetryScenario,
    options: ViewportTelemetryScenarioOptions = {},
): void {
    switch (scenario) {
        case 'cold-open':
            assertColdOpen(events, options);
            return;
        case 'warm-reopen':
            assertWarmReopen(events);
            return;
        case 'prepend':
            assertPrepend(events);
            return;
        case 'manual-scroll':
            assertManualScroll(events);
            return;
        case 'streaming-pinned':
            assertStreamingPinned(events);
            return;
    }
}
