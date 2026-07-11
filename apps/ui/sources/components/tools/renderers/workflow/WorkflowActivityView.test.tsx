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
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

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
vi.mock('@/components/sessions/workState/useSessionWorkflowActivity', () => ({
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

    it('labels a crash-reconciled stopped run as interrupted', async () => {
        useWorkflowRunForToolUseId.mockReturnValue({
            runHeadline: null,
            detail: {
                state: 'loaded',
                runId: 'wf_1',
                snapshot: snapshot({
                    title: 'Interrupted workflow',
                    status: 'stopped',
                    statusReason: 'interrupted',
                    totalAgents: 3,
                    completedAgents: 1,
                }),
            },
        });

        const tree = await renderCard();
        const text = collectHostText(tree);
        expect(text).toContain('statusInterrupted');
        expect(text).not.toContain('statusStopped');
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
        expect(collectHostText(tree)).toContain('Short result');
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
