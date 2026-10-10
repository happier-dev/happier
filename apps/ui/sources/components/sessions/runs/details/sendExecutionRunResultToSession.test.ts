import { describe, expect, it, vi } from 'vitest';

import { sendExecutionRunResultToSession } from './sendExecutionRunResultToSession';

describe('sendExecutionRunResultToSession', () => {
    it('appends the result to the lead composer through the initial-prompt handoff, then reveals and focuses it', async () => {
        const order: string[] = [];
        const appendDraft = vi.fn(async () => { order.push('write'); return true; });
        const sent = await sendExecutionRunResultToSession({
            sessionId: 'lead_1',
            serverId: 'home_1',
            resultText: '  Checkpoint per batch.  ',
            runTitle: 'Add a resume point',
            template: 'From {{SOURCE_SESSION_NAME}}:\n{{MESSAGES}}',
            appendDraft,
            revealPrimaryComposer: () => { order.push('reveal'); },
            focusPrimaryComposer: () => { order.push('focus'); },
        });

        expect(sent).toBe(true);
        expect(appendDraft).toHaveBeenCalledWith({
            sessionId: 'lead_1',
            serverId: 'home_1',
            text: 'From Add a resume point:\nCheckpoint per batch.',
            sourceSessionId: 'lead_1',
        });
        expect(order).toEqual(['write', 'reveal', 'focus']);
    });

    it('stages nothing for an empty result', async () => {
        const appendDraft = vi.fn(async () => true);
        await expect(sendExecutionRunResultToSession({
            sessionId: 'lead_1', serverId: 'home_1', resultText: '   ', runTitle: null, template: '',
            appendDraft, revealPrimaryComposer: vi.fn(), focusPrimaryComposer: vi.fn(),
        })).resolves.toBe(false);
        expect(appendDraft).not.toHaveBeenCalled();
    });

    it('does not reveal or focus the composer when Action admission refuses the append', async () => {
        const revealPrimaryComposer = vi.fn();
        const focusPrimaryComposer = vi.fn();
        await expect(sendExecutionRunResultToSession({
            sessionId: 'lead_1', serverId: 'home_1', resultText: 'Result', runTitle: null, template: '',
            appendDraft: async () => false, revealPrimaryComposer, focusPrimaryComposer,
        })).resolves.toBe(false);
        expect(revealPrimaryComposer).not.toHaveBeenCalled();
        expect(focusPrimaryComposer).not.toHaveBeenCalled();
    });
});
