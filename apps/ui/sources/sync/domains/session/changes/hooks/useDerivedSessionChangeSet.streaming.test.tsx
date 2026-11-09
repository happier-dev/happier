import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture, createToolCallMessageFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { storage } from '@/sync/domains/state/storageStore';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';

import { useDerivedSessionChangeSet } from './useDerivedSessionChangeSet';

afterEach(() => {
    standardCleanup();
});

const diffTool = createToolCallMessageFixture({
    id: 'diff-1', createdAt: 10, seq: 1,
    tool: {
        name: 'Diff', state: 'completed', createdAt: 10, startedAt: 10, completedAt: 11, description: null,
        result: { status: 'completed' },
        input: {
            files: [{ file_path: 'src/app.ts', oldText: 'a\n', newText: 'b\n', unified_diff: 'diff --git a/src/app.ts b/src/app.ts\n' }],
            _happier: { v: 2, protocol: 'codex', provider: 'codex', rawToolName: 'CodexDiff', canonicalToolName: 'Diff',
                sessionChangeScope: 'turn', turnId: 'turn_1', sessionId: 'changes-stream', source: 'provider_native',
                confidence: 'exact', turnStatus: 'completed', seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 } },
        },
    },
});

const chunk = (text: string, updatedAtMs: number): NormalizedMessage => ({
    id: 'stream-segment', localId: 'stream-segment', createdAt: 20, seq: 2,
    role: 'agent', isSidechain: false, content: [{ type: 'text', text, uuid: 'stream-segment', parentUUID: null }],
    meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant',
        segmentLocalId: 'stream-segment', segmentState: 'streaming', startedAtMs: 1, updatedAtMs } },
} as unknown as NormalizedMessage);

describe('useDerivedSessionChangeSet while the Session streams', () => {
    it('does not re-derive or re-render a Review/Files consumer per streamed text delta', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'changes-stream', serverId: 'home-a', thinking: true });
        storage.setState({
            sessions: { ...previous.sessions, [session.id]: session },
            sessionMessages: { ...previous.sessionMessages, [session.id]: createSessionMessagesFixture({
                messageIdsOldestFirst: [diffTool.id], messagesById: { [diffTool.id]: diffTool }, isLoaded: true,
            }) },
        });
        storage.getState().applyMessages(session.id, [chunk('Starting', 2)]);
        const counts = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counts);
            return useDerivedSessionChangeSet({ serverId: 'home-a', sessionId: session.id });
        });
        try {
            const initial = hook.getCurrent();
            expect(initial.turnChangeSets.length).toBe(1);
            counts.reset();
            let text = 'Starting';
            for (let delta = 0; delta < 6; delta++) {
                text += ` token${delta}`;
                await act(async () => { storage.getState().applyMessages(session.id, [chunk(text, 3 + delta)]); });
            }
            expect(hook.getCurrent().turnChangeSets).toBe(initial.turnChangeSets);
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });

            // Freshness: a new tool row still reaches the change set.
            await act(async () => {
                storage.getState().applyMessages(session.id, [{ id: 'tool-2', seq: 3, localId: null, createdAt: 30,
                    isSidechain: false, role: 'agent', content: [{ type: 'tool-call', id: 'call-2', name: 'Bash',
                        input: { command: 'ls' }, description: null, uuid: 'tool-2', parentUUID: null }] } as unknown as NormalizedMessage]);
            });
            expect(counts.read().renders).toBeGreaterThan(0);
        } finally {
            await hook.unmount();
            storage.setState(previous);
        }
    });
});
