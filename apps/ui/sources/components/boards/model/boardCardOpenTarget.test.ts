import { describe, expect, it } from 'vitest';
import type { BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { buildBoardCards, type BoardCard } from './boardCards';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { resolveBoardCardOpenTarget } from './boardCardOpenTarget';

function card(kind: Exclude<BoardItemRefV1['kind'], 'task'>, bucket: BoardCard['status']['bucket'], availability: BoardCard['availability'] = 'ready'): BoardCard {
    return {
        key: `${kind}:x`,
        ref: { kind, qualifiedId: { serverId: 'home-a', id: 'x' } },
        picked: true,
        availability,
        title: 'x',
        status: { state: bucket, bucket, tone: bucket === 'needs_you' ? 'attention' : 'neutral', word: bucket,
            attentionType: bucket === 'needs_you' ? 'decision' : null },
        body: { kind: 'none' },
    };
}

describe('resolveBoardCardOpenTarget', () => {
    it('opens a failed Run update at its owner and sends a concurrent real hold to Inbox', () => {
        const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'failed' } } as const;
        const current = (invocationAttentionRequired: boolean) => buildBoardCards([
            { ref, key: 'failed', picked: true, sourced: false, available: true },
        ], { nowMs: 1, session: () => null, workflow: () => null, machine: () => null,
            machineSessionCounts: new Map(), accountScopedHome: () => true,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
                id: 'failed', state: 'failed', failureUnseen: true, attentionRequired: true, invocationAttentionRequired,
            }), null) })[0]!;
        expect(resolveBoardCardOpenTarget(current(false), { inboxAvailable: true })).toEqual({ kind: 'item', ref });
        expect(resolveBoardCardOpenTarget(current(true), { inboxAvailable: true })).toEqual({
            kind: 'inbox', item: { kind: 'workflow_run', serverId: 'home-a', id: 'failed' },
        });
    });
    it('opens a task only when its current source supplies a page, never an unavailable or unopenable item', () => {
        const task: BoardCard = { ...card('session', 'idle'),
            ref: { kind: 'task', pluginId: 'com.acme.tasks', qualifiedId: { serverId: 'home-a', id: 'task-1' } } };
        expect(resolveBoardCardOpenTarget(task, { inboxAvailable: true })).toBeNull();
        const withPage: BoardCard = { ...task, body: { kind: 'task', item: {
            title: 'Task', category: 'backlog', linkedSessions: [], page: { pageId: 'tasks' },
        } } };
        expect(resolveBoardCardOpenTarget(withPage, { inboxAvailable: true })).toEqual({ kind: 'item', ref: task.ref });
        expect(resolveBoardCardOpenTarget({ ...withPage, availability: 'content_unavailable' }, { inboxAvailable: true })).toBeNull();
    });
    it('routes secondary actions to native detail and the workflow Run composer, not Inbox or direct execution', () => {
        const held = card('workflow_run', 'needs_you');
        expect(resolveBoardCardOpenTarget(held, { inboxAvailable: true, action: 'review' }))
            .toEqual({ kind: 'item', ref: held.ref });
        const workflow = card('workflow', 'idle');
        expect(resolveBoardCardOpenTarget(workflow, { inboxAvailable: true, action: 'run' }))
            .toEqual({ kind: 'item', ref: workflow.ref, intent: 'run' });
        expect(resolveBoardCardOpenTarget({ ...workflow, availability: 'home_unavailable' },
            { inboxAvailable: true, action: 'run' })).toBeNull();
    });

    it('sends needs-you work to its Inbox item, never to the session or run where a card could answer it', () => {
        expect(resolveBoardCardOpenTarget(card('session', 'needs_you'), { inboxAvailable: true }))
            .toEqual({ kind: 'inbox', item: { kind: 'session', serverId: 'home-a', id: 'x' } });
        expect(resolveBoardCardOpenTarget(card('workflow_run', 'needs_you'), { inboxAvailable: true }))
            .toEqual({ kind: 'inbox', item: { kind: 'workflow_run', serverId: 'home-a', id: 'x' } });
    });

    it('opens other work where it lives', () => {
        expect(resolveBoardCardOpenTarget(card('session', 'working'), { inboxAvailable: true }))
            .toEqual({ kind: 'item', ref: { kind: 'session', qualifiedId: { serverId: 'home-a', id: 'x' } } });
        expect(resolveBoardCardOpenTarget(card('machine', 'needs_you'), { inboxAvailable: true }))
            .toEqual({ kind: 'item', ref: { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'x' } } });
    });

    it('opens a task card\'s linked Session as that Session, even when the task has no page of its own', () => {
        const task = { ...card('session', 'idle'), ref: { kind: 'task', pluginId: 'p', qualifiedId: { serverId: 'home-a', id: 't' } },
            body: { kind: 'task', item: { page: null } } } as unknown as BoardCard;
        const action = { session: { serverId: 'home-b', sessionId: 's-1' } };
        expect(resolveBoardCardOpenTarget(task, { inboxAvailable: true, action }))
            .toEqual({ kind: 'item', ref: { kind: 'session', qualifiedId: { serverId: 'home-b', id: 's-1' } } });
        expect(resolveBoardCardOpenTarget({ ...task, availability: 'home_unavailable' }, { inboxAvailable: true, action })).toBeNull();
    });
    it('opens nothing for an item whose Home is not connected', () => {
        expect(resolveBoardCardOpenTarget(card('session', 'offline', 'home_unavailable'), { inboxAvailable: true })).toBeNull();
    });
});
