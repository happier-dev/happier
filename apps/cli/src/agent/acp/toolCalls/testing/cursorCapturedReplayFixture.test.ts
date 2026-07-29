import { describe, expect, it } from 'vitest';

import { CURSOR_CAPTURED_REPLAY_V1 } from './cursorCapturedReplayFixture';

function updatesFor(toolCallId: string): readonly Readonly<Record<string, unknown>>[] {
    return CURSOR_CAPTURED_REPLAY_V1.updates.filter((update) => update.toolCallId === toolCallId);
}

describe('CURSOR_CAPTURED_REPLAY_V1', () => {
    it('retains the captured lifecycle shapes in addition to its headline cardinality', () => {
        const callIds = new Set(CURSOR_CAPTURED_REPLAY_V1.updates
            .map((update) => update.toolCallId)
            .filter((value): value is string => typeof value === 'string'));
        expect(callIds.size).toBe(271);
        expect([...callIds].filter((id) => id.startsWith('captured-edit-'))).toHaveLength(30);
        expect([...callIds].filter((id) => id.startsWith('captured-task-'))).toHaveLength(6);

        expect(updatesFor('captured-edit-001').map((update) => update.status))
            .toEqual(['pending', 'in_progress', 'completed', 'completed']);
        expect(updatesFor('captured-read-001')).toEqual([
            expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: expect.any(Object) }),
        ]);
        expect(updatesFor('captured-bash-057')).toEqual([
            expect.objectContaining({ sessionUpdate: 'tool_call', status: 'pending' }),
            expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'cancelled' }),
        ]);
        expect(updatesFor('captured-task-001').at(0)).toMatchObject({
            sessionUpdate: 'tool_call',
            status: 'pending',
            rawInput: { _toolName: 'task' },
        });
        expect(updatesFor('captured-create-plan-001').map((update) => update.status))
            .toEqual(['pending', 'in_progress']);
        expect(CURSOR_CAPTURED_REPLAY_V1.lateEnrichment).toEqual([
            expect.objectContaining({ toolCallId: 'captured-edit-001', status: 'completed' }),
        ]);
    });
});
