import * as React from 'react';
import { Platform } from 'react-native';

import type {
    TranscriptViewportTelemetryEvent,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    TranscriptViewportCommandController,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import type { TranscriptViewportCommandHost } from '@/components/sessions/transcript/viewport/driver/commandHost';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import {
    captureNativeTranscriptViewportAnchor,
} from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import {
    createNativePrependOwner,
    type NativePrependBeginInput,
    type NativePrependObservationInput,
    type NativePrependOwner,
    type NativePrependOwnerEffect,
} from '@/components/sessions/transcript/viewport/prepend/nativePrependOwner';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptViewportMode } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';

type MutableRef<T> = { current: T };

type TranscriptPrependHostDeps = Readonly<{
    commandHostRef: MutableRef<TranscriptViewportCommandHost | null>;
    currentSessionId: string;
    listContentHeight: number;
    listContentHeightRef: MutableRef<number>;
    listDataLength: number;
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    preemptEntryRestoreTransaction: () => void;
    recordViewportTelemetryEvent: (
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ) => void;
    viewportCommandController: TranscriptViewportCommandController;
    wantsPinnedRef: MutableRef<boolean>;
}>;

export type TranscriptPrependHost = Readonly<{
    applyNativeEffects: (effects: readonly NativePrependOwnerEffect[]) => void;
    armNativeCommit: (layoutTimeoutMs: number) => void;
    beginNativeTransaction: () => boolean;
    getNativeTransactionRevision: () => number;
    hasOpenNativeTransaction: (sessionId?: string) => boolean;
    invalidateNativeTransaction: (reason?: 'identity' | 'session-entry' | 'load-empty' | 'jump' | 'dispose' | 'ownership-rejected') => void;
    nativeTelemetryState: (sessionId?: string) => ReturnType<NativePrependOwner['telemetryState']>;
    observeNative: () => void;
    recordCorrectorCorrection: (diffPx: number) => void;
    trustedNativeScroll: NativePrependOwner['trustedScroll'];
}>;

export function useTranscriptPrependHost(deps: TranscriptPrependHostDeps): TranscriptPrependHost {
    const [nativeTransactionRevision, bumpNativeTransactionRevision] = React.useReducer(
        (value: number) => value + 1,
        0,
    );
    const nativeOwnerRef = React.useRef<NativePrependOwner | null>(null);
    if (nativeOwnerRef.current === null) {
        nativeOwnerRef.current = createNativePrependOwner();
    }
    const nativeOwner = nativeOwnerRef.current;
    const applyNativeEffectsRef = React.useRef<(effects: readonly NativePrependOwnerEffect[]) => void>(() => {});
    const nativeLayoutTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeCorrectorReobserveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeTransactionRevisionRef = React.useRef(nativeTransactionRevision);
    useCommittedTranscriptRef(
        nativeTransactionRevisionRef,
        nativeTransactionRevision,
    );

    const resolveNativeObservationInput = React.useCallback((sessionId: string): NativePrependObservationInput => {
        const node = deps.listRef.current;
        const absoluteScrollOffset = readNativeAbsoluteScrollOffset(node) ?? Number.NaN;
        return {
            activeOwner: deps.viewportCommandController.activeOwner(),
            postCommit: {
                absoluteScrollOffset,
                contentHeight: deps.listContentHeightRef.current,
                getLayout: (index: number) => {
                    try {
                        return node?.getLayout?.(index) ?? undefined;
                    } catch {
                        return undefined;
                    }
                },
                items: deps.listDataRef.current,
                layoutHeight: deps.listLayoutHeightRef.current,
            },
            sessionId,
        };
    }, [
        deps.listContentHeightRef,
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.viewportCommandController,
    ]);

    const applyNativeEffects = React.useCallback((
        effects: readonly NativePrependOwnerEffect[],
    ) => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'preempt-entry-restore-for-prepend':
                    deps.preemptEntryRestoreTransaction();
                    break;
                case 'open-prepend-ownership': {
                    const openResult = deps.viewportCommandController.openTransaction('prepend');
                    if (!openResult.opened) {
                        applyNativeEffectsRef.current(nativeOwner.invalidate({
                            activeOwner: deps.viewportCommandController.activeOwner(),
                            reason: 'ownership-rejected',
                            sessionId: effect.sessionId,
                        }));
                    }
                    break;
                }
                case 'close-prepend-ownership':
                    if (deps.viewportCommandController.activeOwner() === 'prepend') {
                        deps.viewportCommandController.closeTransaction('prepend', effect.outcome);
                    }
                    break;
                case 'execute-command':
                    executeCommandHostInput(deps.commandHostRef, effect.command);
                    break;
                case 'schedule-layout-timeout': {
                    const existing = nativeLayoutTimerRef.current;
                    if (existing != null) clearTimeout(existing);
                    nativeLayoutTimerRef.current = setTimeout(() => {
                        nativeLayoutTimerRef.current = null;
                        applyNativeEffectsRef.current(nativeOwner.runLayoutTimeout(
                            resolveNativeObservationInput(effect.sessionId),
                        ));
                    }, effect.delayMs);
                    break;
                }
                case 'clear-layout-timeout': {
                    const existing = nativeLayoutTimerRef.current;
                    if (existing != null) {
                        nativeLayoutTimerRef.current = null;
                        clearTimeout(existing);
                    }
                    break;
                }
                case 'schedule-corrector-reobserve': {
                    const existing = nativeCorrectorReobserveTimerRef.current;
                    if (existing != null) clearTimeout(existing);
                    nativeCorrectorReobserveTimerRef.current = setTimeout(() => {
                        nativeCorrectorReobserveTimerRef.current = null;
                        applyNativeEffectsRef.current(nativeOwner.runCorrectorReobserve(
                            resolveNativeObservationInput(effect.sessionId),
                        ));
                    }, effect.delayMs);
                    break;
                }
                case 'clear-corrector-reobserve': {
                    const existing = nativeCorrectorReobserveTimerRef.current;
                    if (existing != null) {
                        nativeCorrectorReobserveTimerRef.current = null;
                        clearTimeout(existing);
                    }
                    break;
                }
                case 'bump-transaction-revision':
                    bumpNativeTransactionRevision();
                    break;
                case 'record-restore-decision-for-session':
                    deps.recordViewportTelemetryEvent({
                        type: 'restore-decision',
                        mode: effect.mode,
                        reason: effect.reason,
                        anchorItemOffsetPx: effect.anchorItemOffsetPx,
                        anchorDeltaPx: effect.anchorDeltaPx,
                        correctorAppliedDiffTotalPx: effect.correctorAppliedDiffTotalPx,
                        correctorEventCount: effect.correctorEventCount,
                    }, { sessionId: effect.sessionId });
                    break;
            }
        }
    }, [
        deps.commandHostRef,
        deps.preemptEntryRestoreTransaction,
        deps.recordViewportTelemetryEvent,
        deps.viewportCommandController,
        nativeOwner,
        resolveNativeObservationInput,
    ]);
    useCommittedTranscriptRef(applyNativeEffectsRef, applyNativeEffects);

    const captureNativeAnchor = React.useCallback((): NativePrependBeginInput['capturedAnchor'] => {
        const layoutHeight = deps.listLayoutHeightRef.current;
        const contentHeight = deps.listContentHeightRef.current;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
        if (!Number.isFinite(contentHeight) || contentHeight <= layoutHeight + 1) return null;

        const result = captureNativeTranscriptViewportAnchor({
            ref: deps.listRef.current,
            data: deps.listDataRef.current,
            focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(layoutHeight),
            capturedAtMs: Date.now(),
            resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
        });
        if (result.status !== 'captured') return null;
        if (!Number.isFinite(result.anchor.itemOffsetPx)) return null;
        const anchorItemId = result.anchor.itemId;
        if (typeof anchorItemId !== 'string' || anchorItemId.length === 0) return null;
        return {
            key: { itemId: anchorItemId, messageId: result.anchor.messageId ?? null },
            itemOffsetPx: result.anchor.itemOffsetPx,
            capturedDataLength: deps.listDataRef.current.length,
            capturedFirstItemId: typeof deps.listDataRef.current[0]?.id === 'string'
                ? deps.listDataRef.current[0].id
                : null,
        };
    }, [
        deps.listContentHeightRef,
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listRef,
    ]);

    const beginNativeTransaction = React.useCallback((): boolean => {
        if (Platform.OS === 'web') return false;
        if (deps.wantsPinnedRef.current) return false;

        const buildInput = (): NativePrependBeginInput => ({
            activeOwner: deps.viewportCommandController.activeOwner(),
            capturedAnchor: captureNativeAnchor(),
            contentHeight: deps.listContentHeightRef.current,
            layoutHeight: deps.listLayoutHeightRef.current,
            preservePrependViewport: true,
            sessionId: deps.currentSessionId,
        });

        const firstEffects = nativeOwner.begin(buildInput());
        applyNativeEffectsRef.current(firstEffects);
        if (firstEffects.some((effect) => effect.type === 'preempt-entry-restore-for-prepend')) {
            const secondEffects = nativeOwner.begin(buildInput());
            applyNativeEffectsRef.current(secondEffects);
        }
        return nativeOwner.hasOpenTransaction(deps.currentSessionId);
    }, [
        captureNativeAnchor,
        deps.currentSessionId,
        deps.listContentHeightRef,
        deps.listLayoutHeightRef,
        deps.viewportCommandController,
        deps.wantsPinnedRef,
        nativeOwner,
    ]);

    const armNativeCommit = React.useCallback((layoutTimeoutMs: number) => {
        applyNativeEffectsRef.current(nativeOwner.armCommit({
            layoutTimeoutMs,
            sessionId: deps.currentSessionId,
        }));
    }, [
        deps.currentSessionId,
        nativeOwner,
    ]);

    const invalidateNativeTransaction = React.useCallback((
        reason: 'identity' | 'session-entry' | 'load-empty' | 'jump' | 'dispose' | 'ownership-rejected' = 'session-entry',
    ) => {
        applyNativeEffectsRef.current(nativeOwner.invalidate({
            activeOwner: deps.viewportCommandController.activeOwner(),
            reason,
            sessionId: deps.currentSessionId,
        }));
    }, [
        deps.currentSessionId,
        deps.viewportCommandController,
        nativeOwner,
    ]);

    const observeNative = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        applyNativeEffectsRef.current(nativeOwner.observe(
            resolveNativeObservationInput(deps.currentSessionId),
        ));
    }, [
        deps.currentSessionId,
        nativeOwner,
        resolveNativeObservationInput,
    ]);

    React.useLayoutEffect(() => {
        observeNative();
    }, [
        deps.currentSessionId,
        deps.listContentHeight,
        deps.listDataLength,
        observeNative,
    ]);

    return React.useMemo(() => ({
        applyNativeEffects,
        armNativeCommit,
        beginNativeTransaction,
        getNativeTransactionRevision: () => nativeTransactionRevisionRef.current,
        hasOpenNativeTransaction: (sessionId?: string) => nativeOwner.hasOpenTransaction(sessionId ?? deps.currentSessionId),
        invalidateNativeTransaction,
        nativeTelemetryState: (sessionId?: string) => nativeOwner.telemetryState(sessionId ?? deps.currentSessionId),
        observeNative,
        recordCorrectorCorrection: (diffPx: number) => {
            applyNativeEffectsRef.current(nativeOwner.recordCorrectorCorrection({
                diffPx,
                sessionId: deps.currentSessionId,
            }));
        },
        trustedNativeScroll: (input) => nativeOwner.trustedScroll(input),
    }), [
        applyNativeEffects,
        armNativeCommit,
        beginNativeTransaction,
        deps.currentSessionId,
        invalidateNativeTransaction,
        nativeOwner,
        observeNative,
    ]);
}

function executeCommandHostInput(
    commandHostRef: MutableRef<TranscriptViewportCommandHost | null>,
    input: Parameters<TranscriptViewportCommandHost['resolve']>[0],
) {
    const commandHost = commandHostRef.current;
    if (!commandHost) return false;
    return commandHost.execute(commandHost.resolve(input));
}
