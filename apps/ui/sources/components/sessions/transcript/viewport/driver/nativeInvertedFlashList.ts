import {
    fromNativeInvertedCanonicalOffset,
    resolveNativeInvertedBottomCommandOffset,
    resolveNativeInvertedBottomRawOffset,
    toNativeInvertedCanonicalOffset,
} from './nativeInvertedRawScroll';
import { resolveNativeInvertedColdScrollIndex } from '@/components/sessions/transcript/segments/resolveWebHotColdScrollDecision';
import {
    type TranscriptViewportTelemetryScrollWriter,
    resolveTranscriptViewportTelemetryPlatform,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptViewportCommand } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptViewportDriverDeps } from './types';

/** Resolve the telemetry writer name for an index-targeted scroll write. */
export function resolveIndexScrollWriter(params: Readonly<{
    platform: ReturnType<typeof resolveTranscriptViewportTelemetryPlatform>;
}>): TranscriptViewportTelemetryScrollWriter {
    if (params.platform === 'web') return 'web-scroll-to-index';
    return 'native-scroll-to-index';
}

/** Native viewport command driver. Native's canonical product target is inverted FlashList. */
export function performNativeInvertedFlashListViewportCommand(
    command: TranscriptViewportCommand,
    deps: TranscriptViewportDriverDeps,
): boolean {
    if (command.kind === 'pin-bottom') {
        return performNativePinBottomCommand(command, deps);
    }

    if (
        command.kind === 'restore-distance' ||
        command.kind === 'apply-history-correction' ||
        command.kind === 'recover-jump-to-seq'
    ) {
        return performNativeOffsetCommand(command, deps);
    }

    if (command.kind === 'restore-anchor' || command.kind === 'jump-to-seq') {
        return performNativeIndexCommand(command, deps);
    }

    return false;
}

function performNativePinBottomCommand(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'pin-bottom' }>>,
    deps: TranscriptViewportDriverDeps,
): boolean {
    const node = deps.listRef.current;
    if (!node) return false;
    const contentHeight = typeof command.contentHeight === 'number' && Number.isFinite(command.contentHeight)
        ? Math.max(0, command.contentHeight)
        : deps.listContentHeightRef.current;
    const layoutHeight = typeof command.layoutHeight === 'number' && Number.isFinite(command.layoutHeight)
        ? Math.max(0, command.layoutHeight)
        : deps.listLayoutHeightRef.current;
    const rawBottomOffset = command.mode === 'jump-to-bottom'
        ? resolveNativeInvertedBottomCommandOffset()
        : resolveNativeInvertedBottomRawOffset();
    // Device-proven: an inverted FlashList ignores scrollToOffset({offset: 0}); the newest row is
    // index 0 of the reversed data, so the visual bottom must be commanded via scrollToIndex(0).
    if (typeof node.scrollToIndex === 'function') {
        // Offset the inverted bottom command UP by the composer inset + hot-tail height so the newest
        // row lands fully ABOVE the input (viewOffset = -inset drives distance-from-bottom to 0).
        const bottomInset = deps.composerInsetHeightRef.current + deps.nativeHotTailHeightRef.current;
        node.scrollToIndex(
            bottomInset > 0
                ? { index: 0, animated: command.animated ?? false, viewOffset: -bottomInset }
                : { index: 0, animated: command.animated ?? false },
        );
    } else {
        if (typeof node.scrollToOffset !== 'function') return false;
        node.scrollToOffset({ offset: rawBottomOffset, animated: command.animated ?? false });
    }
    deps.recordViewportTelemetryEvent({
        type: 'scroll-write',
        writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
        reason: command.reason,
        mode: command.mode,
        targetOffsetY: rawBottomOffset,
        previousOffsetY: deps.lastNativePinOffsetRef.current ?? undefined,
        layoutHeight,
        contentHeight,
        distanceFromBottom: 0,
        nativeMountSettleStable: deps.nativeMountSettleStable,
        ...deps.resolveInvertedBottomPinCarveTelemetryFields(),
    });
    return true;
}

function performNativeOffsetCommand(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-distance' | 'apply-history-correction' | 'recover-jump-to-seq' }>>,
    deps: TranscriptViewportDriverDeps,
): boolean {
    const node = deps.listRef.current;
    if (!node || typeof node.scrollToOffset !== 'function') return false;
    const layoutHeight = deps.listLayoutHeightRef.current;
    const contentHeight = command.kind === 'restore-distance' && typeof command.contentHeight === 'number' && Number.isFinite(command.contentHeight)
        ? Math.max(0, Math.trunc(command.contentHeight))
        : deps.listContentHeightRef.current;
    const maxOffset = Math.max(0, Math.trunc(contentHeight - layoutHeight));
    const targetOffsetY = command.kind === 'restore-distance'
        ? Math.max(0, maxOffset - command.distanceFromLiveTailPx)
        : command.kind === 'apply-history-correction'
            ? Math.max(0, Math.trunc(command.targetDistanceFromHistoryStartPx))
            : resolveNativeJumpFailureRecoveryTargetOffsetY({ command, contentHeight, deps, layoutHeight });
    // N3.2: command/telemetry offsets stay CANONICAL (standard-space); the raw write target maps
    // through the orientation seam at this single boundary.
    const rawTargetOffsetY = command.kind === 'recover-jump-to-seq'
        ? resolveNativeJumpFailureRecoveryRawOffsetY(command)
        : Math.max(0, fromNativeInvertedCanonicalOffset({
            canonicalOffsetY: targetOffsetY,
            contentHeight,
            layoutHeight,
        }));
    node.scrollToOffset({ offset: rawTargetOffsetY, animated: command.animated ?? false });
    deps.recordViewportTelemetryEvent({
        type: 'scroll-write',
        writer: 'native-scroll-to-offset',
        reason: command.reason,
        mode: command.mode,
        targetOffsetY,
        previousOffsetY: deps.lastNativePinOffsetRef.current ?? undefined,
        layoutHeight,
        contentHeight,
        distanceFromBottom: command.kind === 'restore-distance' ? command.distanceFromLiveTailPx : undefined,
        nativeMountSettleStable: deps.nativeMountSettleStable,
    });
    return true;
}

function resolveNativeJumpFailureRecoveryRawOffsetY(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'recover-jump-to-seq' }>>,
): number {
    return Math.max(0, Math.trunc(command.averageItemLengthPx * command.failedRenderedIndex));
}

function resolveNativeJumpFailureRecoveryTargetOffsetY(params: Readonly<{
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'recover-jump-to-seq' }>>;
    contentHeight: number;
    deps: TranscriptViewportDriverDeps;
    layoutHeight: number;
}>): number {
    const rawEstimatedOffsetY = resolveNativeJumpFailureRecoveryRawOffsetY(params.command);
    return Math.max(0, toNativeInvertedCanonicalOffset({
        rawOffsetY: rawEstimatedOffsetY,
        contentHeight: params.contentHeight,
        layoutHeight: params.layoutHeight,
    }));
}

function performNativeIndexCommand(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-anchor' | 'jump-to-seq' }>>,
    deps: TranscriptViewportDriverDeps,
): boolean {
    let index = command.kind === 'jump-to-seq'
        ? (command.routeMessageId
            ? deps.resolveJumpToSeqIndex(
                command.seq,
                command.routeMessageId,
                command.transcriptBlockIndex,
                command.role,
            )
            : deps.resolveJumpToSeqIndex(command.seq))
        : deps.resolveRestoreAnchorIndex(command.target.anchor);
    if (typeof index !== 'number' || !Number.isFinite(index)) return false;
    if (deps.shouldUseNativeHotColdSplit) {
        // Map the FULL rendered display index to a COLD rendered index (FlashList `data` is the cold
        // slice); a hot-tail target resolves to the newest cold row, bringing the live tail into view.
        const renderedColdIndex = resolveNativeInvertedColdScrollIndex({
            renderedFullIndex: index,
            fullCount: deps.itemsRef.current.length,
            coldCount: deps.listDataRef.current.length,
        });
        if (renderedColdIndex != null) {
            index = renderedColdIndex;
        }
    }
    const node = deps.listRef.current;
    if (!node || typeof node.scrollToIndex !== 'function') return false;
    if (command.kind === 'restore-anchor') {
        const viewOffset = -command.target.itemOffsetPx;
        deps.lastNativeRestoreIndexCommandRef.current = {
            index,
            issuedAtMs: Date.now(),
            reason: command.reason,
            sessionId: command.sessionId,
            viewOffset,
        };
        const restoreParams = {
            index,
            animated: command.animated ?? false,
            viewOffset,
        };
        node.scrollToIndex(restoreParams);
    } else {
        const jumpAlignment = command.align;
        deps.lastNativeRestoreIndexCommandRef.current = {
            index,
            issuedAtMs: Date.now(),
            reason: command.reason,
            sessionId: command.sessionId,
            ...(jumpAlignment?.kind === 'top-with-item-offset'
                ? { viewOffset: -jumpAlignment.itemOffsetPx }
                : {}),
        };
        node.scrollToIndex(jumpAlignment?.kind === 'top-with-item-offset'
            ? { index, animated: command.animated ?? true, viewOffset: -jumpAlignment.itemOffsetPx }
            : { index, animated: command.animated ?? true, viewPosition: 0.5 });
    }
    deps.recordViewportTelemetryEvent({
        type: 'scroll-write',
        writer: resolveIndexScrollWriter({
            platform: deps.telemetryPlatform,
        }),
        reason: command.reason,
        mode: command.mode,
        targetOffsetY: index,
        layoutHeight: deps.listLayoutHeightRef.current,
        contentHeight: deps.listContentHeightRef.current,
        nativeMountSettleStable: deps.nativeMountSettleStable,
    });
    return true;
}
