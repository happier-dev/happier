import { describe, expect, it } from 'vitest';

import {
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    type AgentActivityEntry,
} from '@/sync/domains/session/agentActivity';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { resolveSessionAgentActivityPresentation } from './sessionAgentActivityPresentation';
import { WORKER_KIND_GLYPHS } from '@/components/sessions/work/workerKindGlyphs';

function entry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
    return {
        id: 'execution_run:run_1',
        kind: 'execution_run',
        status: 'running',
        title: 'Published title',
        metaDetail: null,
        startedAtMs: null,
        endedAtMs: null,
        provenance: 'merged',
        detailState: 'loaded',
        parentId: null,
        runId: 'run_1',
        sidechainId: null,
        subagentId: 'execution_run:run_1',
        attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
        ...overrides,
    };
}

function subagent(overrides: Partial<SessionSubagent> = {}): SessionSubagent {
    return {
        id: 'execution_run:run_1',
        kind: 'execution_run',
        status: 'running',
        display: { title: 'Local title', providerLabel: 'Claude' },
        transcript: {},
        recipient: null,
        capabilities: {
            canOpen: true,
            canSend: false,
            canStop: false,
            canLaunchChild: false,
            canDelete: false,
            canOpenAdvancedRun: false,
        },
        timestamps: {},
        runRef: { runId: 'run_1' },
        ...overrides,
    };
}

describe('resolveSessionAgentActivityPresentation', () => {
    it('uses the shared session worker mark for session-like agents without a brand mark', () => {
        for (const kind of ['subagent', 'workflow_agent'] as const) {
            expect(resolveSessionAgentActivityPresentation({ entry: entry({ kind }) }).iconName)
                .toBe(WORKER_KIND_GLYPHS.session);
        }
    });
    it('says a permission request needs approval', () => {
        const presentation = resolveSessionAgentActivityPresentation({
            entry: entry({ status: 'waiting', attentionKinds: ['permission'] }),
        });

        expect(presentation.attention).toMatchObject({ label: 'Needs approval', variant: 'attention' });
        expect(presentation.accessibilityLabel).toContain('Needs approval');
    });

    it('says an agent question needs an answer, which the boolean predecessor could never say', () => {
        const presentation = resolveSessionAgentActivityPresentation({
            entry: entry({ status: 'waiting', attentionKinds: ['user_action'] }),
        });

        expect(presentation.attention).toMatchObject({ label: 'Needs your answer', variant: 'attention' });
    });

    it('shows one concise label for both kinds while naming both to a screen reader', () => {
        const presentation = resolveSessionAgentActivityPresentation({
            entry: entry({ status: 'waiting', attentionKinds: ['permission', 'user_action'] }),
        });

        expect(presentation.attention).toMatchObject({ label: 'Needs attention', variant: 'attention' });
        expect(presentation.accessibilityLabel).toContain('Needs approval and needs your answer');
    });

    it('carries no attention when nothing is waiting on a person', () => {
        expect(resolveSessionAgentActivityPresentation({ entry: entry() }).attention).toBeNull();
    });

    it('translates the canonical status rather than painting a raw token on screen', () => {
        expect(resolveSessionAgentActivityPresentation({ entry: entry({ status: 'timedOut' }) }))
            .toMatchObject({ statusLabel: 'Timed out', statusTone: 'attention' });
        expect(resolveSessionAgentActivityPresentation({ entry: entry({ status: 'failed' }) }).statusTone)
            .toBe('danger');
    });

    it('takes its tone from the one work-status owner: healthy work is neutral, never green or blue (INT T4)', () => {
        for (const status of ['running', 'succeeded', 'queued', 'cancelled'] as const) {
            expect(resolveSessionAgentActivityPresentation({ entry: entry({ status }) }).statusTone).toBe('neutral');
        }
        expect(resolveSessionAgentActivityPresentation({ entry: entry({ status: 'succeeded' }) }).statusLabel).toBe('Completed');
        // Running is said by the activity ring and the clock; queued is still named.
        expect(resolveSessionAgentActivityPresentation({ entry: entry({ status: 'running' }) }).statusShownByActivity).toBe(true);
        expect(resolveSessionAgentActivityPresentation({ entry: entry({ status: 'queued' }) }).statusShownByActivity).toBe(false);
    });

    it('reads the merged status, never the local subagent status a host might still hold', () => {
        const presentation = resolveSessionAgentActivityPresentation({
            entry: entry({ status: 'succeeded' }),
            subagent: subagent({ status: 'running' }),
        });

        expect(presentation.statusLabel).toBe('Completed');
    });

    it('prefers the local title, and falls back to the entry title for an unloaded row', () => {
        expect(resolveSessionAgentActivityPresentation({ entry: entry(), subagent: subagent() }).title)
            .toBe('Local title');
        expect(resolveSessionAgentActivityPresentation({ entry: entry({ detailState: 'unloaded' }) }).title)
            .toBe('Published title');
    });

    it('never repeats a fact, and never shows a run id masquerading as a title', () => {
        const presentation = resolveSessionAgentActivityPresentation({
            entry: entry(),
            subagent: subagent({
                display: { title: 'run_1', providerLabel: 'Claude', subtitle: 'Claude' },
            }),
        });

        expect(presentation.title).not.toBe('run_1');
        expect(presentation.facts.filter((fact) => fact === 'Claude')).toHaveLength(1);
        // A named row never spells its run id; the id lives in the Run's details.
        expect(presentation.facts).not.toContain('run_1');
    });

    it('names a Run by what it is for — a Conversation, a Review, a Plan — never by its raw intent token', () => {
        const conversation = resolveSessionAgentActivityPresentation({
            entry: entry(),
            subagent: subagent({
                display: { title: 'Is 5 attempts enough?', providerLabel: 'Claude', subtitle: 'delegate' },
                runRef: { runId: 'run_1', intent: 'delegate', runClass: 'long_lived' },
            }),
        });
        expect(conversation.facts[0]).toBe('Conversation');
        expect(conversation.facts).not.toContain('delegate');

        const review = resolveSessionAgentActivityPresentation({
            entry: entry(),
            subagent: subagent({
                display: { title: 'Review #2481 changes', subtitle: 'review' },
                runRef: { runId: 'run_1', intent: 'review', runClass: 'bounded' },
            }),
        });
        expect(review.facts[0]).toBe('Review');
        expect(review.facts).not.toContain('review');
    });

    it('says where a Run came from, right after what it is, when the host knows the origin', () => {
        const presentation = resolveSessionAgentActivityPresentation({
            entry: entry(),
            subagent: subagent({ runRef: { runId: 'run_1', intent: 'delegate', runClass: 'long_lived' } }),
            originLabel: 'from Relay retry plan',
        });

        expect(presentation.facts.slice(0, 2)).toEqual(['Conversation', 'from Relay retry plan']);
    });
});


describe('retained execution-run current work', () => {
    it('retains sendable idle handles while only current work contributes to activity', async () => {
        const { deriveExecutionRunSubagents } = await import('@/sync/domains/session/subagents/executionRuns/deriveExecutionRunSubagents');
        const { toLocalAgentActivityEntry, deriveAgentActivityEntries, deriveAgentActivityCounts, toAgentActivityCountable, sortAgentActivityEntries } = await import('@/sync/domains/session/agentActivity');
        const project = (turnInFlight: boolean) => {
            const subagents = deriveExecutionRunSubagents({ messages: [], activeExecutionRuns: [
                { runId: 'a-idle', status: 'running', runClass: 'long_lived', turnInFlight },
                { runId: 'z-busy', status: 'running', runClass: 'long_lived', turnInFlight: true },
            ] });
            const merged = deriveAgentActivityEntries({ headline: null, local: subagents.map((subagent) => toLocalAgentActivityEntry({ subagent })) });
            return { subagents, merged, sorted: sortAgentActivityEntries(merged.entries, merged.evidenceAtMsById), counts: deriveAgentActivityCounts(merged.entries.map(toAgentActivityCountable)) };
        };
        const idle = project(false);
        expect(idle.counts.live).toBe(1);
        expect(idle.sorted[0]?.runId).toBe('z-busy');
        expect(idle.subagents[0]).toMatchObject({ status: 'running', isActive: false, capabilities: { canSend: true, canStop: true } });
        expect(resolveSessionAgentActivityPresentation({ entry: idle.merged.entries[0]!, subagent: idle.subagents[0] }))
            .toMatchObject({ phase: 'idle', startedAtMs: null, atMs: null, statusShownByActivity: false });
        expect(project(true).counts.live).toBe(2);
        expect(project(false).counts.live).toBe(1);
    });

    it('keeps permission attention separate from idle work counts and still counts a failed run', async () => {
        const { deriveExecutionRunSubagents } = await import('@/sync/domains/session/subagents/executionRuns/deriveExecutionRunSubagents');
        const { toLocalAgentActivityEntry, deriveAgentActivityEntries, deriveAgentActivityCounts, toAgentActivityCountable } = await import('@/sync/domains/session/agentActivity');
        const failedMessage: ToolCallMessage = {
            kind: 'tool-call', id: 'failed-message', localId: null, createdAt: 1_000,
            tool: {
                id: 'failed-tool', name: 'SubAgentRun', state: 'completed',
                input: { runId: 'failed', intent: 'delegate', runClass: 'long_lived', ioMode: 'streaming' },
                result: { runId: 'failed', status: 'failed' },
                createdAt: 1_000, startedAt: 1_000, completedAt: 2_000,
                description: null,
            }, children: [],
        };
        const subagents = deriveExecutionRunSubagents({ messages: [failedMessage], activeExecutionRuns: [
            { runId: 'idle', status: 'running', runClass: 'long_lived', turnInFlight: false },
            { runId: 'busy', status: 'running', runClass: 'long_lived', turnInFlight: true },
        ] });
        const local = subagents.map((subagent) => toLocalAgentActivityEntry({
            subagent,
            attentionKinds: subagent.runRef?.runId === 'idle' ? ['permission'] : [],
        }));
        expect(local.find((entry) => entry.runId === 'idle')).toMatchObject({ status: 'waiting', isActive: false });
        const merged = deriveAgentActivityEntries({ headline: null, local });
        expect(deriveAgentActivityCounts(merged.entries.map(toAgentActivityCountable))).toMatchObject({ live: 1, total: 3 });
        expect(merged.entries.find((entry) => entry.runId === 'failed')).toMatchObject({ status: 'failed', isActive: false });
    });

    it('keeps missing turn evidence conservative and bounded running work active', async () => {
        const { deriveExecutionRunSubagents } = await import('@/sync/domains/session/subagents/executionRuns/deriveExecutionRunSubagents');
        const subagents = deriveExecutionRunSubagents({ messages: [], activeExecutionRuns: [
            { runId: 'legacy', status: 'running', runClass: 'long_lived' },
            { runId: 'bounded', status: 'running', runClass: 'bounded', turnInFlight: false },
        ] });
        expect(subagents.map((subagent) => subagent.isActive)).toEqual([true, true]);
    });
});
