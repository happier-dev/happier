import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import { buildChatListItemsCached } from '@/components/sessions/chatListItems';
import { makeToolCall } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { applyLatestWorkerUpdateChanges, EMPTY_LATEST_WORKER_UPDATES } from '@/sync/store/latestWorkerUpdates';
import { buildTranscriptTurnsCached } from './buildTranscriptTurns';

const LOCAL_RUN = 'aaaabbbb-abcd-4123-8901-000000000001';
const EXTERNAL_RUN = 'aaaabbbb-abcd-4123-8901-000000000002';

function start(runId: string, seq: number): Message {
    return { kind: 'tool-call', id: `start-${seq}`, localId: null, seq, createdAt: seq, children: [],
        tool: makeToolCall({ name: 'mcp__happier__workflow_run_start', state: 'completed', result: {
            admission: 'created',
            run: createWorkflowRunSummaryFixture({ id: runId, origin: { kind: 'direct', originSessionId: 'this-session' } }),
        } }) };
}

function notice(runId: string, seq: number, ownerState: 'waiting_for_review' | 'running' | 'succeeded'): Message {
    return { kind: 'agent-event', id: `notice-${seq}`, localId: null, seq, createdAt: seq, event: {
        type: 'worker-update',
        update: { v: 1, workerKind: 'workflow_run', workerId: runId, ownerState, headline: ownerState,
            canInspect: true, transcriptPointer: { kind: 'workflow_run', runId },
            ...(ownerState === 'waiting_for_review' ? { wake: 'needs_you' } : {}) },
    } };
}

describe('Workflow Run transcript item ownership', () => {
    it('keeps the named item through live updates and keeps a separate item for a Run started elsewhere', () => {
        const messagesById: Record<string, Message> = {};
        const messageIdsOldestFirst: string[] = [];
        let index = EMPTY_LATEST_WORKER_UPDATES;
        let linear: ReturnType<typeof buildChatListItemsCached>['cache'] | null = null;
        let turns: ReturnType<typeof buildTranscriptTurnsCached> | null = null;
        const append = (message: Message) => {
            messagesById[message.id] = message;
            messageIdsOldestFirst.push(message.id);
            index = applyLatestWorkerUpdateChanges({ previous: index, messages: messagesById, changed: [message] });
            const args = { messageIdsOldestFirst: [...messageIdsOldestFirst], messagesById, pendingMessages: [],
                workflowRunStarts: index.workflowRunStarts };
            const next = buildChatListItemsCached({ ...args, cache: linear });
            linear = next.cache;
            turns = buildTranscriptTurnsCached({ ...args, cache: turns, groupToolCalls: false, toolCallsGroupStrategy: 'consecutive_tools' });
            return {
                items: next.items,
                turnMessageIds: turns.turns.flatMap(turn => turn.content.flatMap(content =>
                    content.kind === 'message' ? [content.messageId] : [])),
            };
        };
        const receipt = start(LOCAL_RUN, 1);
        const initial = append(receipt);
        expect(initial.items).toHaveLength(1);
        for (const [offset, state] of (['waiting_for_review', 'running', 'succeeded'] as const).entries()) {
            const worker = notice(LOCAL_RUN, 2 + offset, state);
            const before = index;
            const next = append(worker);
            expect(next.items).toBe(initial.items);
            expect(next.turnMessageIds).toEqual([receipt.id]);
            expect(index.workflowRunStarts).toBe(before.workflowRunStarts);
            expect(Object.keys(index.workflow_run ?? {})).toEqual([LOCAL_RUN]);
            expect(index.workflow_run?.[LOCAL_RUN]).toMatchObject({ messageId: worker.id, ownerState: state });
        }
        const external = notice(EXTERNAL_RUN, 5, 'waiting_for_review');
        const withExternal = append(external);
        expect(withExternal.items).toHaveLength(2);
        expect(withExternal.items[0]).toBe(initial.items[0]);
        expect(withExternal.turnMessageIds).toEqual([receipt.id, external.id]);
    });
});
