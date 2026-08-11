import React from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import type renderer from 'react-test-renderer';

import {
    collectHostText,
    makeSessionWorkflowRunHeadline,
    makeSessionWorkflowRunSnapshot,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from '@/components/tools/renderers/workflow/workflowRendererTestHelpers';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import type { SessionWorkflowRunPanelProps } from './SessionWorkflowRunPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The run panel, now fed by the unified entry plus producer detail (r4.1).
 *
 * These cases were previously owned by `SessionWorkflowActivitySection`, which read the workflow
 * headline directly and no longer exists. They move here rather than dying with it: the panel is
 * where phases, skeletons, the no-detail line and the progressive window actually live, and it is
 * now shared by BOTH surfaces, so losing this coverage would leave the compact and expanded views
 * equally unguarded.
 */

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

function snapshot(over: Partial<SessionWorkflowRunSnapshotV1> & { runId: string }): SessionWorkflowRunSnapshotV1 {
    return makeSessionWorkflowRunSnapshot(over);
}

function largeSnapshot(runId: string, count: number): SessionWorkflowRunSnapshotV1 {
    return snapshot({
        runId,
        title: 'Large workflow',
        totalAgents: count,
        completedAgents: 12,
        phases: [{ id: 'phase-1', title: 'Implementation', order: 1, agentIds: Array.from({ length: count }, (_unused, index) => `agent-${index}`) }],
        agents: Array.from({ length: count }, (_unused, index) => ({
            id: `agent-${index}`,
            title: `Agent ${index}`,
            status: index < 12 ? 'complete' : index === 12 ? 'active' : 'pending',
            updatedAt: index,
            resultPreview: `Result ${index}`,
        })),
    });
}

describe('SessionWorkflowRunPanel', () => {
    let SessionWorkflowRunPanel!: React.ComponentType<SessionWorkflowRunPanelProps>;
    let areSessionWorkflowRunPanelPropsEqual!: typeof import('./SessionWorkflowRunPanel').areSessionWorkflowRunPanelPropsEqual;

    beforeAll(async () => {
        ({ SessionWorkflowRunPanel, areSessionWorkflowRunPanelPropsEqual } = await import('./SessionWorkflowRunPanel'));
    }, 60_000);

    async function render(props: Partial<SessionWorkflowRunPanelProps> & Pick<SessionWorkflowRunPanelProps, 'runId'>): Promise<renderer.ReactTestRenderer> {
        return (await renderScreen(React.createElement(SessionWorkflowRunPanel, {
            entryTitle: props.entryTitle ?? 'Untitled run',
            entryStatus: props.entryStatus ?? 'running',
            runHeadline: props.runHeadline ?? null,
            snapshot: props.snapshot ?? null,
            detailState: props.detailState ?? 'loading',
            defaultExpanded: props.defaultExpanded ?? true,
            ...props,
        }))).tree;
    }

    it('renders the phases of a loaded run, and collapses and re-expands them in place', async () => {
        const snap = snapshot({
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
        const tree = await render({
            runId: 'a',
            entryTitle: 'Build',
            runHeadline: headlineRun({ runId: 'a', title: 'Build', totalAgents: 2, completedAgents: 1 }),
            snapshot: snap,
            detailState: 'loaded',
        });

        const text = collectHostText(tree);
        expect(text).toContain('Build');
        expect(text).toContain('Research');
        expect(text).toContain('Implementation');

        const toggle = tree.root.findByProps({ testID: 'workflow-run-panel-toggle-a' });
        await pressTestInstanceAsync(toggle, 'collapse workflow run');
        const collapsed = collectHostText(tree);
        expect(collapsed).toContain('Build');
        expect(collapsed).not.toContain('Research');

        await pressTestInstanceAsync(toggle, 'expand workflow run');
        expect(collectHostText(tree)).toContain('Research');
    });

    /**
     * The r4.1 seam, stated as a contract: before the durable record lands the panel still names the
     * run — from the unified entry — and it claims no fraction it does not have. A `0/0` meter would
     * be a lie invented by the migration itself.
     */
    it('names a run from the unified entry alone, and claims no fraction it has not been given', async () => {
        const tree = await render({
            runId: 'a',
            entryTitle: 'Pending detail',
            entryStatus: 'running',
            detailState: 'loading',
        });

        const text = collectHostText(tree);
        expect(text).toContain('Pending detail');
        expect(text.join(' ')).not.toContain('agentFraction');

        const skeleton = tree.root.findByProps({ testID: 'workflow-run-panel-skeleton-a' });
        expect(skeleton).toBeTruthy();
        // U-14: the label is on the accessibility layer so the reserved rows do not reflow.
        expect(skeleton?.props.accessibilityLabel).toContain('loading');
    });

    it('renders a graceful no-detail line (not an empty shell) for a loaded run with no rows', async () => {
        const snap = snapshot({ runId: 'a', title: 'Research', status: 'complete', totalAgents: 0, phases: [], agents: [] });
        const tree = await render({
            runId: 'a',
            entryTitle: 'Research',
            snapshot: snap,
            detailState: 'loaded',
        });

        const text = collectHostText(tree);
        expect(text).toContain('Research');
        expect(text).toContain('noDetail');
        expect(text).not.toContain('loading');
        expect(text).not.toContain('unavailable');
    });

    it('says so when the durable record will never arrive', async () => {
        const tree = await render({ runId: 'a', entryTitle: 'Gone', detailState: 'missing' });
        expect(collectHostText(tree)).toContain('unavailable');
    });

    it('keeps a 300-agent run bounded through progressive row windows', async () => {
        const snap = largeSnapshot('large', 300);
        const tree = await render({
            runId: 'large',
            entryTitle: 'Large workflow',
            runHeadline: headlineRun({ runId: 'large', title: 'Large workflow', totalAgents: 300, completedAgents: 12 }),
            snapshot: snap,
            detailState: 'loaded',
        });

        expect(collectHostText(tree)).toContain('Agent 22');
        expect(collectHostText(tree)).not.toContain('Agent 299');

        const showMore = tree.root.findByProps({ testID: 'workflow-run-large-show-more' });
        await pressTestInstanceAsync(showMore, 'workflow show more');
        expect(collectHostText(tree)).toContain('Agent 46');

        for (let i = 0; i < 20; i += 1) {
            const current = tree.root.findAllByProps({ testID: 'workflow-run-large-show-more' })[0];
            if (!current) break;
            await pressTestInstanceAsync(current, `workflow show more ${i}`);
        }

        expect(collectHostText(tree)).toContain('Agent 299');
        expect(tree.root.findAllByProps({ testID: 'workflow-run-large-show-more' })).toHaveLength(0);
    });

    it('stays memoized when a parent rebuilds the same values, and re-renders when one changes', async () => {
        const runA = headlineRun({ runId: 'a', title: 'Build', totalAgents: 2, completedAgents: 1 });
        const snapA = snapshot({ runId: 'a', totalAgents: 2, completedAgents: 1 });
        const base: SessionWorkflowRunPanelProps = {
            runId: 'a',
            entryTitle: 'Build',
            entryStatus: 'running',
            runHeadline: runA,
            snapshot: snapA,
            detailState: 'loaded',
            defaultExpanded: true,
        };

        expect(areSessionWorkflowRunPanelPropsEqual(base, { ...base })).toBe(true);
        // The unified entry's status is an input now, so a status change must re-render the header.
        expect(areSessionWorkflowRunPanelPropsEqual(base, { ...base, entryStatus: 'succeeded' })).toBe(false);
        expect(areSessionWorkflowRunPanelPropsEqual(base, { ...base, runHeadline: { ...runA, completedAgents: 2 } })).toBe(false);
    });
});
