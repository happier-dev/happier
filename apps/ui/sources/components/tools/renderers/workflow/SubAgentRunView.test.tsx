import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const structuredResultViewPropsSpy = vi.fn();

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: (props: any) => {
        structuredResultViewPropsSpy(props);
        return React.createElement('StructuredResultView');
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SubAgentRunView', () => {
    beforeEach(() => {
        structuredResultViewPropsSpy.mockReset();
    });

    it('renders sidechain text messages while running (detailLevel=full)', async () => {
        const { SubAgentRunView } = await import('./SubAgentRunView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <SubAgentRunView
                    tool={{
                        state: 'running',
                        input: { intent: 'plan' },
                        result: null,
                    } as any}
                    metadata={null as any}
                    messages={[
                        { kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'Working...', isThinking: false },
                    ] as any}
                    detailLevel="full"
                />,
            );
        });

        const text = tree.root.findAllByType('Text').map((n: any) => String(n.props.children)).join('\n');
        expect(text).toContain('Working...');
    });

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
        expect(text).toContain('tools.subAgentRunView.reviewDigestTitle');
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
        expect(text).toContain('tools.subAgentRunView.planTitle');
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
        expect(text).toContain('tools.subAgentRunView.delegateTitle');
        expect(text).toContain('Delegated output.');
    });

    it('renders structured fallback for error state when result payload exists', async () => {
        const { SubAgentRunView } = await import('./SubAgentRunView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <SubAgentRunView
                    tool={{
                        state: 'error',
                        input: { intent: 'delegate' },
                        result: { summary: 'Timed out', status: 'failed', error: { code: 'execution_run_failed' } },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />,
            );
        });

        expect(tree.root.findAllByType('StructuredResultView' as any)).toHaveLength(1);
    });

    it('coerces error tool state to completed for structured timeout fallback', async () => {
        const { SubAgentRunView } = await import('./SubAgentRunView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <SubAgentRunView
                    tool={{
                        state: 'error',
                        input: { intent: 'delegate' },
                        result: {
                            status: 'timeout',
                            summary: 'Timed out after 120000ms',
                            error: { code: 'execution_run_timeout', message: 'Timed out after 120000ms' },
                        },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />,
            );
        });

        expect(tree.root.findAllByType('StructuredResultView' as any)).toHaveLength(1);
        const firstCall = structuredResultViewPropsSpy.mock.calls[0]?.[0];
        expect(firstCall?.tool?.state).toBe('completed');
    });
});
