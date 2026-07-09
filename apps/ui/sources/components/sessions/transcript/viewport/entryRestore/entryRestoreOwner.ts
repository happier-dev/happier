import type {
    TranscriptViewportTelemetryObservationReason,
    TranscriptViewportTelemetryTransactionState,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    TranscriptViewportAnchorIdentity,
    TranscriptViewportControllerInput,
    TranscriptViewportMode,
    TranscriptViewportScrollReason,
} from '../transcriptViewportTypes';
import type { TranscriptViewportTransactionOutcome } from '../transcriptViewportOwnership';
import { nativeEntryRestoreObservationMatches } from '../nativeEntryRestoreObservationPolicy';
import {
    createEntryRestoreTransaction,
    type EntryRestoreTransaction,
    type EntryRestoreTransactionObservation,
    type EntryRestoreTransactionTarget,
} from './entryRestoreTransaction';
import {
    resolveEntryRestoreCloseEffects,
    resolveEntryRestoreDisposeEffects,
    type EntryRestoreCloseEffect,
} from './entryRestoreCloseEffects';
import {
    resolveEntryRestoreTarget,
    type EntryRestoreAnchorSnapshot,
    type EntryRestoreFinalNoneReason,
    type EntryRestoreSliceTarget,
} from './resolveEntryRestoreTarget';

export type EntryRestoreOwnerPlatform = 'native' | 'web';

export type EntryRestoreOwnerAnchor = TranscriptViewportAnchorIdentity & Readonly<{
    capturedAtMs?: number;
    itemOffsetPx: number;
    seq?: number | null;
}>;

type EntryRestoreOwnerWriteContext = Readonly<{
    anchor: EntryRestoreOwnerAnchor | null;
    createdAtMs: number;
    distanceFromBottom: number;
    issuedContentHeight: number;
    issuedLayoutHeight: number;
    itemIndex: number | null;
    kind: 'anchor' | 'distance' | 'bottom' | 'slice-anchor';
    sessionId: string;
    targetOffsetY: number | null;
    targetOffsetYWasClamped: boolean;
}>;

type WebBottomSettleConfirmation = Readonly<{
    context: EntryRestoreOwnerWriteContext;
    spent: boolean;
}>;

const WEB_BOTTOM_ENTRY_CONFIRMATION_EPSILON_PX = 1;

export type EntryRestoreOwnerCommandInput =
    | Extract<TranscriptViewportControllerInput, { type: 'restore-anchor' | 'restore-distance' | 'first-paint' }>
    | Readonly<{
        anchor: EntryRestoreOwnerAnchor;
        itemIndex: number;
        sessionId: string;
        type: 'restore-web-anchor-through-command';
    }>;

export type EntryRestoreOwnerEffect =
    | Readonly<{
        command: EntryRestoreOwnerCommandInput;
        type: 'execute-command';
    }>
    | Readonly<{
        deadlineMs: number;
        sessionId: string;
        type: 'schedule-entry-deadline';
    }>
    | Readonly<{
        sessionId: string;
        type: 'clear-entry-deadline';
    }>
    | Readonly<{
        pending: boolean;
        type: 'set-native-initial-viewport-pending-observation';
    }>
    | Readonly<{
        anchorRowId: string;
        sessionId: string;
        type: 'set-entry-slice-window';
    }>
    | Readonly<{
        type: 'clear-entry-slice-window';
    }>
    | Readonly<{
        type: 'request-bounded-materialization';
    }>
    | Readonly<{
        contentHeight?: number;
        layoutHeight?: number;
        mode: TranscriptViewportMode;
        offsetY?: number;
        reason: TranscriptViewportTelemetryObservationReason;
        type: 'record-restore-decision';
    }>
    | Readonly<{
        mode: TranscriptViewportMode;
        offsetY?: number;
        reason: TranscriptViewportTelemetryObservationReason;
        sessionId: string;
        type: 'record-restore-decision-for-session';
    }>
    | Readonly<{
        outcome: TranscriptViewportTransactionOutcome;
        type: 'close-entry-ownership';
    }>
    | Readonly<{
        type: 'native-initial-viewport-applied';
    }>
    | Readonly<{
        force: true;
        type: 'schedule-native-entry-paint-release';
    }>
    | Readonly<{
        type: 'reveal-entry-slice-window';
    }>
    | Readonly<{
        reason: TranscriptViewportScrollReason;
        sessionId: string;
        type: 'request-bottom-follow-write';
        writer: 'settle-reconfirm';
    }>;

export type EntryRestoreOwnerAttemptInput<TItem> = Readonly<{
    canMaterializeOlder: boolean;
    contentHeight: number;
    currentSessionId: string;
    deadlineMs: number;
    exactAnchorCommandIndex?: number | null;
    exactAnchorIndex: number | null;
    fillSettled: boolean;
    items: readonly TItem[];
    jumpToSeqActive: boolean;
    layoutHeight: number;
    nearestAnchorCommandIndex?: number | null;
    nearestAnchorIndex: number | null;
    nowMs: number;
    platform: EntryRestoreOwnerPlatform;
    restoredViewport: Readonly<{
        anchor: EntryRestoreOwnerAnchor | null;
        anchorSeqLoaded?: boolean;
        offsetY: number | null;
        sessionId: string;
        shouldFollowBottom: boolean;
    }> | null;
    slice: EntryRestoreOwnerSliceInput;
    userScrollObserved: boolean;
}>;

export type EntryRestoreOwnerSliceInput =
    | Readonly<{ capable: false }>
    | Readonly<{
        anchorRowId?: string | null;
        capable: true;
        renderedAnchor?: EntryRestoreOwnerAnchor | null;
        renderedAnchorIndex?: number | null;
        target?: EntryRestoreSliceTarget | null;
        writeFree: boolean;
    }>;

export type EntryRestoreOwnerObservationInput = Readonly<{
    contentHeight: number;
    layoutHeight: number;
    nowMs: number;
    observation: EntryRestoreTransactionObservation;
    sessionId: string;
}>;

export type EntryRestoreOwnerWebHostFactsInput = Readonly<{
    contentHeight: number;
    distanceFromBottom: number;
    layoutHeight: number;
    nowMs: number;
    resolveAnchorObservation(anchor: EntryRestoreOwnerAnchor): EntryRestoreTransactionObservation | null;
    sessionId: string;
    tolerancePx: number;
    wantsPinned?: boolean;
}>;

export type EntryRestoreOwnerNativeHostFactsInput = Readonly<{
    contentHeight: number;
    distanceFromBottom: number;
    layoutHeight: number;
    nowMs: number;
    observedOffsetY: number;
    resolveAnchorObservation(anchor: EntryRestoreOwnerAnchor): EntryRestoreTransactionObservation | null;
    resolveSliceObservation(anchor: EntryRestoreOwnerAnchor): EntryRestoreTransactionObservation | null;
    sessionId: string;
    targetKind?: 'slice-anchor';
    tolerancePx: number;
}>;

export type EntryRestoreOwner = Readonly<{
    attempt<TItem>(params: EntryRestoreOwnerAttemptInput<TItem>): readonly EntryRestoreOwnerEffect[];
    beginWebBottom(params: Readonly<{
        contentHeight: number;
        deadlineMs: number;
        layoutHeight: number;
        nowMs: number;
        sessionId: string;
    }>): readonly EntryRestoreOwnerEffect[];
    disposeForExit(params: Readonly<{ currentSessionId: string }>): readonly EntryRestoreOwnerEffect[];
    hasOpenTransaction(sessionId: string): boolean;
    matchesNativePaintReleaseHandle(params: Readonly<{ issuedAtMs: number; sessionId: string }>): boolean;
    nativePaintReleaseHandle(params: Readonly<{ sessionId: string }>): Readonly<{ issuedAtMs: number }> | null;
    markInitialCommandFailed(params: Readonly<{ sessionId: string }>): readonly EntryRestoreOwnerEffect[];
    observeNative(params: EntryRestoreOwnerObservationInput): readonly EntryRestoreOwnerEffect[];
    observeNativeHostFacts(params: EntryRestoreOwnerNativeHostFactsInput): readonly EntryRestoreOwnerEffect[];
    observeWeb(params: EntryRestoreOwnerObservationInput): readonly EntryRestoreOwnerEffect[];
    observeWebHostFacts(params: EntryRestoreOwnerWebHostFactsInput): readonly EntryRestoreOwnerEffect[];
    preempt(params: Readonly<{ reason: 'jump' | 'prepend' | 'trusted-scroll'; sessionId: string }>): readonly EntryRestoreOwnerEffect[];
    resetForSession(params: Readonly<{ sessionId: string }>): readonly EntryRestoreOwnerEffect[];
    runDeadline(params: Readonly<{ nowMs: number; sessionId: string }>): readonly EntryRestoreOwnerEffect[];
    telemetryState(sessionId: string): TranscriptViewportTelemetryTransactionState;
    visibleDistanceForOpenNativeEntry(params: Readonly<{
        observedDistanceFromBottom: number;
        sessionId: string;
    }>): number | null;
}>;

export function createEntryRestoreOwner(): EntryRestoreOwner {
    let transaction: EntryRestoreTransaction | null = null;
    let writeContext: EntryRestoreOwnerWriteContext | null = null;
    let suppressedSessionId: string | null = null;
    let lastClosedSessionId: string | null = null;
    let webBottomSettleConfirmation: WebBottomSettleConfirmation | null = null;

    function attempt<TItem>(params: EntryRestoreOwnerAttemptInput<TItem>): readonly EntryRestoreOwnerEffect[] {
        const entryViewport = params.restoredViewport;
        if (!entryViewport || entryViewport.sessionId !== params.currentSessionId) return [];
        if (entryViewport.shouldFollowBottom !== false) return [];
        if (transaction != null) return [];
        if (lastClosedSessionId === params.currentSessionId) return [];
        if (suppressedSessionId === params.currentSessionId) return [];
        if (params.jumpToSeqActive || params.userScrollObserved) {
            suppressedSessionId = params.currentSessionId;
            return [{ outcome: 'preempted', type: 'close-entry-ownership' }];
        }

        const rememberedDistanceFromBottom = normalizeDistance(entryViewport.offsetY);
        const distanceFromBottom = rememberedDistanceFromBottom ?? 0;
        if (params.platform === 'native' && params.slice.capable && params.slice.target?.kind === 'slice') {
            const sliceEffects = attemptSlice({
                ...params,
                distanceFromBottom,
                restoredAnchor: entryViewport.anchor,
                slice: params.slice,
            });
            if (sliceEffects !== null) return sliceEffects;
            suppressedSessionId = null;
        }

        const target = resolveEntryRestoreTarget({
            snapshot: {
                anchor: toResolverAnchor(entryViewport.anchor),
                offsetY: rememberedDistanceFromBottom,
                shouldFollowBottom: false,
            },
            items: params.items,
            contentMeasured: {
                contentHeight: params.contentHeight,
                layoutHeight: params.layoutHeight,
            },
            fillSettled: params.fillSettled,
            canMaterializeOlder: params.canMaterializeOlder,
            anchorIndexResolver: () => params.exactAnchorIndex,
            anchorSeqLoadedResolver: () => entryViewport.anchorSeqLoaded === true,
            nearestSurvivingResolver: () => params.nearestAnchorIndex,
        });

        if (target.kind === 'none' && isWaitNoneReason(target.reason)) return [];
        // On web, the entry restore layout effect may fire before any items are
        // available (direct URL cold load: the React mount precedes the initial fill
        // loop). Treating `empty-transcript` as FINAL at this point sets
        // lastClosedSessionId and permanently blocks all subsequent retries.
        // Treat it as a wait verdict until the fill settles so the owner retries
        // once content arrives. Native is excluded: the slice path owns initial
        // materialization there and does not share this timing race.
        if (
            params.platform === 'web' &&
            target.kind === 'none' &&
            target.reason === 'empty-transcript' &&
            !params.fillSettled
        ) {
            return [];
        }
        if (target.kind === 'materialize-then-anchor') {
            return materializeEffects('missing-anchor', 'restore-anchor', distanceFromBottom, params);
        }
        if (
            target.kind === 'distance-oneshot' &&
            distanceFromBottom > Math.max(0, Math.trunc(params.contentHeight - params.layoutHeight)) &&
            params.canMaterializeOlder
        ) {
            return materializeEffects('not-ready', 'restore-distance', distanceFromBottom, params);
        }

        if (target.kind === 'none') {
            if (!isFinalNoneReason(target.reason)) return [];
            openTransaction({
                context: null,
                deadlineMs: params.deadlineMs,
                nowMs: params.nowMs,
                sessionId: params.currentSessionId,
                target: { kind: 'none', reason: target.reason },
            });
            return closeEffects(params.currentSessionId, params.platform);
        }

        if (target.kind === 'distance-oneshot' && rememberedDistanceFromBottom == null) {
            return [restoreDecisionEffect('skipped', 'restore-distance', undefined, params)];
        }

        const context = buildWriteContext({
            anchor: target.kind === 'anchor' ? entryViewport.anchor : null,
            contentHeight: params.contentHeight,
            distanceFromBottom,
            itemIndex: target.kind === 'anchor' ? target.index : null,
            kind: target.kind === 'anchor'
                ? 'anchor'
                : target.kind === 'bottom'
                    ? 'bottom'
                    : 'distance',
            layoutHeight: params.layoutHeight,
            nowMs: params.nowMs,
            sessionId: params.currentSessionId,
            targetOffsetY: target.kind === 'distance-oneshot' ? target.targetOffsetY : null,
            targetOffsetYWasClamped: target.kind === 'distance-oneshot' &&
                Math.max(0, Math.trunc(params.contentHeight - params.layoutHeight)) < distanceFromBottom,
        });
        const opened = openTransaction({
            context,
            deadlineMs: params.deadlineMs,
            nowMs: params.nowMs,
            sessionId: params.currentSessionId,
            target,
        });

        const effects: EntryRestoreOwnerEffect[] = [];
        if (target.kind === 'anchor') {
            const command = buildEntryAnchorCommand({
                anchor: entryViewport.anchor,
                itemIndex: resolveAnchorCommandIndex(target.index, params),
                itemOffsetPx: target.itemOffsetPx,
                platform: params.platform,
                sessionId: params.currentSessionId,
            });
            if (!command) {
                clearTransaction();
                return [restoreDecisionEffect('not-ready', 'restore-anchor', distanceFromBottom, params)];
            }
            effects.push({ command, type: 'execute-command' });
        } else if (target.kind === 'distance-oneshot') {
            effects.push({
                command: buildDistanceCommand(params.currentSessionId, distanceFromBottom, params.contentHeight),
                type: 'execute-command',
            });
        } else {
            effects.push({
                command: {
                    entrySnapshot: null,
                    jumpToSeq: null,
                    sessionId: params.currentSessionId,
                    shouldFollowBottom: true,
                    type: 'first-paint',
                },
                type: 'execute-command',
            });
        }
        effects.push(...opened);
        effects.push(restoreDecisionEffect(
            target.kind === 'distance-oneshot' ? 'entry-distance-oneshot' : 'pending',
            target.kind === 'anchor' ? 'restore-anchor' : 'restore-distance',
            distanceFromBottom,
            params,
        ));
        return effects;
    }

    function beginWebBottom(params: Readonly<{
        contentHeight: number;
        deadlineMs: number;
        layoutHeight: number;
        nowMs: number;
        sessionId: string;
    }>): readonly EntryRestoreOwnerEffect[] {
        if (transaction != null) return [];
        if (lastClosedSessionId === params.sessionId) return [];
        return openTransaction({
            context: buildWriteContext({
                anchor: null,
                contentHeight: params.contentHeight,
                distanceFromBottom: 0,
                kind: 'bottom',
                layoutHeight: params.layoutHeight,
                nowMs: params.nowMs,
                sessionId: params.sessionId,
                targetOffsetY: null,
                targetOffsetYWasClamped: false,
            }),
            deadlineMs: params.deadlineMs,
            nowMs: params.nowMs,
            sessionId: params.sessionId,
            target: { kind: 'bottom' },
        });
    }

    function observeNative(params: EntryRestoreOwnerObservationInput): readonly EntryRestoreOwnerEffect[] {
        return observe(params, 'native');
    }

    function observeNativeHostFacts(params: EntryRestoreOwnerNativeHostFactsInput): readonly EntryRestoreOwnerEffect[] {
        if (!transaction || transaction.isClosed() || transaction.sessionId !== params.sessionId || !writeContext) return [];
        if (params.targetKind === 'slice-anchor' && writeContext.kind !== 'slice-anchor') return [];
        const observation = resolveNativeHostObservation(writeContext, params);
        if (observation == null) return [];
        return observeNative({
            contentHeight: params.contentHeight,
            layoutHeight: params.layoutHeight,
            nowMs: params.nowMs,
            observation,
            sessionId: params.sessionId,
        });
    }

    function observeWeb(params: EntryRestoreOwnerObservationInput): readonly EntryRestoreOwnerEffect[] {
        return observe(params, 'web');
    }

    function observeWebHostFacts(params: EntryRestoreOwnerWebHostFactsInput): readonly EntryRestoreOwnerEffect[] {
        if (!transaction || transaction.isClosed() || transaction.sessionId !== params.sessionId || !writeContext) {
            return observeClosedWebBottomSettle(params);
        }
        const observation = resolveWebHostObservation(writeContext, params);
        if (observation == null) return [];
        return observeWeb({
            contentHeight: params.contentHeight,
            layoutHeight: params.layoutHeight,
            nowMs: params.nowMs,
            observation,
            sessionId: params.sessionId,
        });
    }

    function observe(
        params: EntryRestoreOwnerObservationInput,
        platform: EntryRestoreOwnerPlatform,
    ): readonly EntryRestoreOwnerEffect[] {
        if (!transaction || transaction.isClosed() || transaction.sessionId !== params.sessionId || !writeContext) return [];
        const directive = transaction.onObservation(params.observation, params.nowMs);
        if (transaction.isClosed()) {
            return closeEffects(params.sessionId, platform);
        }
        if (directive.action !== 'issue-correction-write') return [];
        return correctionEffects(writeContext, params, platform);
    }

    function preempt(params: Readonly<{ reason: 'jump' | 'prepend' | 'trusted-scroll'; sessionId: string }>): readonly EntryRestoreOwnerEffect[] {
        void params.reason;
        if (webBottomSettleConfirmation?.context.sessionId === params.sessionId) {
            webBottomSettleConfirmation = null;
        }
        if (transaction && !transaction.isClosed() && transaction.sessionId === params.sessionId) {
            transaction.onTrustedUserScroll();
            return closeEffects(params.sessionId, 'native');
        }
        if (!transaction) {
            suppressedSessionId = params.sessionId;
        }
        return [{ outcome: 'preempted', type: 'close-entry-ownership' }];
    }

    function runDeadline(params: Readonly<{ nowMs: number; sessionId: string }>): readonly EntryRestoreOwnerEffect[] {
        if (!transaction || transaction.sessionId !== params.sessionId || transaction.isClosed()) return [];
        transaction.onDeadline(params.nowMs);
        if (!transaction.isClosed()) return [];
        return closeEffects(params.sessionId, 'native');
    }

    function disposeForExit(params: Readonly<{ currentSessionId: string }>): readonly EntryRestoreOwnerEffect[] {
        void params.currentSessionId;
        if (!transaction || transaction.isClosed()) return [];
        const sessionId = transaction.sessionId;
        transaction.onTrustedUserScroll();
        const effects = [
            { sessionId, type: 'clear-entry-deadline' } as const,
            ...mapCloseEffects(resolveEntryRestoreDisposeEffects({
                sessionId,
                writeContext,
            })),
        ];
        clearTransaction({ closedSessionId: sessionId });
        return effects;
    }

    function resetForSession(params: Readonly<{ sessionId: string }>): readonly EntryRestoreOwnerEffect[] {
        void params;
        clearTransaction();
        webBottomSettleConfirmation = null;
        lastClosedSessionId = null;
        suppressedSessionId = null;
        return [
            { type: 'clear-entry-slice-window' },
        ];
    }

    function markInitialCommandFailed(params: Readonly<{ sessionId: string }>): readonly EntryRestoreOwnerEffect[] {
        if (!transaction || transaction.sessionId !== params.sessionId) return [];
        const context = writeContext;
        clearTransaction();
        return [
            { sessionId: params.sessionId, type: 'clear-entry-deadline' },
            {
                contentHeight: context?.issuedContentHeight,
                layoutHeight: context?.issuedLayoutHeight,
                mode: context?.kind === 'anchor' || context?.kind === 'slice-anchor' ? 'restore-anchor' : 'restore-distance',
                offsetY: context?.distanceFromBottom,
                reason: 'not-ready',
                type: 'record-restore-decision',
            },
        ];
    }

    function hasOpenTransaction(sessionId: string): boolean {
        return transaction?.sessionId === sessionId && !transaction.isClosed();
    }

    function nativePaintReleaseHandle(params: Readonly<{ sessionId: string }>): Readonly<{ issuedAtMs: number }> | null {
        if (!hasOpenTransaction(params.sessionId) || !writeContext) return null;
        return { issuedAtMs: writeContext.createdAtMs };
    }

    function matchesNativePaintReleaseHandle(params: Readonly<{ issuedAtMs: number; sessionId: string }>): boolean {
        return (
            hasOpenTransaction(params.sessionId) &&
            writeContext?.createdAtMs === params.issuedAtMs
        );
    }

    function telemetryState(sessionId: string): TranscriptViewportTelemetryTransactionState {
        if (hasOpenTransaction(sessionId)) return 'open';
        if (lastClosedSessionId === sessionId) return 'closed';
        return 'none';
    }

    function visibleDistanceForOpenNativeEntry(params: Readonly<{
        observedDistanceFromBottom: number;
        sessionId: string;
    }>): number | null {
        if (!hasOpenTransaction(params.sessionId)) return null;
        return Math.max(
            0,
            Math.trunc(Math.max(
                writeContext?.distanceFromBottom ?? 0,
                params.observedDistanceFromBottom,
            )),
        );
    }

    function attemptSlice<TItem>(params: EntryRestoreOwnerAttemptInput<TItem> & Readonly<{
        distanceFromBottom: number;
        restoredAnchor: EntryRestoreOwnerAnchor | null;
        slice: Extract<EntryRestoreOwnerSliceInput, { capable: true }>;
    }>): readonly EntryRestoreOwnerEffect[] | null {
        const renderedAnchor = params.slice.renderedAnchor ?? null;
        const sliceIndex = params.slice.renderedAnchorIndex ?? null;
        if (renderedAnchor == null || sliceIndex == null) {
            if (params.canMaterializeOlder && params.restoredViewport?.anchorSeqLoaded !== true) {
                return materializeEffects('missing-anchor', 'restore-anchor', params.distanceFromBottom, params);
            }
            return null;
        }
        if (!params.slice.writeFree) {
            const target: EntryRestoreTransactionTarget = {
                kind: 'anchor',
                index: sliceIndex,
                itemOffsetPx: params.slice.target?.anchorItemOffsetPx ?? renderedAnchor.itemOffsetPx,
            };
            const command = buildAnchorCommand(params.currentSessionId, renderedAnchor, target.itemOffsetPx);
            if (!command) return [restoreDecisionEffect('not-ready', 'restore-anchor', params.distanceFromBottom, params)];
            const opened = openTransaction({
                context: buildWriteContext({
                    anchor: renderedAnchor,
                    contentHeight: params.contentHeight,
                    distanceFromBottom: params.distanceFromBottom,
                    kind: 'anchor',
                    layoutHeight: params.layoutHeight,
                    nowMs: params.nowMs,
                    sessionId: params.currentSessionId,
                    targetOffsetY: null,
                    targetOffsetYWasClamped: false,
                }),
                deadlineMs: params.deadlineMs,
                nowMs: params.nowMs,
                sessionId: params.currentSessionId,
                target,
            });
            return [
                { command, type: 'execute-command' },
                ...opened,
                restoreDecisionEffect('pending', 'restore-anchor', params.distanceFromBottom, params),
            ];
        }
        const anchorRowId = params.slice.anchorRowId;
        if (typeof anchorRowId !== 'string' || anchorRowId.length === 0) return null;
        const opened = openTransaction({
            context: buildWriteContext({
                anchor: renderedAnchor,
                contentHeight: params.contentHeight,
                distanceFromBottom: params.distanceFromBottom,
                kind: 'slice-anchor',
                layoutHeight: params.layoutHeight,
                nowMs: params.nowMs,
                sessionId: params.currentSessionId,
                targetOffsetY: null,
                targetOffsetYWasClamped: false,
            }),
            deadlineMs: params.deadlineMs,
            nowMs: params.nowMs,
            sessionId: params.currentSessionId,
            target: { kind: 'anchor', index: 0, itemOffsetPx: 0 },
            writePolicy: 'observe-only',
        });
        return [
            { anchorRowId, sessionId: params.currentSessionId, type: 'set-entry-slice-window' },
            ...opened,
            restoreDecisionEffect('pending', 'restore-anchor', params.distanceFromBottom, params),
        ];
    }

    function openTransaction(params: Readonly<{
        context: EntryRestoreOwnerWriteContext | null;
        deadlineMs: number;
        nowMs: number;
        sessionId: string;
        target: EntryRestoreTransactionTarget;
        writePolicy?: 'issue-initial-write' | 'observe-only';
    }>): readonly EntryRestoreOwnerEffect[] {
        webBottomSettleConfirmation = null;
        transaction = createEntryRestoreTransaction({
            sessionId: params.sessionId,
            target: params.target,
            nowMs: params.nowMs,
            deadlineMs: params.deadlineMs,
            writePolicy: params.writePolicy,
        });
        writeContext = params.context;
        lastClosedSessionId = null;
        const effects: EntryRestoreOwnerEffect[] = [
            { deadlineMs: params.deadlineMs, sessionId: params.sessionId, type: 'schedule-entry-deadline' },
        ];
        if (params.context?.kind !== 'bottom') {
            effects.push({ pending: true, type: 'set-native-initial-viewport-pending-observation' });
        }
        return effects;
    }

    function closeEffects(currentSessionId: string, platform: EntryRestoreOwnerPlatform): readonly EntryRestoreOwnerEffect[] {
        if (!transaction || !transaction.isClosed()) return [];
        const sessionId = transaction.sessionId;
        const outcome = transaction.outcome();
        const settledBottomContext =
            platform === 'web' &&
            outcome === 'confirmed' &&
            writeContext?.kind === 'bottom'
                ? writeContext
                : null;
        const effects = [
            { sessionId, type: 'clear-entry-deadline' } as const,
            ...mapCloseEffects(resolveEntryRestoreCloseEffects({
                currentSessionId,
                outcome,
                platform,
                sessionId,
                writeContext,
            })),
        ];
        clearTransaction({ closedSessionId: sessionId });
        webBottomSettleConfirmation = settledBottomContext
            ? { context: settledBottomContext, spent: false }
            : null;
        return effects;
    }

    function correctionEffects(
        context: EntryRestoreOwnerWriteContext,
        params: EntryRestoreOwnerObservationInput,
        platform: EntryRestoreOwnerPlatform,
    ): readonly EntryRestoreOwnerEffect[] {
        if (context.kind === 'slice-anchor') return [];
        if (context.kind === 'anchor' && context.anchor) {
            const command = buildEntryAnchorCommand({
                anchor: context.anchor,
                animated: false,
                itemIndex: context.itemIndex,
                itemOffsetPx: context.anchor.itemOffsetPx,
                platform,
                sessionId: params.sessionId,
            });
            return command ? [{ command, type: 'execute-command' }] : [];
        }
        const distance = context.kind === 'bottom' ? 0 : context.distanceFromBottom;
        const issuedContentHeight = Math.max(0, Math.trunc(params.contentHeight));
        if (context.kind === 'distance') {
            const maxOffsetY = Math.max(0, Math.trunc(issuedContentHeight - params.layoutHeight));
            writeContext = {
                ...context,
                issuedContentHeight,
                targetOffsetY: Math.max(0, maxOffsetY - distance),
                targetOffsetYWasClamped: maxOffsetY < distance,
            };
        }
        return [
            {
                command: buildDistanceCommand(params.sessionId, distance, issuedContentHeight, false),
                type: 'execute-command',
            },
        ];
    }

    function clearTransaction(options: Readonly<{ closedSessionId?: string }> = {}): void {
        lastClosedSessionId = options.closedSessionId ?? lastClosedSessionId;
        transaction = null;
        writeContext = null;
    }

    function observeClosedWebBottomSettle(
        params: EntryRestoreOwnerWebHostFactsInput,
    ): readonly EntryRestoreOwnerEffect[] {
        const confirmation = webBottomSettleConfirmation;
        if (!confirmation || confirmation.spent || confirmation.context.sessionId !== params.sessionId) return [];
        if (params.wantsPinned !== true) return [];
        const observation = resolveWebHostObservation(confirmation.context, params);
        if (observation == null || observation.status !== 'misaligned') return [];
        webBottomSettleConfirmation = { ...confirmation, spent: true };
        return [{
            reason: 'mount-settle',
            sessionId: params.sessionId,
            type: 'request-bottom-follow-write',
            writer: 'settle-reconfirm',
        }];
    }

    return {
        attempt,
        beginWebBottom,
        disposeForExit,
        hasOpenTransaction,
        matchesNativePaintReleaseHandle,
        nativePaintReleaseHandle,
        markInitialCommandFailed,
        observeNative,
        observeNativeHostFacts,
        observeWeb,
        observeWebHostFacts,
        preempt,
        resetForSession,
        runDeadline,
        telemetryState,
        visibleDistanceForOpenNativeEntry,
    };
}

function resolveWebHostObservation(
    context: EntryRestoreOwnerWriteContext,
    params: EntryRestoreOwnerWebHostFactsInput,
): EntryRestoreTransactionObservation | null {
    if ((context.kind === 'anchor' || context.kind === 'slice-anchor') && context.anchor) {
        return params.resolveAnchorObservation(context.anchor);
    }
    const distanceTarget = context.kind === 'bottom' ? 0 : context.distanceFromBottom;
    const alignmentTolerancePx = context.kind === 'bottom'
        ? WEB_BOTTOM_ENTRY_CONFIRMATION_EPSILON_PX
        : params.tolerancePx;
    if (Math.abs(params.distanceFromBottom - distanceTarget) <= alignmentTolerancePx) {
        return { status: 'aligned' };
    }
    if (params.contentHeight + params.tolerancePx >= context.issuedContentHeight) {
        return { status: 'misaligned' };
    }
    return null;
}

function resolveNativeHostObservation(
    context: EntryRestoreOwnerWriteContext,
    params: EntryRestoreOwnerNativeHostFactsInput,
): EntryRestoreTransactionObservation | null {
    if (context.kind === 'slice-anchor' && context.anchor) {
        return params.resolveSliceObservation(context.anchor);
    }
    if (context.kind === 'anchor' && context.anchor) {
        return params.resolveAnchorObservation(context.anchor);
    }
    if (context.kind !== 'distance') return null;
    const matches = nativeEntryRestoreObservationMatches({
        contentHeight: context.issuedContentHeight,
        kind: 'distance',
        offsetY: context.distanceFromBottom,
        sessionId: context.sessionId,
        targetOffsetY: context.targetOffsetY ?? undefined,
        targetOffsetYWasClamped: context.targetOffsetYWasClamped,
    }, {
        contentHeight: params.contentHeight,
        distanceFromBottom: params.distanceFromBottom,
        observedOffsetY: params.observedOffsetY,
        sessionId: params.sessionId,
        tolerancePx: params.tolerancePx,
    });
    if (matches) return { status: 'aligned' };
    if (params.contentHeight + params.tolerancePx < context.issuedContentHeight) {
        return null;
    }
    return { status: 'misaligned' };
}

function buildWriteContext(params: Readonly<{
    anchor: EntryRestoreOwnerAnchor | null;
    contentHeight: number;
    distanceFromBottom: number;
    kind: EntryRestoreOwnerWriteContext['kind'];
    itemIndex?: number | null;
    layoutHeight: number;
    nowMs: number;
    sessionId: string;
    targetOffsetY: number | null;
    targetOffsetYWasClamped: boolean;
}>): EntryRestoreOwnerWriteContext {
    return {
        anchor: params.anchor,
        createdAtMs: params.nowMs,
        distanceFromBottom: params.distanceFromBottom,
        issuedContentHeight: Math.max(0, Math.trunc(params.contentHeight)),
        issuedLayoutHeight: Math.max(0, Math.trunc(params.layoutHeight)),
        itemIndex:
            typeof params.itemIndex === 'number' && Number.isFinite(params.itemIndex)
                ? Math.max(0, Math.trunc(params.itemIndex))
                : null,
        kind: params.kind,
        sessionId: params.sessionId,
        targetOffsetY: params.targetOffsetY,
        targetOffsetYWasClamped: params.targetOffsetYWasClamped,
    };
}

function buildAnchorCommand(
    sessionId: string,
    anchor: EntryRestoreOwnerAnchor | null,
    itemOffsetPx: number,
    animated?: boolean,
): Extract<TranscriptViewportControllerInput, { type: 'restore-anchor' }> | null {
    if (!anchor) return null;
    return {
        anchor: toCommandAnchor(anchor),
        itemOffsetPx,
        reason: 'entry-restore',
        sessionId,
        type: 'restore-anchor',
        ...(animated === undefined ? {} : { animated }),
    };
}

function buildEntryAnchorCommand(params: Readonly<{
    anchor: EntryRestoreOwnerAnchor | null;
    animated?: boolean;
    itemIndex?: number | null;
    itemOffsetPx: number;
    platform: EntryRestoreOwnerPlatform;
    sessionId: string;
}>): Extract<EntryRestoreOwnerCommandInput, { type: 'restore-anchor' | 'restore-web-anchor-through-command' }> | null {
    if (!params.anchor) return null;
    if (params.platform === 'web') {
        if (typeof params.itemIndex !== 'number' || !Number.isFinite(params.itemIndex)) return null;
        return {
            anchor: params.anchor,
            itemIndex: Math.max(0, Math.trunc(params.itemIndex)),
            sessionId: params.sessionId,
            type: 'restore-web-anchor-through-command',
        };
    }
    return buildAnchorCommand(params.sessionId, params.anchor, params.itemOffsetPx, params.animated);
}

function resolveAnchorCommandIndex<TItem>(
    targetIndex: number,
    params: EntryRestoreOwnerAttemptInput<TItem>,
): number {
    const commandIndex =
        targetIndex === params.exactAnchorIndex
            ? params.exactAnchorCommandIndex
            : targetIndex === params.nearestAnchorIndex
                ? params.nearestAnchorCommandIndex
                : null;
    return typeof commandIndex === 'number' && Number.isFinite(commandIndex)
        ? Math.max(0, Math.trunc(commandIndex))
        : targetIndex;
}

function buildDistanceCommand(
    sessionId: string,
    distanceFromBottom: number,
    contentHeight: number,
    animated?: boolean,
): Extract<TranscriptViewportControllerInput, { type: 'restore-distance' }> {
    return {
        animated,
        contentHeight,
        distanceFromLiveTailPx: distanceFromBottom,
        reason: 'entry-restore',
        sessionId,
        type: 'restore-distance',
    };
}

function toCommandAnchor(anchor: EntryRestoreOwnerAnchor): TranscriptViewportAnchorIdentity {
    return {
        kind: anchor.kind,
        itemId: anchor.itemId,
        messageId: anchor.messageId ?? null,
    };
}

function toResolverAnchor(anchor: EntryRestoreOwnerAnchor | null): EntryRestoreAnchorSnapshot | null {
    if (!anchor) return null;
    return {
        itemId: anchor.itemId,
        itemOffsetPx: anchor.itemOffsetPx,
        messageId: anchor.messageId,
        seq: anchor.seq,
    };
}

function materializeEffects<TItem>(
    reason: TranscriptViewportTelemetryObservationReason,
    mode: Extract<TranscriptViewportMode, 'restore-anchor' | 'restore-distance'>,
    distanceFromBottom: number,
    params: EntryRestoreOwnerAttemptInput<TItem>,
): readonly EntryRestoreOwnerEffect[] {
    return [
        { type: 'request-bounded-materialization' },
        restoreDecisionEffect(reason, mode, distanceFromBottom, params),
    ];
}

function restoreDecisionEffect<TItem>(
    reason: TranscriptViewportTelemetryObservationReason,
    mode: TranscriptViewportMode,
    distanceFromBottom: number | undefined,
    params: EntryRestoreOwnerAttemptInput<TItem>,
): EntryRestoreOwnerEffect {
    return {
        contentHeight: params.contentHeight,
        layoutHeight: params.layoutHeight,
        mode,
        offsetY: distanceFromBottom,
        reason,
        type: 'record-restore-decision',
    };
}

function mapCloseEffects(effects: readonly EntryRestoreCloseEffect[]): readonly EntryRestoreOwnerEffect[] {
    return effects.map((effect): EntryRestoreOwnerEffect => {
        switch (effect.type) {
            case 'close-entry-ownership':
                return effect;
            case 'restore-decision':
                return { ...effect, type: 'record-restore-decision' };
            case 'restore-decision-for-session':
                return { ...effect, type: 'record-restore-decision-for-session' };
            case 'native-initial-viewport-applied':
                return effect;
            case 'release-native-entry-paint':
                return { force: true, type: 'schedule-native-entry-paint-release' };
            case 'reveal-entry-slice-window':
                return effect;
        }
    });
}

function normalizeDistance(value: number | null): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function isWaitNoneReason(reason: string): boolean {
    return reason === 'awaiting-fill-settle' || reason === 'content-unmeasured';
}

function isFinalNoneReason(reason: string): reason is EntryRestoreFinalNoneReason {
    return !isWaitNoneReason(reason);
}
