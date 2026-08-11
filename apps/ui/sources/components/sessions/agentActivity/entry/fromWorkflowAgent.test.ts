import { buildAgentActivityEntryId } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowAgentRowViewModel } from '@/components/sessions/workState/sessionWorkflowActivityTypes';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            const last = key.split('.').pop() ?? key;
            if (params && Object.keys(params).length > 0) {
                return `${last}:${Object.values(params).join(',')}`;
            }
            return last;
        },
    });
});

import { resolveAgentActivityEntryFromWorkflowAgent } from './fromWorkflowAgent';

/** The id the row model actually carries, from the owner — never a stale hand-spelled one. */
const AGENT_ROW_ID = buildAgentActivityEntryId({
    kind: 'workflow_agent',
    runId: 'wf_1',
    agentId: 'a1',
});

function agent(over: Partial<WorkflowAgentRowViewModel> = {}): WorkflowAgentRowViewModel {
    return {
        rowId: AGENT_ROW_ID,
        runId: 'wf_1',
        agentId: 'a1',
        title: 'researcher',
        status: 'active',
        ...over,
    };
}

describe('resolveAgentActivityEntryFromWorkflowAgent', () => {
    it('carries the row identity and maps the workflow status through the protocol adapter', () => {
        const entry = resolveAgentActivityEntryFromWorkflowAgent(agent({ status: 'complete' }));

        // Carried through verbatim: this source must never re-spell an id the row model already
        // holds, because the merge joins the two ends of one agent by exactly that string.
        expect(entry.id).toBe(AGENT_ROW_ID);
        expect(entry.title).toBe('researcher');
        // Not `complete`: the presentation vocabulary is the protocol's, reached through the adapter.
        expect(entry.status).toBe('succeeded');
        // A workflow agent row offers no overflow actions, so the row must render none.
        expect(entry.actions).toHaveLength(0);
    });

    it('maps a blocked workflow agent to `blocked`, never to `waiting`', () => {
        // A workflow block waits on a phase dependency, not on a person; `waiting` is the only
        // status that escalates and must stay reserved for a human.
        expect(resolveAgentActivityEntryFromWorkflowAgent(agent({ status: 'blocked' })).status).toBe('blocked');
    });

    it('composes the provider metrics into the single meta line', () => {
        const entry = resolveAgentActivityEntryFromWorkflowAgent(agent({ tokensUsed: 1200, toolCalls: 3 }));

        expect(entry.metaDetail).toBe('tokens:1.2k · toolCalls:3');
    });

    it('renders no meta line at all when the agent reports no metrics', () => {
        expect(resolveAgentActivityEntryFromWorkflowAgent(agent()).metaDetail).toBeNull();
    });

    it('drops zero-valued metrics instead of claiming `0 tokens`', () => {
        const entry = resolveAgentActivityEntryFromWorkflowAgent(
            agent({ tokensUsed: 0, toolCalls: 0, timeUsedSeconds: 0 }),
        );

        expect(entry.metaDetail).toBeNull();
    });

    it('passes the genuine timestamps through so the row owns the duration', () => {
        const entry = resolveAgentActivityEntryFromWorkflowAgent(agent({
            status: 'complete',
            startedAtMs: 1_000,
            endedAtMs: 65_000,
            timeUsedSeconds: 64,
        }));

        expect(entry.startedAtMs).toBe(1_000);
        expect(entry.endedAtMs).toBe(65_000);
        // The time column will render `1:04`; repeating it in the meta line would print the same
        // duration twice on one row in two different formats.
        expect(entry.metaDetail).toBeNull();
    });

    it('keeps the provider duration in the meta line when the row cannot honestly claim an elapsed value', () => {
        // A terminal agent whose snapshot carries a start but no finish: the elapsed column renders
        // nothing (D-8), so dropping `timeUsedSeconds` here would silently lose the only duration
        // this agent has.
        const entry = resolveAgentActivityEntryFromWorkflowAgent(agent({
            status: 'complete',
            startedAtMs: 1_000,
            timeUsedSeconds: 64,
        }));

        expect(entry.endedAtMs).toBeNull();
        // Through the one elapsed formatter, not a fourth local `Nm Ns` spelling.
        expect(entry.metaDetail).toBe('1:04');
    });

    it('keeps the provider duration for a running agent that never reported a start', () => {
        const entry = resolveAgentActivityEntryFromWorkflowAgent(agent({ status: 'active', timeUsedSeconds: 42 }));

        expect(entry.startedAtMs).toBeNull();
        expect(entry.metaDetail).toBe('0:42');
    });

    it('lets the live clock own the duration for a running agent that did report a start', () => {
        const entry = resolveAgentActivityEntryFromWorkflowAgent(agent({
            status: 'active',
            startedAtMs: 1_000,
            timeUsedSeconds: 42,
            tokensUsed: 500,
        }));

        expect(entry.startedAtMs).toBe(1_000);
        expect(entry.metaDetail).toBe('tokens:500');
    });

    it('returns a stable entry for an unchanged agent view model so the memoized row does not re-render', () => {
        const source = agent({ tokensUsed: 1200 });

        expect(resolveAgentActivityEntryFromWorkflowAgent(source))
            .toEqual(resolveAgentActivityEntryFromWorkflowAgent(source));
    });
});
