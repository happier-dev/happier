import type {
    TranscriptViewportTelemetryObservationReason,
    TranscriptViewportTelemetryTransactionState,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    TranscriptViewportAnchorIdentity,
    TranscriptViewportControllerInput,
    TranscriptViewportMode,
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
    kind: 'anchor' | 'distance';
    sessionId: string;
    targetOffsetY: number | null;
    targetOffsetYWasClamped: boolean;
}>;

export type EntryRestoreOwnerCommandInput =
    | Extract<TranscriptViewportControllerInput, { type: 'restore-anchor' | 'restore-distance' }>
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
        targetSeq: number | null;
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
    userScrollObserved: boolean;
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
}>;

export type EntryRestoreOwnerNativeHostFactsInput = Readonly<{
    contentHeight: number;
    distanceFromBottom: number;
    layoutHeight: number;
    /**
     * True once the native mount-settle window declared row measurements quiescent.
     * Distance restores judged below the issued content height stay withheld until
     * this flips — then alignment is judged against the SETTLED geometry so the
     * transaction's single correction lands at the real position instead of the
     * estimate-space one (live clamp-to-tail defect, 2026-07-13).
     */
    mountSettleStable?: boolean;
    nowMs: number;
    observedOffsetY: number;
    resolveAnchorObservation(anchor: EntryRestoreOwnerAnchor): EntryRestoreTransactionObservation | null;
    sessionId: string;
    tolerancePx: number;
}>;

export type EntryRestoreOwner = Readonly<{
    attempt<TItem>(params: EntryRestoreOwnerAttemptInput<TItem>): readonly EntryRestoreOwnerEffect[];
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
        // once content arrives.
        if (
            params.platform === 'web' &&
            target.kind === 'none' &&
            target.reason === 'empty-transcript' &&
            !params.fillSettled
        ) {
            return [];
        }
        if (target.kind === 'materialize-then-anchor') {
            return materializeEffects(
                'missing-anchor',
                'restore-anchor',
                distanceFromBottom,
                target.anchorSeqHint,
                params,
            );
        }
        if (
            target.kind === 'distance-oneshot' &&
            distanceFromBottom > Math.max(0, Math.trunc(params.contentHeight - params.layoutHeight)) &&
            params.canMaterializeOlder
        ) {
            return materializeEffects('not-ready', 'restore-distance', distanceFromBottom, null, params);
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
        // Follow-bottom entry placement belongs to the fixed Legend renderer. The
        // entry-restore owner only accepts detached anchor/distance targets.
        if (target.kind === 'bottom') return [];

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
        } else {
            effects.push({
                command: buildDistanceCommand(params.currentSessionId, distanceFromBottom, params.contentHeight),
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

    function observeNative(params: EntryRestoreOwnerObservationInput): readonly EntryRestoreOwnerEffect[] {
        return observe(params, 'native');
    }

    function observeNativeHostFacts(params: EntryRestoreOwnerNativeHostFactsInput): readonly EntryRestoreOwnerEffect[] {
        if (!transaction || transaction.isClosed() || transaction.sessionId !== params.sessionId || !writeContext) return [];
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
        if (!transaction || transaction.isClosed() || transaction.sessionId !== params.sessionId || !writeContext) return [];
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
        lastClosedSessionId = null;
        suppressedSessionId = null;
        return [];
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
                mode: context?.kind === 'anchor' ? 'restore-anchor' : 'restore-distance',
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

    function openTransaction(params: Readonly<{
        context: EntryRestoreOwnerWriteContext | null;
        deadlineMs: number;
        nowMs: number;
        sessionId: string;
        target: EntryRestoreTransactionTarget;
    }>): readonly EntryRestoreOwnerEffect[] {
        transaction = createEntryRestoreTransaction({
            sessionId: params.sessionId,
            target: params.target,
            nowMs: params.nowMs,
            deadlineMs: params.deadlineMs,
        });
        writeContext = params.context;
        lastClosedSessionId = null;
        const effects: EntryRestoreOwnerEffect[] = [
            { deadlineMs: params.deadlineMs, sessionId: params.sessionId, type: 'schedule-entry-deadline' },
        ];
        effects.push({ pending: true, type: 'set-native-initial-viewport-pending-observation' });
        return effects;
    }

    function closeEffects(currentSessionId: string, platform: EntryRestoreOwnerPlatform): readonly EntryRestoreOwnerEffect[] {
        if (!transaction || !transaction.isClosed()) return [];
        const sessionId = transaction.sessionId;
        const outcome = transaction.outcome();
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
        return effects;
    }

    function correctionEffects(
        context: EntryRestoreOwnerWriteContext,
        params: EntryRestoreOwnerObservationInput,
        platform: EntryRestoreOwnerPlatform,
    ): readonly EntryRestoreOwnerEffect[] {
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
        const distance = context.distanceFromBottom;
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

    return {
        attempt,
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
    if (context.kind === 'anchor' && context.anchor) {
        return params.resolveAnchorObservation(context.anchor);
    }
    if (Math.abs(params.distanceFromBottom - context.distanceFromBottom) <= params.tolerancePx) {
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
        // Content below the issued height is normally mid-churn (rows still
        // measuring): withhold judgment. But once mount settle declares the
        // geometry quiescent, "below issued" means the issue-time height was
        // estimate-INFLATED and will never be reached again — withholding
        // forever leaves the clamped viewport at the tail with the correction
        // budget unspent. Judge the settled geometry instead.
        return params.mountSettleStable === true ? { status: 'misaligned' } : null;
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
    targetSeq: number | null,
    params: EntryRestoreOwnerAttemptInput<TItem>,
): readonly EntryRestoreOwnerEffect[] {
    return [
        {
            targetSeq: normalizeMaterializationTargetSeq(targetSeq),
            type: 'request-bounded-materialization',
        },
        restoreDecisionEffect(reason, mode, distanceFromBottom, params),
    ];
}

function normalizeMaterializationTargetSeq(value: number | null): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const seq = Math.trunc(value);
    return seq > 0 ? seq : null;
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
