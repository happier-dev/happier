import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (fn: any) => fn({ colors: { surfaceHigh: '#222', textSecondary: '#aaa', text: '#eee' } }) },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => React.createElement('StructuredResultView'),
}));

describe('SubAgentRunView', () => {
    it('renders a review digest from findingsDigest v2 shape', async () => {
        const { SubAgentRunView } = await import('./SubAgentRunView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <SubAgentRunView
                    tool={{
                        state: 'completed',
                        result: {
                            findingsDigest: {
                                total: 1,
                                items: [
                                    { id: 'f1', title: 'Avoid any', severity: 'high', category: 'types' },
                                ],
                            },
                        },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />,
            );
        });

        const text = tree.root.findAllByType('Text').map((n: any) => String(n.props.children)).join('\n');
        expect(text).toContain('Review digest');
        expect(text).toContain('Avoid any');
    });

    it('renders a plan summary when intent is plan', async () => {
        const { SubAgentRunView } = await import('./SubAgentRunView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <SubAgentRunView
                    tool={{
                        state: 'completed',
                        input: { intent: 'plan' },
                        result: { summary: 'Do A then B.' },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />,
            );
        });

        const text = tree.root.findAllByType('Text').map((n: any) => String(n.props.children)).join('\\n');
        expect(text).toContain('Plan');
        expect(text).toContain('Do A then B.');
    });

    it('renders a delegate summary when intent is delegate', async () => {
        const { SubAgentRunView } = await import('./SubAgentRunView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <SubAgentRunView
                    tool={{
                        state: 'completed',
                        input: { intent: 'delegate' },
                        result: { summary: 'Delegated output.' },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />,
            );
        });

        const text = tree.root.findAllByType('Text').map((n: any) => String(n.props.children)).join('\\n');
        expect(text).toContain('Delegate');
        expect(text).toContain('Delegated output.');
    });
});
