import { describe, expect, it, vi } from 'vitest';

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

describe('WorkspaceMutationInvalidator', () => {
    it('debounces and coalesces changed paths per session', () => {
        vi.useFakeTimers();

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
        vi.advanceTimersByTime(199);
        expect(invalidations).toHaveLength(0);
        vi.advanceTimersByTime(1);

        expect(invalidations).toHaveLength(1);
        expect(invalidations[0]?.sessionId).toBe('s1');
        expect(new Set(invalidations[0]?.paths)).toEqual(new Set(['a.ts', 'b.ts']));
        expect(invalidations[0]?.unknown).toBe(false);
    });

    it('rate-limits unknown-only mutations', () => {
        vi.useFakeTimers();

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
        vi.advanceTimersByTime(50);
        expect(invalidations).toHaveLength(1);
        expect(invalidations[0]?.unknown).toBe(true);
        expect(invalidations[0]?.paths).toEqual([]);

        invalidator.ingest('s1', [toolCallMessage('bash', { command: 'echo hi2' })]);
        vi.advanceTimersByTime(50);
        expect(invalidations).toHaveLength(1);

        nowMs += 1600;
        invalidator.ingest('s1', [toolCallMessage('bash', { command: 'echo hi3' })]);
        vi.advanceTimersByTime(50);
        expect(invalidations).toHaveLength(2);
    });

    it('does not invalidate for read-only Diff inspection', () => {
        vi.useFakeTimers();

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
        vi.advanceTimersByTime(50);

        expect(onInvalidate).not.toHaveBeenCalled();
    });

    it('invalidates for canonical Diff mutation signals emitted from provider turn change sets', () => {
        vi.useFakeTimers();

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
        vi.advanceTimersByTime(50);

        expect(onInvalidate).toHaveBeenCalledWith({
            sessionId: 's1',
            changedPaths: ['src/native.ts'],
            hasUnknownMutations: false,
        });
    });
});
