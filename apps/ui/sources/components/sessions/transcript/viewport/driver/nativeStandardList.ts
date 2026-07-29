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

/** Native standard-space command driver for non-inverted renderers such as Legend List. */
export function performNativeStandardListViewportCommand(
    command: TranscriptViewportCommand,
    deps: TranscriptViewportDriverDeps,
): boolean {
    if (command.kind === 'pin-bottom') {
        return performNativeStandardPinBottomCommand(command, deps);
    }

    if (
        command.kind === 'restore-distance' ||
        command.kind === 'apply-history-correction' ||
        command.kind === 'recover-jump-to-seq'
    ) {
        return performNativeStandardOffsetCommand(command, deps);
    }

    if (command.kind === 'restore-anchor' || command.kind === 'jump-to-seq') {
        return performNativeStandardIndexCommand(command, deps);
    }

    return false;
}

function maxStandardOffset(deps: TranscriptViewportDriverDeps, contentHeight?: number): number {
    const resolvedContentHeight = typeof contentHeight === 'number' && Number.isFinite(contentHeight)
        ? Math.max(0, Math.trunc(contentHeight))
        : deps.listContentHeightRef.current;
    return Math.max(0, Math.trunc(resolvedContentHeight - deps.listLayoutHeightRef.current));
}

function performNativeStandardPinBottomCommand(
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
    const targetOffsetY = Math.max(0, Math.trunc(contentHeight - layoutHeight));

    // Bottom placement is a semantic intent, not a one-shot offset. Legend's renderer-owned
    // settle transaction must receive it so late item measurements can repair the landing.
    if (typeof node.scrollToEnd === 'function') {
        node.scrollToEnd({ animated: command.animated ?? false });
    } else if (typeof node.scrollToOffset === 'function') {
        node.scrollToOffset({ offset: targetOffsetY, animated: command.animated ?? false });
    } else {
        return false;
    }

    deps.recordViewportTelemetryEvent({
        type: 'scroll-write',
        writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
        reason: command.reason,
        mode: command.mode,
        targetOffsetY,
        layoutHeight,
        contentHeight,
        distanceFromBottom: 0,
        nativeMountSettleStable: deps.nativeMountSettleStable,
    });
    return true;
}

function performNativeStandardOffsetCommand(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-distance' | 'apply-history-correction' | 'recover-jump-to-seq' }>>,
    deps: TranscriptViewportDriverDeps,
): boolean {
    const node = deps.listRef.current;
    if (!node || typeof node.scrollToOffset !== 'function') return false;
    const contentHeight = command.kind === 'restore-distance' && typeof command.contentHeight === 'number' && Number.isFinite(command.contentHeight)
        ? Math.max(0, Math.trunc(command.contentHeight))
        : deps.listContentHeightRef.current;
    const layoutHeight = deps.listLayoutHeightRef.current;
    const targetOffsetY = command.kind === 'restore-distance'
        ? Math.max(0, maxStandardOffset(deps, contentHeight) - command.distanceFromLiveTailPx)
        : command.kind === 'apply-history-correction'
            ? Math.max(0, Math.trunc(command.targetDistanceFromHistoryStartPx))
            : Math.max(0, Math.trunc(command.averageItemLengthPx * command.failedRenderedIndex));

    node.scrollToOffset({ offset: targetOffsetY, animated: command.animated ?? false });
    deps.recordViewportTelemetryEvent({
        type: 'scroll-write',
        writer: 'native-scroll-to-offset',
        reason: command.reason,
        mode: command.mode,
        targetOffsetY,
        layoutHeight,
        contentHeight,
        distanceFromBottom: command.kind === 'restore-distance' ? command.distanceFromLiveTailPx : undefined,
        nativeMountSettleStable: deps.nativeMountSettleStable,
    });
    return true;
}

function performNativeStandardIndexCommand(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-anchor' | 'jump-to-seq' }>>,
    deps: TranscriptViewportDriverDeps,
): boolean {
    const rendererTarget = deps.resolveRendererDataTarget(command);
    const index = rendererTarget?.kind === 'data'
        ? rendererTarget.index
        : rendererTarget?.fallbackIndex;
    if (typeof index !== 'number' || !Number.isFinite(index)) return false;
    const node = deps.listRef.current;
    if (!node || typeof node.scrollToIndex !== 'function') return false;

    if (command.kind === 'restore-anchor') {
        const viewOffset = command.target.itemOffsetPx;
        deps.lastNativeRestoreIndexCommandRef.current = {
            index,
            issuedAtMs: Date.now(),
            reason: command.reason,
            sessionId: command.sessionId,
            viewOffset,
        };
        node.scrollToIndex({
            index,
            animated: command.animated ?? false,
            viewOffset,
            ...(command.reason === 'entry-restore'
                ? {
                    context: {
                        anchor: {
                            itemId: command.target.anchor.itemId,
                            itemOffsetPx: command.target.itemOffsetPx,
                            kind: command.target.anchor.kind,
                            messageId: command.target.anchor.messageId ?? null,
                            reason: command.reason,
                        },
                        kind: 'entry-placement' as const,
                    },
                }
                : {}),
        });
    } else {
        const jumpAlignment = command.align;
        deps.lastNativeRestoreIndexCommandRef.current = {
            index,
            issuedAtMs: Date.now(),
            reason: command.reason,
            sessionId: command.sessionId,
            ...(jumpAlignment?.kind === 'top-with-item-offset'
                ? { viewOffset: jumpAlignment.itemOffsetPx }
                : {}),
        };
        node.scrollToIndex(jumpAlignment?.kind === 'top-with-item-offset'
            ? { index, animated: command.animated ?? true, viewOffset: jumpAlignment.itemOffsetPx }
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
