import { describe, expect, it } from 'vitest';

import { createTranscriptViewportController } from '@/components/sessions/transcript/viewport/createTranscriptViewportController';
import type { TranscriptViewportControllerInput } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

describe('transcript viewport controller', () => {
    it('resolves initial follow bottom to a pin command', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
        });

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'initial-open',
            mode: 'follow-bottom',
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('keeps the first-paint list implementation contract aligned with the legacy runtime id', () => {
        const controller = createTranscriptViewportController();
        const input = {
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
        } satisfies Extract<TranscriptViewportControllerInput, { type: 'first-paint' }>;

        expect(controller.resolve(input)).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'initial-open',
            mode: 'follow-bottom',
        });
    });

    it('resolves unpinned entry distance to a semantic restore distance command', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                distanceFromLiveTailPx: 420,
            },
            jumpToSeq: null,
        });

        expect(command).toEqual({
            kind: 'restore-distance',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-distance',
            distanceFromLiveTailPx: 420,
        });
        expect(controller.getMode()).toBe('restore-distance');
    });

    it('does not synthesize a restore-distance command when an unpinned entry has no known distance', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                distanceFromLiveTailPx: null,
            },
            jumpToSeq: null,
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-distance',
        });
        expect(controller.getMode()).toBe('restore-distance');
    });

    it('resolves unpinned entry anchor to semantic restore anchor', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                distanceFromLiveTailPx: 80,
                anchor: { kind: 'message', itemId: 'row-12', messageId: 'message-12' },
                anchorItemOffsetPx: 24,
            },
            jumpToSeq: null,
        });

        expect(command).toEqual({
            kind: 'restore-anchor',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-anchor',
            target: {
                anchor: { kind: 'message', itemId: 'row-12', messageId: 'message-12' },
                itemOffsetPx: 24,
            },
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('prefers jumpToSeq over first paint state', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                distanceFromLiveTailPx: 420,
                anchor: { kind: 'message', itemId: 'row-12', messageId: 'message-12' },
                anchorItemOffsetPx: 24,
            },
            jumpToSeq: 34,
        });

        expect(command).toEqual({
            kind: 'jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            seq: 34,
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('keeps explicit jump-to-seq commands semantic even if a caller passes a stale index', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'jump-to-seq',
            sessionId: 'session-a',
            seq: 34,
            index: 12,
        } as Parameters<typeof controller.resolve>[0] & { index: number });

        expect(command).toEqual({
            kind: 'jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            seq: 34,
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('preserves explicit jump-to-seq alignment as a semantic command option', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'jump-to-seq',
            sessionId: 'session-a',
            seq: 34,
            align: { kind: 'top-with-item-offset', itemOffsetPx: 24 },
        });

        expect(command).toEqual({
            kind: 'jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            seq: 34,
            align: { kind: 'top-with-item-offset', itemOffsetPx: 24 },
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('resolves jump-to-seq failure recovery from platform failure facts', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'recover-jump-to-seq',
            sessionId: 'session-a',
            failedRenderedIndex: 4.8,
            averageItemLengthPx: 123.6,
            animated: true,
        } as Parameters<typeof controller.resolve>[0] & {
            type: 'recover-jump-to-seq';
            failedRenderedIndex: number;
            averageItemLengthPx: number;
            animated: true;
        });

        expect(command).toEqual({
            kind: 'recover-jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            failedRenderedIndex: 4,
            averageItemLengthPx: 123,
            animated: true,
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('prefers jump to bottom over unpinned restore', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: { shouldFollowBottom: false, distanceFromLiveTailPx: 420 },
            jumpToSeq: null,
        });

        const command = controller.resolve({
            type: 'jump-to-bottom',
            sessionId: 'session-a',
        });

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-bottom',
            mode: 'jump-to-bottom',
            force: true,
            animated: true,
        });
        expect(controller.getMode()).toBe('jump-to-bottom');
    });

    it('resolves fallback bottom pins through the controller', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            animated: false,
        });

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            animated: false,
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('resolves explicit restore-distance corrections as semantic distance commands', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'restore-distance',
            sessionId: 'session-a',
            reason: 'entry-restore',
            distanceFromLiveTailPx: 657.9,
            contentHeight: 36800.6,
            animated: false,
        });

        expect(command).toEqual({
            kind: 'restore-distance',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-distance',
            distanceFromLiveTailPx: 657,
            contentHeight: 36800,
            animated: false,
        });
        expect(controller.getMode()).toBe('restore-distance');
    });

    it('resolves prepend fallback corrections as semantic history correction commands', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'apply-history-correction',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            targetDistanceFromHistoryStartPx: 820.8,
            animated: false,
        } as Parameters<typeof controller.resolve>[0] & {
            type: 'apply-history-correction';
            reason: 'prepend-restore';
            targetDistanceFromHistoryStartPx: number;
            animated: false;
        });

        expect(command).toEqual({
            kind: 'apply-history-correction',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            mode: 'restore-anchor',
            targetDistanceFromHistoryStartPx: 820,
            animated: false,
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('resolves explicit anchor restores without first-paint semantics', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'restore-anchor',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            anchor: { kind: 'toolGroup', itemId: 'tool-group-7', messageId: 'tool-7' },
            itemOffsetPx: 42.5,
            index: 7.8,
            viewOffset: -42.5,
            animated: false,
        } as Parameters<typeof controller.resolve>[0] & { index: number; viewOffset: number });

        expect(command).toEqual({
            kind: 'restore-anchor',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            mode: 'restore-anchor',
            target: {
                anchor: { kind: 'toolGroup', itemId: 'tool-group-7', messageId: 'tool-7' },
                itemOffsetPx: 42,
            },
            animated: false,
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('resolves visible web anchor correction as a semantic restore command', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'restore-visible-anchor',
            sessionId: 'session-a',
            reason: 'entry-restore',
            anchor: { kind: 'item', itemId: 'turn-1', messageId: null },
            itemOffsetPx: 72,
            animated: false,
        } as Parameters<typeof controller.resolve>[0]);

        expect(command).toEqual({
            kind: 'restore-visible-anchor',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-anchor',
            target: {
                anchor: { kind: 'item', itemId: 'turn-1', messageId: null },
                itemOffsetPx: 72,
            },
            animated: false,
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('resolves web prepend anchor correction as a semantic strategy-preserving command', () => {
        const controller = createTranscriptViewportController();
        const prependAnchor = {
            metrics: {
                element: {} as HTMLElement,
                scrollTop: 400,
                scrollHeight: 1800,
                clientHeight: 600,
            },
            anchorTestId: 'transcript-anchor-message-m1',
            anchorTop: 96,
            itemTestId: 'transcript-item-turn:1',
            itemTop: 40,
            stabilizeForMs: 3000,
            userIntentAtMs: 1,
            expiresAtMs: 5000,
        };

        const command = controller.resolve({
            type: 'restore-web-prepend-anchor',
            sessionId: 'session-a',
            anchor: prependAnchor,
            animated: false,
        } as Parameters<typeof controller.resolve>[0]);

        expect(command).toEqual({
            kind: 'restore-web-prepend-anchor',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            mode: 'restore-anchor',
            anchor: prependAnchor,
            animated: false,
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('does not repin passive drift while user unpinned', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'user-scroll',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
        });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: false,
            reason: 'stream-append',
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-a',
            reason: 'user-unpinned',
            mode: 'user-unpinned',
        });
        expect(controller.getMode()).toBe('user-unpinned');
    });

    it('preserves automatic native MVCP-only skip reason', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
        });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'initial-open',
            skipNativeJsPin: true,
        } as Parameters<typeof controller.resolve>[0]);

        expect(command).toEqual({
            kind: 'skip-native-js-pin',
            sessionId: 'session-a',
            reason: 'initial-open',
            skipReason: 'mvcp-only',
            mode: 'follow-bottom',
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('resolves automatic native follow from observed metrics as semantic pin-bottom', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
        });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'content-size-change',
            observedContentHeightPx: 1200.9,
            observedLayoutHeightPx: 600.4,
        } as Parameters<typeof controller.resolve>[0]);

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'content-size-change',
            mode: 'follow-bottom',
            contentHeight: 1200.9,
            layoutHeight: 600.4,
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('resolves web live-tail distance preservation as a semantic follow command', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
        });

        const command = controller.resolve({
            type: 'preserve-live-tail-distance',
            sessionId: 'session-a',
            previousDistanceFromLiveTailPx: 10.8,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'content-size-change',
        } as Parameters<typeof controller.resolve>[0]);

        expect(command).toEqual({
            kind: 'preserve-live-tail-distance',
            sessionId: 'session-a',
            reason: 'content-size-change',
            mode: 'follow-bottom',
            previousDistanceFromLiveTailPx: 10,
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('settles jump to bottom back to follow bottom', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({ type: 'jump-to-bottom', sessionId: 'session-a' });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 0,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'stream-append',
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-a',
            reason: 'already-pinned',
            mode: 'follow-bottom',
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('resets to hydrating on session identity change', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
        });

        const command = controller.resolve({
            type: 'user-scroll',
            sessionId: 'session-b',
            distanceFromBottom: 200,
            pinThresholdPx: 80,
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-b',
            reason: 'session-change',
            mode: 'hydrating',
        });
        expect(controller.getMode()).toBe('hydrating');
    });

    it('uses adapter-specific command targets for shared modes', () => {
        const webController = createTranscriptViewportController();
        const nativeController = createTranscriptViewportController();

        const webCommand = webController.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: { shouldFollowBottom: false, distanceFromLiveTailPx: 120 },
            jumpToSeq: null,
        });
        const nativeCommand = nativeController.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: { shouldFollowBottom: false, distanceFromLiveTailPx: 120 },
            jumpToSeq: null,
        });

        expect(webCommand).toMatchObject({
            kind: 'restore-distance',
            mode: 'restore-distance',
            distanceFromLiveTailPx: 120,
        });
        expect(nativeCommand).toMatchObject({
            kind: 'restore-distance',
            mode: 'restore-distance',
            distanceFromLiveTailPx: 120,
        });
    });
});
