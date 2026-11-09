import { describe, expect, it } from 'vitest';

import { createTranscriptViewportController } from '@/components/sessions/transcript/viewport/createTranscriptViewportController';

describe('transcript viewport controller', () => {
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
    });

    it.each([24, -936])('preserves explicit jump-to-seq alignment offset %s as a semantic command option', (itemOffsetPx) => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'jump-to-seq',
            sessionId: 'session-a',
            seq: 34,
            align: { kind: 'top-with-item-offset', itemOffsetPx },
        });

        expect(command).toEqual({
            kind: 'jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            seq: 34,
            align: { kind: 'top-with-item-offset', itemOffsetPx },
        });
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
    });

    it('resolves an explicit jump to bottom as a forced animated pin', () => {
        const controller = createTranscriptViewportController();
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
    });

});
