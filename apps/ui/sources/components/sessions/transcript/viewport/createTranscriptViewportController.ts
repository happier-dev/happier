import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportScrollReason,
    TranscriptViewportMode,
    TranscriptViewportOwner,
    TranscriptViewportPlatform,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import {
    createTranscriptViewportOwnership,
    type TranscriptViewportCloseTransactionResult,
    type TranscriptViewportOpenTransactionResult,
    type TranscriptViewportOwnership,
    type TranscriptViewportTransactionOutcome,
    type TranscriptViewportTransactionOwner,
} from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';

type WritableTranscriptViewportOwner = Exclude<TranscriptViewportOwner, 'idle'>;

export type TranscriptViewportWriteAdmission =
    | Readonly<{ accepted: true; owner: WritableTranscriptViewportOwner }>
    | Readonly<{ accepted: false; reason: 'inactive' | 'stale-session' | 'no-op' }>
    | Readonly<{
        accepted: false;
        reason: 'ownership';
        rejectedOwner: WritableTranscriptViewportOwner;
        activeOwner: TranscriptViewportOwner;
    }>;

export type TranscriptViewportWriteAdmissionRequest = Readonly<{
    command: TranscriptViewportCommand;
    hasWebPrependRestoreWindow?: boolean;
    platform: TranscriptViewportPlatform;
}>;

export type TranscriptViewportController = Readonly<{
    activeOwner(): TranscriptViewportOwner;
    canWrite(owner: TranscriptViewportOwner): boolean;
    closeTransaction(
        owner: TranscriptViewportTransactionOwner,
        outcome: TranscriptViewportTransactionOutcome,
    ): TranscriptViewportCloseTransactionResult;
    getMode(): TranscriptViewportMode;
    isTransactionOpen(): boolean;
    openTransaction(owner: TranscriptViewportTransactionOwner): TranscriptViewportOpenTransactionResult;
    resetForSession(sessionId: string, options?: Readonly<{ openEntryTransaction?: boolean }>): void;
    resolve(input: TranscriptViewportControllerInput): TranscriptViewportCommand;
    resolveWriteAdmission(request: TranscriptViewportWriteAdmissionRequest): TranscriptViewportWriteAdmission;
    setActive(active: boolean): void;
}>;

export function createTranscriptViewportController(): TranscriptViewportController {
    let sessionId: string | null = null;
    let mode: TranscriptViewportMode = 'hydrating';
    let active = true;
    let ownership: TranscriptViewportOwnership = createTranscriptViewportOwnership();

    const resetForSession = (
        nextSessionId: string,
        options: Readonly<{ openEntryTransaction?: boolean }> = {},
    ): void => {
        sessionId = nextSessionId;
        mode = 'hydrating';
        ownership = createTranscriptViewportOwnership();
        if (options.openEntryTransaction === true) {
            ownership.openTransaction('entry');
        }
    };

    return {
        activeOwner() {
            return ownership.activeOwner();
        },
        canWrite(owner) {
            return ownership.canWrite(owner);
        },
        closeTransaction(owner, outcome) {
            return ownership.closeTransaction(owner, outcome);
        },
        getMode() {
            return mode;
        },
        isTransactionOpen() {
            return ownership.activeOwner() !== 'follow';
        },
        openTransaction(owner) {
            return ownership.openTransaction(owner);
        },
        resetForSession,
        resolve(input) {
            if (sessionId !== input.sessionId) {
                resetForSession(input.sessionId);
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
                case 'scroll-offset':
                    mode = input.mode;
                    return {
                        kind: 'scroll-offset',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        offsetY: normalizeNonNegative(input.offsetY),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'restore-anchor':
                    mode = 'restore-anchor';
                    return {
                        kind: 'restore-index',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        index: Math.max(0, Math.trunc(input.index)),
                        ...(typeof input.viewOffset === 'number' && Number.isFinite(input.viewOffset)
                            ? { viewOffset: Math.trunc(input.viewOffset) }
                            : {}),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'jump-to-seq':
                    mode = 'jump-to-seq';
                    return {
                        kind: 'jump-to-seq',
                        sessionId: input.sessionId,
                        reason: 'jump-to-seq',
                        mode,
                        seq: Math.trunc(input.seq),
                        ...(typeof input.index === 'number' && Number.isFinite(input.index)
                            ? { index: Math.max(0, Math.trunc(input.index)) }
                            : {}),
                    };
            }
        },
        resolveWriteAdmission(request) {
            if (request.command.kind === 'none') {
                return { accepted: false, reason: 'no-op' };
            }
            if (!active) return { accepted: false, reason: 'inactive' };
            if (sessionId === null) {
                resetForSession(request.command.sessionId);
            }
            if (request.command.sessionId !== sessionId) {
                return { accepted: false, reason: 'stale-session' };
            }

            const commandOwner = resolveTranscriptViewportWriteOwner(
                request.command.reason,
                ownership.activeOwner() === 'entry',
            );
            if (commandOwner === 'explicit') {
                ownership.preempt('explicit');
                ownership.closeTransaction('explicit', 'confirmed');
                return { accepted: true, owner: commandOwner };
            }

            if (
                request.platform === 'web' &&
                ownership.activeOwner() === 'prepend' &&
                request.hasWebPrependRestoreWindow !== true
            ) {
                ownership.closeTransaction('prepend', 'abandoned-identity');
            }
            if (request.platform === 'web' && commandOwner === 'prepend' && ownership.activeOwner() === 'follow') {
                ownership.openTransaction('prepend');
            }
            if (!ownership.canWrite(commandOwner)) {
                return {
                    accepted: false,
                    reason: 'ownership',
                    rejectedOwner: commandOwner,
                    activeOwner: ownership.activeOwner(),
                };
            }
            return { accepted: true, owner: commandOwner };
        },
        setActive(nextActive) {
            active = nextActive;
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
            const anchorIndex = entrySnapshot?.anchorIndex;
            if (typeof anchorIndex === 'number' && Number.isFinite(anchorIndex)) {
                const anchorViewOffset = entrySnapshot?.anchorViewOffset;
                mode = 'restore-anchor';
                return {
                    kind: 'restore-index',
                    sessionId: input.sessionId,
                    reason: 'entry-restore',
                    mode,
                    index: Math.max(0, Math.trunc(anchorIndex)),
                    ...(typeof anchorViewOffset === 'number' && Number.isFinite(anchorViewOffset)
                        ? { viewOffset: Math.trunc(anchorViewOffset) }
                        : {}),
                };
            }

            mode = 'restore-distance';
            return {
                kind: 'restore-offset',
                sessionId: input.sessionId,
                reason: 'entry-restore',
                mode,
                offsetY: normalizeNonNegative(entrySnapshot?.offsetY),
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
            return createNativeJsPinSkipCommand(input.sessionId, input.reason, input.targetOffsetY);
        }
        if (typeof input.targetOffsetY === 'number' && Number.isFinite(input.targetOffsetY)) {
            return {
                kind: 'scroll-offset',
                sessionId: input.sessionId,
                reason: input.reason,
                mode,
                offsetY: Math.max(0, Math.trunc(input.targetOffsetY)),
            };
        }
        return {
            kind: 'pin-bottom',
            sessionId: input.sessionId,
            reason: input.reason,
            mode,
        };
    }
}

export function resolveTranscriptViewportWriteOwner(
    reason: TranscriptViewportScrollReason,
    entryPhaseOpen: boolean,
): WritableTranscriptViewportOwner {
    switch (reason) {
        case 'entry-restore':
            return 'entry';
        case 'prepend-restore':
            return 'prepend';
        case 'jump-to-bottom':
        case 'jump-to-seq':
            return 'explicit';
        case 'initial-open':
        case 'mount-settle':
            return entryPhaseOpen ? 'entry' : 'follow';
        default:
            return 'follow';
    }
}

function normalizeNonNegative(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

function createNativeJsPinSkipCommand(
    sessionId: string,
    reason: TranscriptViewportScrollReason,
    targetOffsetY?: number | null,
): TranscriptViewportCommand {
    return {
        kind: 'skip-native-js-pin',
        sessionId,
        reason,
        mode: 'follow-bottom',
        skipReason: 'mvcp-only',
        ...(typeof targetOffsetY === 'number' && Number.isFinite(targetOffsetY)
            ? { targetOffsetY: Math.max(0, Math.trunc(targetOffsetY)) }
            : {}),
    };
}
