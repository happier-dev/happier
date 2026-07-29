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

function makeAdapter() {
    const executed: TranscriptViewportCommand[] = [];
    const rejected: RejectedWrite[] = [];
    return {
        adapter: {
            perform: (command: TranscriptViewportCommand) => {
                executed.push(command);
                return true;
            },
            recordRejectedWrite: (write: RejectedWrite) => {
                rejected.push(write);
            },
        },
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

});
