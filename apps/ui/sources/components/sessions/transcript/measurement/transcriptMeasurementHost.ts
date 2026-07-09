import {
    getDefaultTranscriptItemHeightCache,
    type TranscriptItemHeightCache,
} from './transcriptItemHeightCache';
import type { TranscriptRowLayoutMutation } from './TranscriptRowLayoutMutationContext';
import {
    createTranscriptMeasurementReconciler,
    type TranscriptGlobalInvalidationReason,
    type TranscriptMeasurementReconciler,
} from './transcriptMeasurementReconciler';

export type TranscriptMeasurementHostPlatform = 'web' | 'native';

export type TranscriptMeasurementContentSizeReason =
    | 'content-size-change'
    | 'stream-append';

export type TranscriptMeasurementHostEffect =
    | Readonly<{
        type: 'clear-layout-cache';
        reason: TranscriptGlobalInvalidationReason;
    }>;

export type TranscriptMeasurementHostRowLayoutMutationResult = Readonly<{
    effects: readonly TranscriptMeasurementHostEffect[];
}>;

export type TranscriptMeasurementHostContentSizeObservation =
    | Readonly<{ status: 'ignored' }>
    | Readonly<{
        status: 'measured';
        measuredContentHeight: number;
        previousMeasuredContentHeight: number;
        contentHeightChanged: boolean;
        contentHeightGrew: boolean;
        reason: TranscriptMeasurementContentSizeReason;
    }>;

export type TranscriptMeasurementHost = Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    advanceLayoutInvalidationCommitToken(): void;
    resetForSession(input: Readonly<{ sessionId: string }>): void;
    observeRowLayoutMutation(input: Readonly<{
        mutation: TranscriptRowLayoutMutation;
        viewportTransactionOpen: boolean;
    }>): TranscriptMeasurementHostRowLayoutMutationResult;
    observeContentSizeChange(input: Readonly<{
        platform: TranscriptMeasurementHostPlatform;
        sessionId: string;
        rawContentHeight: number;
        previousMeasuredContentHeight: number;
        composerInsetHeight: number;
        sessionActive: boolean;
        latestCommittedActivityKey: string | null;
    }>): TranscriptMeasurementHostContentSizeObservation;
    hasNativeContentMeasurementForSession(input: Readonly<{
        platform: TranscriptMeasurementHostPlatform;
        sessionId: string;
    }>): boolean;
}>;

export type TranscriptMeasurementHostOptions = Readonly<{
    cache?: TranscriptItemHeightCache;
    reconciler?: TranscriptMeasurementReconciler;
}>;

function normalizeNonNegativeHeight(value: number): number | null {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}

function resolveMeasuredContentHeight(input: Readonly<{
    platform: TranscriptMeasurementHostPlatform;
    rawContentHeight: number;
    composerInsetHeight: number;
}>): number | null {
    const normalizedContentHeight = normalizeNonNegativeHeight(input.rawContentHeight);
    if (normalizedContentHeight === null) return null;
    if (input.platform === 'web') return normalizedContentHeight;
    const normalizedComposerInsetHeight = normalizeNonNegativeHeight(input.composerInsetHeight) ?? 0;
    return normalizedContentHeight + normalizedComposerInsetHeight;
}

export function createTranscriptMeasurementHost(
    options: TranscriptMeasurementHostOptions = {},
): TranscriptMeasurementHost {
    const reconciler = options.reconciler ?? createTranscriptMeasurementReconciler({
        cache: options.cache ?? getDefaultTranscriptItemHeightCache(),
    });

    let layoutInvalidationCommitToken = 0;
    let nativeContentMeasurementSession: { sessionId: string; measured: boolean } | null = null;
    let lastMeasuredContentActivityKey: string | null = null;

    return {
        reconciler,

        advanceLayoutInvalidationCommitToken() {
            layoutInvalidationCommitToken += 1;
        },

        resetForSession(input) {
            reconciler.resetForSession(input.sessionId);
            nativeContentMeasurementSession = { sessionId: input.sessionId, measured: false };
            lastMeasuredContentActivityKey = null;
        },

        observeRowLayoutMutation(input) {
            const { reason, previousSignature, nextSignature } = input.mutation;
            const decision = (reason === 'signature-change' && previousSignature !== undefined && nextSignature !== undefined)
                ? reconciler.requestGlobalLayoutInvalidation({
                    previous: previousSignature,
                    next: nextSignature,
                    viewportTransactionOpen: input.viewportTransactionOpen,
                    commitToken: layoutInvalidationCommitToken,
                })
                : reconciler.requestGlobalLayoutInvalidation({
                    structural: reason === 'expand' || reason === 'collapse',
                    viewportTransactionOpen: input.viewportTransactionOpen,
                    commitToken: layoutInvalidationCommitToken,
                });

            return {
                effects: decision.clear
                    ? [{ type: 'clear-layout-cache', reason: decision.reason }]
                    : [],
            };
        },

        observeContentSizeChange(input) {
            const measuredContentHeight = resolveMeasuredContentHeight(input);
            if (measuredContentHeight === null) return { status: 'ignored' };

            const previousMeasuredContentHeight = input.previousMeasuredContentHeight;
            const contentHeightChanged = previousMeasuredContentHeight !== measuredContentHeight;
            const contentHeightGrew = measuredContentHeight > previousMeasuredContentHeight;
            const previousMeasuredActivityKey = lastMeasuredContentActivityKey;
            const latestActivityKey = input.latestCommittedActivityKey;
            const hasMaterializedPreviousContent = previousMeasuredContentHeight > 0;
            const reason: TranscriptMeasurementContentSizeReason =
                input.sessionActive &&
                hasMaterializedPreviousContent &&
                previousMeasuredActivityKey != null &&
                latestActivityKey != null &&
                previousMeasuredActivityKey !== latestActivityKey
                    ? 'stream-append'
                    : 'content-size-change';

            if (input.platform === 'native') {
                nativeContentMeasurementSession = { sessionId: input.sessionId, measured: true };
            }
            lastMeasuredContentActivityKey = latestActivityKey;

            return {
                status: 'measured',
                measuredContentHeight,
                previousMeasuredContentHeight,
                contentHeightChanged,
                contentHeightGrew,
                reason,
            };
        },

        hasNativeContentMeasurementForSession(input) {
            if (input.platform === 'web') return true;
            return nativeContentMeasurementSession?.sessionId === input.sessionId &&
                nativeContentMeasurementSession.measured === true;
        },
    };
}
