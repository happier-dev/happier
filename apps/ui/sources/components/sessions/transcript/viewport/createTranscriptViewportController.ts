import type {
    TranscriptViewportAnchorIdentity,
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportJumpAlignment,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export type TranscriptViewportController = Readonly<{
    getMode(): TranscriptViewportMode;
    resolve(input: TranscriptViewportControllerInput): TranscriptViewportCommand;
}>;

export function createTranscriptViewportController(): TranscriptViewportController {
    let sessionId: string | null = null;
    let mode: TranscriptViewportMode = 'hydrating';

    return {
        getMode() {
            return mode;
        },
        resolve(input) {
            if (sessionId !== input.sessionId) {
                sessionId = input.sessionId;
                mode = 'hydrating';
                if (input.type === 'user-scroll' || input.type === 'auto-follow') {
                    return { kind: 'none', sessionId: input.sessionId, reason: 'session-change', mode };
                }
            }

            switch (input.type) {
                case 'first-paint':
                    return resolveFirstPaint(input);
                case 'user-scroll':
                    return resolveUserScroll(input);
                case 'auto-follow':
                    return resolveAutoFollow(input);
                case 'jump-to-bottom':
                    mode = 'jump-to-bottom';
                    return {
                        kind: 'pin-bottom',
                        sessionId: input.sessionId,
                        reason: 'jump-to-bottom',
                        mode,
                        force: true,
                        animated: true,
                    };
                case 'pin-bottom':
                    mode = input.mode;
                    return {
                        kind: 'pin-bottom',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        ...(typeof input.force === 'boolean' ? { force: input.force } : {}),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'restore-distance':
                    mode = 'restore-distance';
                    return {
                        kind: 'restore-distance',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        distanceFromLiveTailPx: normalizeNonNegative(input.distanceFromLiveTailPx),
                        ...(typeof input.contentHeight === 'number' && Number.isFinite(input.contentHeight)
                            ? { contentHeight: normalizeNonNegative(input.contentHeight) }
                            : {}),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'apply-history-correction':
                    mode = 'restore-anchor';
                    return {
                        kind: 'apply-history-correction',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        targetDistanceFromHistoryStartPx: normalizeNonNegative(input.targetDistanceFromHistoryStartPx),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'restore-anchor':
                    mode = 'restore-anchor';
                    return {
                        kind: 'restore-anchor',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        target: normalizeRestoreAnchorTarget(input.anchor, input.itemOffsetPx),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'restore-visible-anchor':
                    mode = 'restore-anchor';
                    return {
                        kind: 'restore-visible-anchor',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        target: normalizeRestoreAnchorTarget(input.anchor, input.itemOffsetPx, input.itemIndex),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'jump-to-seq':
                    mode = 'jump-to-seq';
                    {
                        const routeMessageId = normalizeRouteMessageId(input.routeMessageId);
                        const transcriptBlockIndex = normalizeOptionalNonNegative(input.transcriptBlockIndex);
                        const role = normalizeRole(input.role);
                        return {
                            kind: 'jump-to-seq',
                            sessionId: input.sessionId,
                            reason: 'jump-to-seq',
                            mode,
                            seq: input.seq,
                            ...(routeMessageId ? { routeMessageId } : {}),
                            ...(transcriptBlockIndex !== null ? { transcriptBlockIndex } : {}),
                            ...(role ? { role } : {}),
                            ...(normalizeJumpAlignment(input.align) ?? {}),
                        };
                    }
                case 'recover-jump-to-seq':
                    mode = 'jump-to-seq';
                    return {
                        kind: 'recover-jump-to-seq',
                        sessionId: input.sessionId,
                        reason: 'jump-to-seq',
                        mode,
                        failedRenderedIndex: normalizeNonNegative(input.failedRenderedIndex),
                        averageItemLengthPx: normalizeNonNegative(input.averageItemLengthPx),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'preserve-live-tail-distance':
                    return resolvePreserveLiveTailDistance(input);
                case 'restore-web-prepend-anchor':
                    mode = 'restore-anchor';
                    return {
                        kind: 'restore-web-prepend-anchor',
                        sessionId: input.sessionId,
                        reason: 'prepend-restore',
                        mode,
                        anchor: input.anchor,
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
            }
        },
    };

    function resolveFirstPaint(
        input: Extract<TranscriptViewportControllerInput, { type: 'first-paint' }>,
    ): TranscriptViewportCommand {
        if (typeof input.jumpToSeq === 'number' && Number.isFinite(input.jumpToSeq)) {
            mode = 'jump-to-seq';
            return {
                kind: 'jump-to-seq',
                sessionId: input.sessionId,
                reason: 'jump-to-seq',
                mode,
                seq: Math.trunc(input.jumpToSeq),
            };
        }

        const entrySnapshot = input.entrySnapshot ?? null;
        if (entrySnapshot?.shouldFollowBottom === false || input.shouldFollowBottom === false) {
            const anchor = entrySnapshot?.anchor;
            if (anchor != null) {
                const anchorItemOffsetPx = entrySnapshot?.anchorItemOffsetPx;
                mode = 'restore-anchor';
                return {
                    kind: 'restore-anchor',
                    sessionId: input.sessionId,
                    reason: 'entry-restore',
                    mode,
                    target: normalizeRestoreAnchorTarget(anchor, anchorItemOffsetPx),
                };
            }

            const entryDistanceFromLiveTailPx = entrySnapshot?.distanceFromLiveTailPx;
            if (typeof entryDistanceFromLiveTailPx !== 'number' || !Number.isFinite(entryDistanceFromLiveTailPx)) {
                mode = 'restore-distance';
                return {
                    kind: 'none',
                    sessionId: input.sessionId,
                    reason: 'entry-restore',
                    mode,
                };
            }

            mode = 'restore-distance';
            return {
                kind: 'restore-distance',
                sessionId: input.sessionId,
                reason: 'entry-restore',
                mode,
                distanceFromLiveTailPx: normalizeNonNegative(entryDistanceFromLiveTailPx),
            };
        }

        mode = 'follow-bottom';
        return {
            kind: 'pin-bottom',
            sessionId: input.sessionId,
            reason: 'initial-open',
            mode,
        };
    }

    function resolveUserScroll(
        input: Extract<TranscriptViewportControllerInput, { type: 'user-scroll' }>,
    ): TranscriptViewportCommand {
        if (normalizeNonNegative(input.distanceFromBottom) > normalizeNonNegative(input.pinThresholdPx)) {
            mode = 'user-unpinned';
            return {
                kind: 'none',
                sessionId: input.sessionId,
                reason: 'user-unpinned',
                mode,
            };
        }

        mode = 'follow-bottom';
        return {
            kind: 'none',
            sessionId: input.sessionId,
            reason: 'already-pinned',
            mode,
        };
    }

    function resolveAutoFollow(
        input: Extract<TranscriptViewportControllerInput, { type: 'auto-follow' }>,
    ): TranscriptViewportCommand {
        const distanceFromBottom = normalizeNonNegative(input.distanceFromBottom);
        const pinThresholdPx = normalizeNonNegative(input.pinThresholdPx);
        if (!input.wantsPinned || mode === 'user-unpinned') {
            mode = 'user-unpinned';
            return { kind: 'none', sessionId: input.sessionId, reason: 'user-unpinned', mode };
        }
        if (distanceFromBottom <= pinThresholdPx) {
            mode = 'follow-bottom';
            return { kind: 'none', sessionId: input.sessionId, reason: 'already-pinned', mode };
        }
        if (input.recentUserIntent) {
            mode = 'user-unpinned';
            return { kind: 'none', sessionId: input.sessionId, reason: 'recent-user-intent', mode };
        }

        mode = 'follow-bottom';
        if (input.skipNativeJsPin === true) {
            return {
                kind: 'skip-native-js-pin',
                sessionId: input.sessionId,
                reason: input.reason,
                skipReason: 'mvcp-only',
                mode,
            };
        }
        return {
            kind: 'pin-bottom',
            sessionId: input.sessionId,
            reason: input.reason,
            mode,
            ...(typeof input.observedContentHeightPx === 'number' && Number.isFinite(input.observedContentHeightPx)
                ? { contentHeight: normalizeFiniteNonNegative(input.observedContentHeightPx) }
                : {}),
            ...(typeof input.observedLayoutHeightPx === 'number' && Number.isFinite(input.observedLayoutHeightPx)
                ? { layoutHeight: normalizeFiniteNonNegative(input.observedLayoutHeightPx) }
                : {}),
        };
    }

    function resolvePreserveLiveTailDistance(
        input: Extract<TranscriptViewportControllerInput, { type: 'preserve-live-tail-distance' }>,
    ): TranscriptViewportCommand {
        const previousDistanceFromLiveTailPx = normalizeNonNegative(input.previousDistanceFromLiveTailPx);
        const pinThresholdPx = normalizeNonNegative(input.pinThresholdPx);
        if (!input.wantsPinned || mode === 'user-unpinned') {
            mode = 'user-unpinned';
            return { kind: 'none', sessionId: input.sessionId, reason: 'user-unpinned', mode };
        }
        if (input.recentUserIntent) {
            mode = 'user-unpinned';
            return { kind: 'none', sessionId: input.sessionId, reason: 'recent-user-intent', mode };
        }
        if (previousDistanceFromLiveTailPx > pinThresholdPx) {
            return { kind: 'none', sessionId: input.sessionId, reason: 'user-unpinned', mode };
        }

        mode = 'follow-bottom';
        return {
            kind: 'preserve-live-tail-distance',
            sessionId: input.sessionId,
            reason: input.reason,
            mode,
            previousDistanceFromLiveTailPx,
            ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
            ...(input.schedulerAuthorityReason ? { schedulerAuthorityReason: input.schedulerAuthorityReason } : {}),
            ...(input.schedulerAuthorityWriter ? { schedulerAuthorityWriter: input.schedulerAuthorityWriter } : {}),
        };
    }
}

function normalizeNonNegative(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

function normalizeFiniteNonNegative(value: number): number {
    return Math.max(0, value);
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
            ? Math.max(0, Math.trunc(align.itemOffsetPx))
            : 0;
        return { align: { kind: 'top-with-item-offset', itemOffsetPx } };
    }
    return null;
}
