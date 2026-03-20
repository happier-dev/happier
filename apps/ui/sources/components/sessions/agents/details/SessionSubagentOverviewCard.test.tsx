import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) =>
            typeof styles === 'function'
                ? styles({
                    colors: {
                        surface: '#111',
                        surfaceHigh: '#222',
                        divider: '#333',
                        text: '#eee',
                        textSecondary: '#aaa',
                    },
                })
                : styles,
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/text', () => ({
    t: (key: string, values?: Record<string, unknown>) => {
        if (key === 'session.subagents.kind.execution_run') return 'Subagent';
        if (key === 'session.subagents.intent.review') return 'Review';
        if (key === 'session.subagents.panel.typeFact' && values?.value) return `Type: ${values.value}`;
        if (key === 'session.subagents.panel.backendFact' && values?.value) return `Backend: ${values.value}`;
        if (key === 'session.subagents.panel.intentFact' && values?.value) return `Intent: ${values.value}`;
        return key;
    },
}));

describe('SessionSubagentOverviewCard', () => {
    it('renders the shared compact fact pills for execution runs', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        const subagent: SessionSubagent = {
            id: 'execution_run:run_1',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'run_1' },
            transcript: { toolMessageRouteId: 'tool:toolu_1', toolId: 'toolu_1', sidechainId: 'toolu_1' },
            runRef: { runId: 'run_1', backendId: 'codex', intent: 'review', runClass: 'long_lived' },
            recipient: { kind: 'execution_run', runId: 'run_1', label: 'run_1' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionSubagentOverviewCard subagent={subagent} />);
        });
        expect(tree).toBeTruthy();
        const textContent = tree!.root.findAllByType('Text').map((node: renderer.ReactTestInstance) => String(node.props.children)).join(' ');

        expect(textContent).toContain('Type: Subagent');
        expect(textContent).toContain('Backend: codex');
        expect(textContent).toContain('Intent: Review');
    });
});
