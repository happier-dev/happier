import { describe, expect, it } from 'vitest';

import { createTranscriptViewportCommandController } from './createTranscriptViewportCommandController';
import type {
    TranscriptViewportCommand,
    TranscriptViewportOwner,
} from './transcriptViewportTypes';

type RejectedWrite = Readonly<{
    activeOwner: TranscriptViewportOwner;
    command: TranscriptViewportCommand;
    rejectedOwner: TranscriptViewportOwner;
}>;

function makeAdapter(options: Readonly<{ isWeb?: boolean; webPrependWindowOpen?: boolean }> = {}) {
    const executed: TranscriptViewportCommand[] = [];
    const rejected: RejectedWrite[] = [];
    const clearedWebPrependWindows: string[] = [];
    return {
        adapter: {
            clearWebPrependRestoreWindow: (outcome: string) => {
                clearedWebPrependWindows.push(outcome);
            },
            hasWebPrependRestoreWindow: () => options.webPrependWindowOpen === true,
            isWeb: options.isWeb === true,
            perform: (command: TranscriptViewportCommand) => {
                executed.push(command);
                return true;
            },
            recordRejectedWrite: (write: RejectedWrite) => {
                rejected.push(write);
            },
        },
        clearedWebPrependWindows,
        executed,
        rejected,
    };
}

describe('transcript viewport command controller', () => {
    it('rejects follow writes while an entry transaction owns the viewport', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: true, sessionId: 'session-a' });
        const { adapter, executed, rejected } = makeAdapter();

        const accepted = controller.execute({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'stream-append',
            mode: 'follow-bottom',
        }, adapter);

        expect(accepted).toBe(false);
        expect(executed).toHaveLength(0);
        expect(rejected).toEqual([
            expect.objectContaining({
                activeOwner: 'entry',
                rejectedOwner: 'follow',
                command: expect.objectContaining({ reason: 'stream-append' }),
            }),
        ]);
    });

    it('lets explicit jumps preempt an entry transaction and returns to follow ownership', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: true, sessionId: 'session-a' });
        const { adapter, executed, rejected } = makeAdapter();

        const accepted = controller.execute({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-bottom',
            mode: 'jump-to-bottom',
            force: true,
            animated: true,
        }, adapter);

        expect(accepted).toBe(true);
        expect(executed).toHaveLength(1);
        expect(rejected).toHaveLength(0);
        expect(controller.activeOwner()).toBe('follow');
    });

    it('drops stale commands for a previous session before adapter side effects', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: false, sessionId: 'session-a' });
        controller.setCurrentSessionId('session-b');
        const { adapter, executed, rejected } = makeAdapter();

        const accepted = controller.execute({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'stream-append',
            mode: 'follow-bottom',
        }, adapter);

        expect(accepted).toBe(false);
        expect(executed).toHaveLength(0);
        expect(rejected).toHaveLength(0);
    });

    it('clears the web prepend restore window when an explicit write executes so a stale anchor cannot re-assert after the jump lands', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: false, sessionId: 'session-a' });
        const { adapter, executed, clearedWebPrependWindows } = makeAdapter({ isWeb: true, webPrependWindowOpen: true });

        const accepted = controller.execute({
            kind: 'jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            seq: 42,
        }, adapter);

        expect(accepted).toBe(true);
        expect(executed).toHaveLength(1);
        expect(clearedWebPrependWindows).toEqual(['preempted']);
    });

    it('does not clear the web prepend restore window on explicit writes when no window is armed or off web', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: false, sessionId: 'session-a' });

        const noWindow = makeAdapter({ isWeb: true, webPrependWindowOpen: false });
        expect(controller.execute({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-bottom',
            mode: 'jump-to-bottom',
            force: true,
        }, noWindow.adapter)).toBe(true);
        expect(noWindow.clearedWebPrependWindows).toEqual([]);

        const native = makeAdapter({ isWeb: false, webPrependWindowOpen: true });
        expect(controller.execute({
            kind: 'jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            seq: 7,
        }, native.adapter)).toBe(true);
        expect(native.clearedWebPrependWindows).toEqual([]);
    });

    it('opens and closes web prepend ownership around prepend command windows', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: false, sessionId: 'session-a' });
        const prependAdapter = makeAdapter({ isWeb: true, webPrependWindowOpen: true });

        expect(controller.execute({
            kind: 'restore-distance',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            mode: 'restore-distance',
            distanceFromLiveTailPx: 120,
        }, prependAdapter.adapter)).toBe(true);
        expect(controller.activeOwner()).toBe('prepend');

        const followAdapter = makeAdapter({ isWeb: true, webPrependWindowOpen: false });
        expect(controller.execute({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'stream-append',
            mode: 'follow-bottom',
        }, followAdapter.adapter)).toBe(true);
        expect(controller.activeOwner()).toBe('follow');
    });
});
