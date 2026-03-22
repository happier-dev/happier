import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/sync/typesRaw';

import { WorkspaceMutationInvalidator } from './workspaceMutationInvalidator';

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

async function advanceTimers(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

describe('WorkspaceMutationInvalidator', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('debounces and coalesces changed paths per session', async () => {
        const invalidations: Array<{ sessionId: string; paths: readonly string[]; unknown: boolean }> = [];
        const now = vi.fn(() => 1_000);
        const invalidator = new WorkspaceMutationInvalidator({
            debounceMs: 200,
            minUnknownOnlyIntervalMs: 1500,
            now,
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (h) => clearTimeout(h as any),
            onInvalidate: (evt) => invalidations.push({ sessionId: evt.sessionId, paths: evt.changedPaths, unknown: evt.hasUnknownMutations }),
        });

        invalidator.ingest('s1', [toolCallMessage('file-edit', { filePath: 'a.ts' })]);
        invalidator.ingest('s1', [toolCallMessage('patch', { changes: [{ path: 'b.ts' }] })]);

        expect(invalidations).toHaveLength(0);
        await advanceTimers(199);
        expect(invalidations).toHaveLength(0);
        await advanceTimers(1);

        expect(invalidations).toHaveLength(1);
        expect(invalidations[0]?.sessionId).toBe('s1');
        expect(new Set(invalidations[0]?.paths)).toEqual(new Set(['a.ts', 'b.ts']));
        expect(invalidations[0]?.unknown).toBe(false);
    });

    it('rate-limits unknown-only mutations', async () => {
        const invalidations: Array<{ sessionId: string; paths: readonly string[]; unknown: boolean }> = [];
        let nowMs = 1_000;
        const now = vi.fn(() => nowMs);
        const invalidator = new WorkspaceMutationInvalidator({
            debounceMs: 50,
            minUnknownOnlyIntervalMs: 1500,
            now,
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (h) => clearTimeout(h as any),
            onInvalidate: (evt) => invalidations.push({ sessionId: evt.sessionId, paths: evt.changedPaths, unknown: evt.hasUnknownMutations }),
        });

        invalidator.ingest('s1', [toolCallMessage('bash', { command: 'echo hi' })]);
        await advanceTimers(50);
        expect(invalidations).toHaveLength(1);
        expect(invalidations[0]?.unknown).toBe(true);
        expect(invalidations[0]?.paths).toEqual([]);

        invalidator.ingest('s1', [toolCallMessage('bash', { command: 'echo hi2' })]);
        await advanceTimers(50);
        expect(invalidations).toHaveLength(1);

        nowMs += 1600;
        invalidator.ingest('s1', [toolCallMessage('bash', { command: 'echo hi3' })]);
        await advanceTimers(50);
        expect(invalidations).toHaveLength(2);
    });

    it('does not invalidate for read-only Diff inspection', async () => {
        const onInvalidate = vi.fn();
        const invalidator = new WorkspaceMutationInvalidator({
            debounceMs: 50,
            minUnknownOnlyIntervalMs: 1500,
            now: () => 1_000,
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (h) => clearTimeout(h as any),
            onInvalidate,
        });

        invalidator.ingest('s1', [toolCallMessage('Diff', {
            files: [
                { file_path: 'src/app.ts', oldText: 'old', newText: 'new' },
            ],
        })]);
        await advanceTimers(50);

        expect(onInvalidate).not.toHaveBeenCalled();
    });

    it('invalidates for canonical Diff mutation signals emitted from provider turn change sets', async () => {
        const onInvalidate = vi.fn();
        const invalidator = new WorkspaceMutationInvalidator({
            debounceMs: 50,
            minUnknownOnlyIntervalMs: 1500,
            now: () => 1_000,
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (h) => clearTimeout(h as any),
            onInvalidate,
        });

        invalidator.ingest('s1', [toolCallMessage('ProviderDiff', {
            files: [
                { file_path: 'src/native.ts', oldText: 'old', newText: 'new' },
            ],
            _happier: {
                canonicalToolName: 'Diff',
                workspaceMutationSignal: 'turn-change-set',
                sessionChangeScope: 'turn',
            },
        })]);
        await advanceTimers(50);

        expect(onInvalidate).toHaveBeenCalledWith({
            sessionId: 's1',
            changedPaths: ['src/native.ts'],
            hasUnknownMutations: false,
        });
    });
});
