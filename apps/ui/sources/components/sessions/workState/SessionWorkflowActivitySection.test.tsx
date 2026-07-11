import React from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import renderer from 'react-test-renderer';

import {
    collectHostText,
    makeSessionWorkflowRunHeadline,
    makeSessionWorkflowRunSnapshot,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from '@/components/tools/renderers/workflow/workflowRendererTestHelpers';
import {
    type SessionWorkflowRunHeadlineV1,
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import type { SessionWorkflowActivityState } from './useSessionWorkflowActivity';
import type { WorkflowRunDetailState } from './sessionWorkflowActivityTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                const last = key.split('.').pop() ?? key;
                if (params && Object.keys(params).length > 0) return `${last}:${Object.values(params).join(',')}`;
                return last;
            },
        });
    },
});

const headlineRun = makeSessionWorkflowRunHeadline;

function loaded(snapshot: SessionWorkflowRunSnapshotV1): WorkflowRunDetailState {
    return { state: 'loaded', runId: snapshot.runId, snapshot };
}

function snapshot(over: Partial<SessionWorkflowRunSnapshotV1> & { runId: string }): SessionWorkflowRunSnapshotV1 {
    return makeSessionWorkflowRunSnapshot(over);
}

function largeSnapshot(runId: string, count: number): SessionWorkflowRunSnapshotV1 {
    return snapshot({
        runId,
        title: 'Large workflow',
        totalAgents: count,
        completedAgents: 12,
        phases: [{ id: 'phase-1', title: 'Implementation', order: 1, agentIds: Array.from({ length: count }, (_, index) => `agent-${index}`) }],
        agents: Array.from({ length: count }, (_, index) => ({
            id: `agent-${index}`,
            title: `Agent ${index}`,
            status: index < 12 ? 'complete' : index === 12 ? 'active' : 'pending',
            updatedAt: index,
            resultPreview: `Result ${index}`,
        })),
    });
}

function activityState(over: Partial<SessionWorkflowActivityState>): SessionWorkflowActivityState {
    return {
        headline: over.headline ?? null,
        activeRuns: over.activeRuns ?? [],
        runDetailById: over.runDetailById ?? new Map(),
        loadedRunsById: over.loadedRunsById ?? new Map(),
    };
}

describe('SessionWorkflowActivitySection', () => {
    let SessionWorkflowActivitySection!: React.ComponentType<{ activity: SessionWorkflowActivityState }>;
    let areSessionWorkflowRunPanelPropsEqual: undefined | ((
        prev: {
            runHeadline: SessionWorkflowRunHeadlineV1;
            snapshot: SessionWorkflowRunSnapshotV1 | null;
            detailState: 'loading' | 'loaded' | 'missing';
            defaultExpanded: boolean;
        },
        next: {
            runHeadline: SessionWorkflowRunHeadlineV1;
            snapshot: SessionWorkflowRunSnapshotV1 | null;
            detailState: 'loading' | 'loaded' | 'missing';
            defaultExpanded: boolean;
        },
    ) => boolean);

    beforeAll(async () => {
        const module = await import('./SessionWorkflowActivitySection');
        ({ SessionWorkflowActivitySection } = module);
        areSessionWorkflowRunPanelPropsEqual = Reflect.get(module, 'areSessionWorkflowRunPanelPropsEqual') as typeof areSessionWorkflowRunPanelPropsEqual;
    }, 60_000);

    async function render(activity: SessionWorkflowActivityState): Promise<renderer.ReactTestRenderer> {
        return (await renderScreen(React.createElement(SessionWorkflowActivitySection, { activity }))).tree;
    }

    it('renders nothing when there are no active runs', async () => {
        const tree = await render(activityState({}));
        expect(tree.toJSON()).toBeNull();
    });

    it('renders two active run panels with the section title (primary + secondary visible)', async () => {
        const runA = headlineRun({ runId: 'a', title: 'Build', totalAgents: 2, completedAgents: 1 });
        const runB = headlineRun({ runId: 'b', title: 'Review', totalAgents: 3, completedAgents: 0 });
        const snapA = snapshot({
            runId: 'a',
            title: 'Build',
            totalAgents: 2,
            completedAgents: 1,
            phases: [
                { id: 'p1', title: 'Research', order: 1, agentIds: ['x'] },
                { id: 'p2', title: 'Implementation', order: 2, agentIds: ['y'] },
            ],
            agents: [
                { id: 'x', title: 'web_search', status: 'complete', updatedAt: 1 },
                { id: 'y', title: 'editor', status: 'active', updatedAt: 1 },
            ],
        });
        const tree = await render(activityState({
            headline: {
                v: 1,
                backendId: 'claude',
                updatedAt: 1,
                primaryRunId: 'a',
                activeRuns: [runA, runB],
            },
            activeRuns: [runA, runB],
            runDetailById: new Map([
                ['a', loaded(snapA)],
                ['b', loaded(snapshot({ runId: 'b', title: 'Review', totalAgents: 3 }))],
            ]),
            loadedRunsById: new Map([['a', snapA]]),
        }));
        const text = collectHostText(tree);
        expect(text).toContain('sectionTitle');
        // Both run titles visible (secondary panel header shown even when collapsed).
        expect(text).toContain('Build');
        expect(text).toContain('Review');
        // Primary run (a) expanded by default → its phases render.
        expect(text).toContain('Research');
        expect(text).toContain('Implementation');

        const toggle = tree.root.findByProps({ testID: 'workflow-run-panel-toggle-a' });
        await pressTestInstanceAsync(toggle, 'collapse primary workflow run');
        const collapsedText = collectHostText(tree);
        expect(collapsedText).toContain('Build');
        expect(collapsedText).toContain('Review');
        expect(collapsedText).not.toContain('Research');
        expect(collapsedText).not.toContain('Implementation');

        await pressTestInstanceAsync(toggle, 'expand primary workflow run');
        const expandedText = collectHostText(tree);
        expect(expandedText).toContain('Research');
        expect(expandedText).toContain('Implementation');
    });

    it('renders a graceful no-detail line (not an empty shell) for a loaded run with no phases/agents', async () => {
        const runA = headlineRun({ runId: 'a', title: 'Research', status: 'complete', totalAgents: 0, completedAgents: 0 });
        const snapA = snapshot({ runId: 'a', title: 'Research', status: 'complete', totalAgents: 0, phases: [], agents: [] });
        const tree = await render(activityState({
            headline: { v: 1, backendId: 'claude', updatedAt: 1, primaryRunId: 'a', activeRuns: [runA] },
            activeRuns: [runA],
            runDetailById: new Map([['a', loaded(snapA)]]),
            loadedRunsById: new Map([['a', snapA]]),
        }));
        const text = collectHostText(tree);
        expect(text).toContain('Research');
        // The run still has a visible status; the expanded body shows a no-detail line, not nothing.
        expect(text).toContain('noDetail');
        // It must NOT show the loading/unavailable skeletons (the record loaded fine; it simply has no rows).
        expect(text).not.toContain('loading');
        expect(text).not.toContain('unavailable');
    });

    it('renders a skeleton for an active run whose record has not loaded', async () => {
        const runA = headlineRun({ runId: 'a', title: 'Pending detail', totalAgents: 2 });
        const tree = await render(activityState({
            headline: { v: 1, backendId: 'claude', updatedAt: 1, primaryRunId: 'a', activeRuns: [runA] },
            activeRuns: [runA],
            runDetailById: new Map([['a', { state: 'loading', runId: 'a' }]]),
            loadedRunsById: new Map(),
        }));
        const text = collectHostText(tree);
        expect(text).toContain('Pending detail');
        expect(text).toContain('loading');
    });

    it('keeps a 300-agent run bounded through progressive row windows', async () => {
        const runA = headlineRun({ runId: 'large', title: 'Large workflow', totalAgents: 300, completedAgents: 12 });
        const snapA = largeSnapshot('large', 300);
        const tree = await render(activityState({
            headline: { v: 1, backendId: 'claude', updatedAt: 1, primaryRunId: 'large', activeRuns: [runA] },
            activeRuns: [runA],
            runDetailById: new Map([['large', loaded(snapA)]]),
            loadedRunsById: new Map([['large', snapA]]),
        }));

        expect(collectHostText(tree)).toContain('Agent 22');
        expect(collectHostText(tree)).not.toContain('Agent 299');

        const showMore = tree.root.findByProps({ testID: 'workflow-run-large-show-more' });
        await pressTestInstanceAsync(showMore, 'workflow show more');

        const afterPress = collectHostText(tree);
        expect(afterPress).toContain('Agent 46');
        expect(afterPress).not.toContain('Agent 299');
        expect(afterPress.join(' ')).toContain('showMore');

        for (let i = 0; i < 20; i += 1) {
            const currentShowMore = tree.root.findAllByProps({ testID: 'workflow-run-large-show-more' })[0];
            if (!currentShowMore) break;
            await pressTestInstanceAsync(currentShowMore, `workflow show more ${i}`);
        }

        const afterManyPresses = collectHostText(tree);
        expect(afterManyPresses).toContain('Agent 299');
        expect(tree.root.findAllByProps({ testID: 'workflow-run-large-show-more' })).toHaveLength(0);
    });

    it('keeps a run panel memoized when unrelated parents rebuild the same headline values', async () => {
        const runA = headlineRun({ runId: 'a', title: 'Build', totalAgents: 2, completedAgents: 1 });
        const sameValues = { ...runA };
        const snapA = snapshot({ runId: 'a', totalAgents: 2, completedAgents: 1 });

        expect(typeof areSessionWorkflowRunPanelPropsEqual).toBe('function');
        expect(areSessionWorkflowRunPanelPropsEqual?.(
            { runHeadline: runA, snapshot: snapA, detailState: 'loaded', defaultExpanded: true },
            { runHeadline: sameValues, snapshot: snapA, detailState: 'loaded', defaultExpanded: true },
        )).toBe(true);
        expect(areSessionWorkflowRunPanelPropsEqual?.(
            { runHeadline: runA, snapshot: snapA, detailState: 'loaded', defaultExpanded: true },
            { runHeadline: { ...runA, completedAgents: 2 }, snapshot: snapA, detailState: 'loaded', defaultExpanded: true },
        )).toBe(false);
    });
});
