import type {
    TranscriptViewportAnchorIdentity,
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportJumpAlignment,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export type TranscriptViewportController = Readonly<{
    resolve(input: TranscriptViewportControllerInput): TranscriptViewportCommand;
}>;

export function createTranscriptViewportController(): TranscriptViewportController {
    return {
        resolve(input) {
            switch (input.type) {
                case 'jump-to-bottom':
                    return {
                        kind: 'pin-bottom',
                        sessionId: input.sessionId,
                        reason: 'jump-to-bottom',
                        mode: 'jump-to-bottom',
                        force: true,
                        animated: true,
                    };
                case 'pin-bottom':
                    return {
                        kind: 'pin-bottom',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode: input.mode,
                        ...(typeof input.force === 'boolean' ? { force: input.force } : {}),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'restore-distance':
                    return {
                        kind: 'restore-distance',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode: 'restore-distance',
                        distanceFromLiveTailPx: normalizeNonNegative(input.distanceFromLiveTailPx),
                        ...(typeof input.contentHeight === 'number' && Number.isFinite(input.contentHeight)
                            ? { contentHeight: normalizeNonNegative(input.contentHeight) }
                            : {}),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'apply-history-correction':
                    return {
                        kind: 'apply-history-correction',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode: 'restore-anchor',
                        targetDistanceFromHistoryStartPx: normalizeNonNegative(input.targetDistanceFromHistoryStartPx),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'restore-anchor':
                    return {
                        kind: 'restore-anchor',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode: 'restore-anchor',
                        target: normalizeRestoreAnchorTarget(input.anchor, input.itemOffsetPx),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'restore-visible-anchor':
                    return {
                        kind: 'restore-visible-anchor',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode: 'restore-anchor',
                        target: normalizeRestoreAnchorTarget(input.anchor, input.itemOffsetPx, input.itemIndex),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'jump-to-seq':
                    {
                        const routeMessageId = normalizeRouteMessageId(input.routeMessageId);
                        const transcriptBlockIndex = normalizeOptionalNonNegative(input.transcriptBlockIndex);
                        const role = normalizeRole(input.role);
                        return {
                            kind: 'jump-to-seq',
                            sessionId: input.sessionId,
                            reason: 'jump-to-seq',
                            mode: 'jump-to-seq',
                            seq: input.seq,
                            ...(routeMessageId ? { routeMessageId } : {}),
                            ...(transcriptBlockIndex !== null ? { transcriptBlockIndex } : {}),
                            ...(role ? { role } : {}),
                            ...(normalizeJumpAlignment(input.align) ?? {}),
                        };
                    }
                case 'recover-jump-to-seq':
                    return {
                        kind: 'recover-jump-to-seq',
                        sessionId: input.sessionId,
                        reason: 'jump-to-seq',
                        mode: 'jump-to-seq',
                        failedRenderedIndex: normalizeNonNegative(input.failedRenderedIndex),
                        averageItemLengthPx: normalizeNonNegative(input.averageItemLengthPx),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
            }
        },
    };

}

function normalizeNonNegative(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

function normalizeRouteMessageId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalNonNegative(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function normalizeRole(value: unknown) {
    if (
        value === 'user' ||
        value === 'assistant' ||
        value === 'tool' ||
        value === 'system' ||
        value === 'unknown'
    ) {
        return value;
    }
    return null;
}

function normalizeRestoreAnchorTarget(
    anchor: TranscriptViewportAnchorIdentity,
    itemOffsetPx: number | null | undefined,
    itemIndex?: number | null,
) {
    const normalizedItemIndex =
        typeof itemIndex === 'number' && Number.isFinite(itemIndex)
            ? Math.max(0, Math.trunc(itemIndex))
            : null;
    return {
        anchor: {
            kind: anchor.kind,
            itemId: anchor.itemId.trim(),
            messageId: typeof anchor.messageId === 'string' && anchor.messageId.trim().length > 0
                ? anchor.messageId.trim()
                : null,
        },
        ...(normalizedItemIndex == null ? {} : { itemIndex: normalizedItemIndex }),
        itemOffsetPx: typeof itemOffsetPx === 'number' && Number.isFinite(itemOffsetPx)
            ? Math.trunc(itemOffsetPx)
            : 0,
    };
}

function normalizeJumpAlignment(
    align: TranscriptViewportJumpAlignment | null | undefined,
): Readonly<{ align: TranscriptViewportJumpAlignment }> | null {
    if (align?.kind === 'center') {
        return { align: { kind: 'center' } };
    }
    if (align?.kind === 'top-with-item-offset') {
        const itemOffsetPx = typeof align.itemOffsetPx === 'number' && Number.isFinite(align.itemOffsetPx)
            // A Find mark deep inside a tall item needs the item top above the viewport.
            ? Math.trunc(align.itemOffsetPx)
            : 0;
        return { align: { kind: 'top-with-item-offset', itemOffsetPx } };
    }
    if (align?.kind === 'reveal') {
        const clearancePx = Number.isFinite(align.clearancePx) ? Math.max(0, Math.trunc(align.clearancePx)) : 0;
        return { align: { kind: 'reveal', clearancePx, ...(align.focusTestId ? { focusTestId: align.focusTestId } : {}) } };
    }
    return null;
}
