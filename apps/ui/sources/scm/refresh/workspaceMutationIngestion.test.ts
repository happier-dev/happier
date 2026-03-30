import { describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/sync/typesRaw';

import { createWorkspaceMutationIngestion } from './workspaceMutationIngestion';

function toolCallMessage(toolName: string, toolInput: unknown): NormalizedMessage {
    return {
        id: `msg-${toolName}`,
        localId: null,
        createdAt: 1000,
        role: 'agent',
        isSidechain: false,
        content: [
            {
                type: 'tool-call',
                id: `tool-${toolName}`,
                name: toolName,
                input: toolInput as any,
                description: null,
                uuid: `uuid-${toolName}`,
                parentUUID: null,
            },
        ],
    };
}

describe('createWorkspaceMutationIngestion', () => {
    it('routes known mutations to invalidateKnownMutation and unknown-only to invalidateUnknownMutation', () => {
        const invalidateKnownMutation = vi.fn();
        const invalidateUnknownMutation = vi.fn();
        let nextTimerId = 1;
        let pendingTimers: Array<Readonly<{ id: number; fn: () => void }>> = [];

        function flushNextTimer() {
            const nextTimer = pendingTimers.shift();
            nextTimer?.fn();
        }

        const ingestion = createWorkspaceMutationIngestion({
            debounceMs: 100,
            minUnknownOnlyIntervalMs: 1500,
            now: () => 1_000,
            setTimer: (fn) => {
                const id = nextTimerId++;
                pendingTimers.push({ id, fn });
                return id;
            },
            clearTimer: (handle) => {
                pendingTimers = pendingTimers.filter((timer) => timer.id !== handle);
            },
            invalidateKnownMutation,
            invalidateUnknownMutation,
        });

        ingestion.ingest('s1', [toolCallMessage('file-edit', { filePath: 'a.ts' })]);
        flushNextTimer();

        expect(invalidateKnownMutation).toHaveBeenCalledTimes(1);
        expect(invalidateKnownMutation).toHaveBeenCalledWith('s1', ['a.ts']);
        expect(invalidateUnknownMutation).not.toHaveBeenCalled();

        ingestion.ingest('s1', [toolCallMessage('bash', { command: 'echo hi' })]);
        flushNextTimer();

        expect(invalidateUnknownMutation).toHaveBeenCalledTimes(1);
    });
});
