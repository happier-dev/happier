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
import { buildAgentActivityEntryId, type SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

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
    let Text!: React.ComponentType<{ testID?: string; children?: React.ReactNode }>;

    beforeAll(async () => {
        ({ SessionWorkflowRunPanel, areSessionWorkflowRunPanelPropsEqual } = await import('./SessionWorkflowRunPanel'));
        ({ Text } = await import('@/components/ui/text/Text'));
        // Same budget as the other composed suites in this corridor: a cold transform of the text
        // primitive's module graph can exceed a minute on a loaded machine, and a timeout here
        // skips every case in the file rather than failing one.
    }, 300_000);

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
        // A host body renderer is an input to what every agent row discloses, so a new one must
        // re-render: memoizing past it would leave expanded agents showing the previous roster's
        // transcript.
        expect(areSessionWorkflowRunPanelPropsEqual(
            { ...base, renderAgentBody: () => null },
            { ...base, renderAgentBody: () => null },
        )).toBe(false);
    });

    /**
     * RULING-17: the panel does not decide what an agent discloses — it ASKS, by agent-activity
     * entry id, and shows what it is handed.
     *
     * The id is the whole contract. A panel that asked by `agentId` (or by its own row key) would
     * get `null` for every agent from a host keyed on the protocol id, and the failure would be
     * silent: the rows would simply keep showing the provider's summary and no transcript would ever
     * be reachable from a run panel — which is the defect this wave exists to fix.
     */
    it('asks the host for each agent body by entry id, and prefers it to the provider summary', async () => {
        const snap = snapshot({
            runId: 'a',
            title: 'Build',
            totalAgents: 2,
            completedAgents: 0,
            agents: [
                { id: 'x', title: 'Reviewer', status: 'active', updatedAt: 1, summary: 'REVIEWER SUMMARY' },
                { id: 'y', title: 'Planner', status: 'active', updatedAt: 1, summary: 'PLANNER SUMMARY' },
            ],
        });
        const reviewerEntryId = buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'a', agentId: 'x' });
        const plannerEntryId = buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'a', agentId: 'y' });
        const asked: string[] = [];

        const screen = await renderScreen(React.createElement(SessionWorkflowRunPanel, {
            runId: 'a',
            entryTitle: 'Build',
            entryStatus: 'running',
            runHeadline: null,
            snapshot: snap,
            detailState: 'loaded',
            defaultExpanded: true,
            renderAgentBody: (entryId: string) => {
                asked.push(entryId);
                // Only the reviewer has a transcript; the planner's row must keep its summary.
                return entryId === reviewerEntryId
                    ? React.createElement(Text, { testID: 'host-body-x' }, 'HOST TRANSCRIPT')
                    : null;
            },
        }));

        expect(asked).toContain(reviewerEntryId);
        expect(asked).toContain(plannerEntryId);

        await screen.pressByTestIdAsync('workflow-agent-a-x');
        expect(screen.findByTestId('host-body-x')).toBeTruthy();
        expect(screen.getTextContent()).toContain('HOST TRANSCRIPT');
        // The host body REPLACES the summary rather than stacking a second card under one row.
        expect(screen.getTextContent()).not.toContain('REVIEWER SUMMARY');

        await screen.pressByTestIdAsync('workflow-agent-a-y');
        expect(screen.getTextContent()).toContain('PLANNER SUMMARY');
        await screen.unmount();
    });
});
