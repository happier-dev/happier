import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { readBackgroundTaskLaunches } from './backgroundTaskLaunches';

function bashMessage(params: Readonly<{
    id: string;
    seq?: number;
    input?: Record<string, unknown>;
    result?: unknown;
    toolId?: string;
}>): Message {
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: 1_700_000_000_000,
        ...(params.seq !== undefined ? { seq: params.seq } : {}),
        children: [],
        tool: {
            id: params.toolId ?? 'toolu_1',
            name: 'Bash',
            state: 'completed',
            input: params.input ?? { command: 'sleep 60', run_in_background: true },
            createdAt: 1_700_000_000_000,
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_001_000,
            description: null,
            result: params.result,
        },
    } as unknown as Message;
}

describe('readBackgroundTaskLaunches', () => {
    it('joins a launch to its provider task id from the nested tool result', () => {
        const launches = readBackgroundTaskLaunches([
            bashMessage({
                id: 'msg_1',
                seq: 42,
                result: { tool_use_result: { stdout: '', backgroundTaskId: 'task_1' } },
            }),
        ]);

        expect(launches.get('task_1')).toEqual({
            messageId: 'msg_1',
            seq: 42,
            toolCallId: 'toolu_1',
        });
    });

    it('joins a launch when the transcript stored the result as JSON text', () => {
        // This is the ordinary Claude path, not an edge case: `sync/typesRaw/normalize.ts`
        // JSON-encodes `toolUseResult` through `toolResultContentToText`, and the reducer stores
        // that string verbatim as `tool.result`. A reader that only accepts objects finds nothing
        // here and the deep link silently disappears on every real session.
        const launches = readBackgroundTaskLaunches([
            bashMessage({
                id: 'msg_1',
                seq: 11,
                result: JSON.stringify({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task_json' }),
            }),
        ]);

        expect(launches.get('task_json')?.messageId).toBe('msg_1');
    });

    it('accepts the snake-cased spelling the provider result may use', () => {
        const launches = readBackgroundTaskLaunches([
            bashMessage({ id: 'msg_1', seq: 7, result: { background_task_id: 'task_2' } }),
        ]);

        expect(launches.get('task_2')?.messageId).toBe('msg_1');
    });

    it('links a detached command whose input never carried the request flag', () => {
        // `BashInput.run_in_background` is a REQUEST the provider may decline, so it cannot be the
        // gate: the task id on the result is the only attestation that detaching happened, and
        // requiring the flag would silently drop the deep link on a real command.
        const launches = readBackgroundTaskLaunches([
            bashMessage({
                id: 'msg_1',
                seq: 3,
                input: { command: 'ls' },
                result: { tool_use_result: { backgroundTaskId: 'task_3' } },
            }),
        ]);

        expect(launches.get('task_3')?.messageId).toBe('msg_1');
    });

    it('reports an absent sequence rather than inventing one', () => {
        const launches = readBackgroundTaskLaunches([
            bashMessage({ id: 'msg_1', result: { tool_use_result: { backgroundTaskId: 'task_4' } } }),
        ]);

        expect(launches.get('task_4')?.seq).toBeNull();
    });

    it('keeps the first occurrence when a transcript replays the same launch', () => {
        const launches = readBackgroundTaskLaunches([
            bashMessage({ id: 'msg_first', seq: 1, result: { tool_use_result: { backgroundTaskId: 'task_5' } } }),
            bashMessage({ id: 'msg_second', seq: 9, result: { tool_use_result: { backgroundTaskId: 'task_5' } } }),
        ]);

        expect(launches.get('task_5')?.messageId).toBe('msg_first');
    });

    it('ignores transcripts with no backgrounded shell at all', () => {
        const launches = readBackgroundTaskLaunches([
            bashMessage({ id: 'msg_1', seq: 1, input: { command: 'ls' }, result: { stdout: 'a' } }),
            { kind: 'agent-text', id: 'msg_2', localId: null, createdAt: 1, text: 'hi' } as unknown as Message,
        ]);

        expect(launches.size).toBe(0);
    });
});
