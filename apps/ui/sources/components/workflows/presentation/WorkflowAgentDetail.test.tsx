import React from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

import { installWorkflowRendererCommonModuleMocks } from '@/components/tools/renderers/workflow/workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks();

// Transform the real transcript modules once, outside individual assertion budgets.
let WorkflowAgentDetail: typeof import('./WorkflowAgentDetail')['WorkflowAgentDetail'];
let WorkflowAgentRow: typeof import('./WorkflowAgentRow')['WorkflowAgentRow'];
beforeAll(async () => {
    ({ WorkflowAgentDetail } = await import('./WorkflowAgentDetail'));
    ({ WorkflowAgentRow } = await import('./WorkflowAgentRow'));
}, 300_000);

function collectText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(collectText).join('');
    const record = value as { children?: unknown };
    return collectText(record.children);
}

async function render(text: string) {
    return (await renderScreen(<WorkflowAgentDetail text={text} detailTestID="detail" />)).tree;
}

describe('WorkflowAgentDetail', () => {
    it('keeps the long-detail disclosure outside the agent expansion button', async () => {
        const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
        const screen = await renderScreen(<WorkflowAgentRow title="Builder" status="complete" summary={text} testID="agent" />);
        await screen.pressByTestIdAsync('agent');
        expect(screen.tree.findHostByTestId('agent-detail-show-more')).toBeTruthy();
        expect(screen.tree.findHostByTestId('agent')!.findAllByProps({ testID: 'agent-detail-show-more' })).toHaveLength(0);
        await screen.pressByTestIdAsync('agent-detail-show-more');
        expect(collectText(screen.tree.findHostByTestId('agent-detail-body')!.props.children).split('\n')).toHaveLength(20);
        act(() => screen.tree.unmount());
    });

    it('pretty-prints JSON payloads instead of dumping the raw source', async () => {
        const tree = await render('{"status":"done","count":2}');
        const body = tree.findHostByTestId('detail-body')!;
        const rendered = collectText(body.props.children);
        expect(rendered).toContain('"status": "done"');
        expect(rendered).toContain('\n');
        act(() => tree.unmount());
    });

    it('clamps long bodies to a line budget and offers a Show more toggle', async () => {
        const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
        const tree = await render(long);
        const toggle = tree.findByTestId('detail-show-more')!;
        // Collapsed: only the first 6 lines are shown.
        expect(collectText(tree.findHostByTestId('detail-body')!.props.children).split('\n')).toHaveLength(6);
        act(() => toggle.props.onPress());
        // Expanded: full body.
        expect(collectText(tree.findHostByTestId('detail-body')!.props.children).split('\n')).toHaveLength(20);
        act(() => tree.unmount());
    });

    it('does not render a toggle for short bodies', async () => {
        const tree = await render('all done');
        expect(() => tree.root.findByProps({ testID: 'detail-show-more' })).toThrow();
        act(() => tree.unmount());
    });
});
