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
    it.each(['text', 'json'] as const)('expands the complete normalized %s value beyond the collapsed preview', async (kind) => {
        const value = `${'Long summary '.repeat(500)}\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\nEND_OF_SUMMARY`;
        const raw = kind === 'json' ? JSON.stringify({ summary: value }) : value;
        const full = kind === 'json' ? JSON.stringify(JSON.parse(raw), null, 2) : raw;
        const screen = await renderScreen(<WorkflowAgentDetail text={raw} detailTestID="detail" />);
        const body = () => collectText(screen.tree.findHostByTestId('detail-body')!.props.children);
        if (kind === 'text') expect(body()).not.toContain('END_OF_SUMMARY');
        // A JSON string's escaped newlines wrap visually; the platform reports that height.
        await act(async () => screen.tree.findHostByTestId('detail-body')!.props.onLayout?.({
            nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 800 } },
        }));
        expect(screen.findByTestId('detail-show-more')).not.toBeNull();
        await screen.pressByTestIdAsync('detail-show-more');
        expect(body()).toBe(full);
        await screen.pressByTestIdAsync('detail-show-more');
        if (kind === 'text') expect(body()).not.toContain('END_OF_SUMMARY');
        act(() => screen.tree.unmount());
    });
    it('offers full inspection when one long line wraps beyond the preview viewport', async () => {
        const text = `${'Long summary '.repeat(500)}END_OF_SUMMARY`;
        const screen = await renderScreen(<WorkflowAgentDetail text={text} detailTestID="detail" />);
        const body = () => screen.tree.findHostByTestId('detail-body')!;
        // Native/web text layout is a platform boundary; report its wrapped height.
        await act(async () => body().props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 800 } } }));
        expect(screen.findByTestId('detail-show-more')).not.toBeNull();
        await screen.pressByTestIdAsync('detail-show-more');
        expect(collectText(body().props.children)).toBe(text);
        act(() => screen.tree.unmount());
    });
});
