import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';

import {
    collectHostText,
    makeSessionWorkflowRunSnapshot,
    makeToolCall,
    makeToolViewProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { buildAgentActivityEntryId, type SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks({
    text: async () => {
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
    },
});

// Boundary mock: the records-backed data hook (crosses sync/network). The renderer itself is real.
const useWorkflowRunForToolUseId = vi.fn();
vi.mock('@/components/sessions/workState/useWorkflowRunDetails', () => ({
    useWorkflowRunForToolUseId: (...args: unknown[]) => useWorkflowRunForToolUseId(...args),
}));

function snapshot(over: Partial<SessionWorkflowRunSnapshotV1>): SessionWorkflowRunSnapshotV1 {
    return makeSessionWorkflowRunSnapshot({ runId: 'wf_1', title: 'Implement', ...over });
}

function largeSnapshot(count: number): SessionWorkflowRunSnapshotV1 {
    return snapshot({
        runId: 'wf_large',
        title: 'Large workflow',
        status: 'active',
        totalAgents: count,
        completedAgents: 8,
        phases: [{ id: 'phase-1', title: 'Implementation', order: 1, agentIds: Array.from({ length: count }, (_, index) => `agent-${index}`) }],
        agents: Array.from({ length: count }, (_, index) => ({
            id: `agent-${index}`,
            title: `Agent ${index}`,
            status: index < 8 ? 'complete' : index === 8 ? 'active' : 'pending',
            updatedAt: index,
            resultPreview: `Result ${index}`,
        })),
    });
}

describe('WorkflowActivityView', () => {
    let WorkflowActivityView!: React.ComponentType<ReturnType<typeof makeToolViewProps>>;

    beforeAll(async () => {
        ({ WorkflowActivityView } = await import('./WorkflowActivityView'));
    }, 60_000);

    async function renderCard(): Promise<renderer.ReactTestRenderer> {
        const tool = makeToolCall({ name: 'Workflow', state: 'running', input: { name: 'Build feature' } });
        const props = { ...makeToolViewProps(tool), sessionId: 'sess_1' };
        return (await renderScreen(React.createElement(WorkflowActivityView, props))).tree;
    }

    it('renders a minimal shell while detail is loading', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({ runHeadline: null, detail: { state: 'loading', runId: 'wf_1' } });
        const tree = await renderCard();
        expect(collectHostText(tree)).toContain('loading');
    });

    it('renders an unavailable shell when the record is missing', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({ runHeadline: null, detail: { state: 'missing', runId: 'wf_1' } });
        const tree = await renderCard();
        expect(collectHostText(tree)).toContain('unavailable');
    });

    it('renders a loaded workflow with phases in order', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: {
                state: 'loaded',
                runId: 'wf_1',
                snapshot: snapshot({
                    title: 'Build feature',
                    status: 'active',
                    totalAgents: 3,
                    completedAgents: 1,
                    tokensUsed: 38000,
                    timeUsedSeconds: 134,
                    phases: [
                        { id: 'p1', title: 'Research', order: 1, agentIds: ['a1'] },
                        { id: 'p2', title: 'Implementation', order: 2, agentIds: ['a2'] },
                        { id: 'p3', title: 'Review', order: 3, agentIds: ['a3'] },
                    ],
                    agents: [
                        { id: 'a1', title: 'web_search', status: 'complete', updatedAt: 1 },
                        { id: 'a2', title: 'editor', status: 'active', updatedAt: 1 },
                        { id: 'a3', title: 'reviewer', status: 'pending', updatedAt: 1 },
                    ],
                }),
            },
        });
        const tree = await renderCard();
        const text = collectHostText(tree);
        expect(text).toContain('Build feature');
        expect(text).toContain('Research');
        expect(text).toContain('Implementation');
        expect(text).toContain('Review');
        // Footer metrics: agents count present.
        expect(text.join(' ')).toContain('agentsCount');
    });

    it('renders name + status + token rollup (no empty agent shell) when detail is absent', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: {
                state: 'loaded',
                runId: 'wf_1',
                snapshot: snapshot({ title: 'Empty', status: 'complete', totalAgents: 0, tokensUsed: 12000 }),
            },
        });
        const tree = await renderCard();
        const text = collectHostText(tree);
        // Name + status are still surfaced.
        expect(text).toContain('Empty');
        expect(text).toContain('statusComplete');
        // Completion summary (token rollup) is shown.
        expect(text.join(' ')).toContain('tokens');
        // Degrade path must NOT claim "0 agents" — that reads as an empty agent shell.
        expect(text.join(' ')).not.toContain('agentsCount');
    });

    it('renders an honest no-detail line when a loaded workflow has no rows or metrics', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: {
                state: 'loaded',
                runId: 'wf_1',
                snapshot: snapshot({ title: 'Empty', status: 'complete', totalAgents: 0 }),
            },
        });

        const tree = await renderCard();
        const text = collectHostText(tree);

        expect(text).toContain('Empty');
        expect(text).toContain('statusComplete');
        expect(text).toContain('noDetail');
        expect(text).not.toContain('loading');
        expect(text).not.toContain('unavailable');
    });

    it('keeps a 300-agent transcript card bounded when progressively expanded', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: {
                state: 'loaded',
                runId: 'wf_large',
                snapshot: largeSnapshot(300),
            },
        });

        const tree = await renderCard();
        expect(collectHostText(tree)).toContain('Agent 8');
        expect(collectHostText(tree)).not.toContain('Agent 299');

        const showMore = tree.root.findByProps({ testID: 'workflow-card-wf_large-show-more' });
        await pressTestInstanceAsync(showMore, 'workflow card show more');

        const afterPress = collectHostText(tree);
        expect(afterPress).toContain('Agent 20');
        expect(afterPress).not.toContain('Agent 299');

        for (let i = 0; i < 30; i += 1) {
            const currentShowMore = tree.root.findAllByProps({ testID: 'workflow-card-wf_large-show-more' })[0];
            if (!currentShowMore) break;
            await pressTestInstanceAsync(currentShowMore, `workflow card show more ${i}`);
        }

        expect(collectHostText(tree)).toContain('Agent 299');
        expect(tree.root.findAllByProps({ testID: 'workflow-card-wf_large-show-more' })).toHaveLength(0);
    });

    /**
     * The deciding check for the host migration (R-5): the card must render agents through the ONE
     * shared row, not through a second component with its own glyph table, its own status colours
     * and its own duration formatter. Every assertion below fails against the row this replaced —
     * it announced the bare title, rendered no status text at all, and put its metrics in a private
     * `Text` rather than the row's detail slot.
     */
    it('renders every agent through the one shared agent-activity row', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: {
                state: 'loaded',
                runId: 'wf_1',
                snapshot: snapshot({
                    runId: 'wf_1',
                    title: 'Investigate',
                    totalAgents: 1,
                    phases: [],
                    agents: [{ id: 'a1', title: 'web_search', status: 'complete', updatedAt: 1, tokensUsed: 1200 }],
                }),
            },
        });

        const tree = await renderCard();
        const rows = tree.root.findAll((node) => {
            const nodeProps = node.props as Record<string, unknown> | undefined;
            return nodeProps != null
                && 'showChevron' in nodeProps
                && 'iconBoxSize' in nodeProps
                && nodeProps.testID === 'workflow-card-agent-wf_1-a1';
        });
        expect(rows).toHaveLength(1);
        const rowProps = rows[0].props as Record<string, unknown>;

        // The translated status word from the PROTOCOL vocabulary (`complete` -> `succeeded`), which
        // is the proof the adapter ran rather than the workflow enum reaching the screen.
        expect(rowProps.accessibilityLabel).toBe('a11yLabel:web_search,succeeded');
        // Still one line: the metrics take the row's right-hand slot, never a second line. A flat
        // two-line row here would grow a six-agent card by half again.
        expect(rowProps.subtitle).toBeNull();
        expect(rowProps.detail).toBe('tokens:1.2k');
        // The fixed leading status column — the scan axis — not a pill drifting with title length.
        expect(tree.root.findAllByProps({ testID: 'workflow-card-agent-wf_1-a1:status' }).length).toBeGreaterThan(0);
    });

    /**
     * One screen must not contradict another about the same agent. The durable record is refetched
     * on its revision, which does not advance for a display-only update, so the card's snapshot can
     * be older than the published headline already knows. Without the later-of join the transcript
     * card says "no update for over 10 min" about an agent the popover and the run panel show as
     * fresh — visible at the same time, on the same screen.
     */
    it('takes the later of the record and headline instants before calling an agent silent', async () => {
        const nowMs = Date.now();
        const workingAgentSnapshot = snapshot({
            runId: 'wf_1',
            title: 'Investigate',
            status: 'active',
            totalAgents: 1,
            phases: [],
            agents: [{ id: 'a2', title: 'editor', status: 'active', updatedAt: nowMs - 1_200_000 }],
        });
        const entryId = buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'wf_1', agentId: 'a2' });

        // Discriminating baseline: with only the stale record instant, the card DOES call it silent.
        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: { state: 'loaded', runId: 'wf_1', snapshot: workingAgentSnapshot },
        });
        expect(collectHostText(await renderCard()).join(' ')).toContain('stale');

        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: { state: 'loaded', runId: 'wf_1', snapshot: workingAgentSnapshot },
            agentEvidenceAtMsById: new Map([[entryId, nowMs - 5_000]]),
        });
        expect(collectHostText(await renderCard()).join(' ')).not.toContain('stale');
    });

    it('expands an agent row to show normalized summary detail when available', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: {
                state: 'loaded',
                runId: 'wf_1',
                snapshot: snapshot({
                    runId: 'wf_1',
                    title: 'Investigate',
                    totalAgents: 1,
                    phases: [],
                    agents: [{
                        id: 'agent-1',
                        title: 'researcher',
                        status: 'complete',
                        updatedAt: 1,
                        resultPreview: 'Short result',
                        summary: 'Full normalized result summary with the important findings.',
                    }],
                }),
            },
        });

        const tree = await renderCard();
        // Compact rows (U-18): the collapsed row shows the title + metadata only — no inline result
        // preview or summary dump. The detail body appears only on expand.
        expect(collectHostText(tree).join(' ')).not.toContain('Full normalized result summary');
        expect(tree.root.findAllByProps({ testID: 'workflow-card-agent-wf_1-agent-1-detail' })).toHaveLength(0);

        const agentRow = tree.root
            .findAllByProps({ testID: 'workflow-card-agent-wf_1-agent-1' })
            .find((node) => typeof node.props.onPress === 'function');
        await pressTestInstanceAsync(agentRow, 'workflow agent row');

        expect(collectHostText(tree).join(' ')).toContain('Full normalized result summary');
        expect(tree.root.findAllByProps({ testID: 'workflow-card-agent-wf_1-agent-1-detail' })).toHaveLength(1);
    });
});
