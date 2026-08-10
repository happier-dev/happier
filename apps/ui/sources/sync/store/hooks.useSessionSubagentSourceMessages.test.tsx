import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';
import { useSessionSubagentSourceMessages } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

/**
 * The subagent-source projection's cache signature must track exactly the fields the roster
 * derivation reads — no more.
 *
 * While a `SubAgentRun` tool is still running its result streams, so the signature reduces the
 * result to the run's status instead of serialising the whole payload. That reduction used to be a
 * regex over prose plus a recursive walk for any key named `status`, which is the same defect P0-C
 * removed from the status derivation itself (D-3): a subagent *writing about* a status changed the
 * signature, so the projection handed every consumer a new array and the whole roster re-derived on
 * text that means nothing to it. The structured reader is the one owner of "what status did the
 * execution-run manager report".
 */

const SESSION_ID = 's-subagent-source';

afterEach(() => {
    standardCleanup();
    clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
});

function runningSubAgentRunMessage(result: unknown): Message {
    return createToolCallMessageFixture({
        id: 'message_call_1',
        localId: null,
        createdAt: 1_000,
        tool: {
            id: 'call_1',
            name: 'SubAgentRun',
            state: 'running',
            input: { runId: 'run_1', sidechainId: 'call_1', label: 'Audit' },
            createdAt: 1_000,
            startedAt: 1_000,
            completedAt: null,
            description: null,
            result,
        },
    }) as Message;
}

function seed(message: Message, subagentSourceVersion: number): void {
    const messagesById: Record<string, Message> = { [message.id]: message };
    storage.setState((state) => ({
        ...state,
        sessionMessages: {
            ...state.sessionMessages,
            [SESSION_ID]: createSessionMessagesFixture({
                messageIdsOldestFirst: [message.id],
                messagesById,
                messagesMap: messagesById,
                messagesVersion: subagentSourceVersion,
                subagentSourceVersion,
                isLoaded: true,
            }),
        },
    }));
}

describe('useSessionSubagentSourceMessages result signature', () => {
    it('keeps the projection identity when only prose inside a running run result changes', async () => {
        const previousState = storage.getState();
        try {
            seed(runningSubAgentRunMessage('the reviewer noted status: "failed" in the old build'), 1);

            const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();
            expect(first).toHaveLength(1);

            await act(async () => {
                // A brand new Message object (the store never mutates one in place), so the
                // per-message signature is genuinely recomputed rather than served from the WeakMap.
                seed(runningSubAgentRunMessage('the reviewer noted status: "succeeded" in the old build'), 2);
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('rebuilds the projection when the run manager reports a different structured status', async () => {
        const previousState = storage.getState();
        try {
            seed(runningSubAgentRunMessage({ runId: 'run_1', status: 'running' }), 1);

            const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();
            expect(first).toHaveLength(1);

            await act(async () => {
                seed(runningSubAgentRunMessage({ runId: 'run_1', status: 'timeout' }), 2);
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).not.toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
