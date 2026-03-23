import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { collectHostText } from '@/dev/testkit';
import {
    installWorkflowRendererCommonModuleMocks,
    resetWorkflowRendererCommonModuleMockState,
} from './workflowRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const structuredResultViewPropsSpy = vi.fn();

installWorkflowRendererCommonModuleMocks();
resetWorkflowRendererCommonModuleMockState();

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: (props: any) => {
        structuredResultViewPropsSpy(props);
        return React.createElement('StructuredResultView');
    },
}));

describe('SubAgentRunView', () => {
    let SubAgentRunView: any;

    beforeAll(async () => {
        ({ SubAgentRunView } = await import('./SubAgentRunView'));
    }, 120_000);

    beforeEach(() => {
        structuredResultViewPropsSpy.mockReset();
    });

    it('renders sidechain text messages while running (detailLevel=full)', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
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
                />)).tree;

        const text = collectHostText(tree).join('\n');
        expect(text).toContain('Working...');
    });

    it('renders sidechain text messages for abort-like Request interrupted errors', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
                    tool={{
                        state: 'error',
                        input: { intent: 'delegate' },
                        result: { error: 'Request interrupted' },
                    } as any}
                    metadata={null as any}
                    messages={[
                        { kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'TICK 3', isThinking: false },
                    ] as any}
                    detailLevel="full"
                />)).tree;

        const text = collectHostText(tree).join('\n');
        expect(text).toContain('TICK 3');
    });

    it('renders a review digest from findingsDigest v2 shape', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
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
                />)).tree;

        const text = collectHostText(tree).join('\n');
        expect(text).toContain('tools.subAgentRunView.reviewDigestTitle');
        expect(text).toContain('Avoid any');
    });

    it('renders a plan summary when intent is plan', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
                    tool={{
                        state: 'completed',
                        input: { intent: 'plan' },
                        result: { summary: 'Do A then B.' },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />)).tree;

        const text = collectHostText(tree).join('\\n');
        expect(text).toContain('tools.subAgentRunView.planTitle');
        expect(text).toContain('Do A then B.');
    });

    it('renders a delegate summary when intent is delegate', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
                    tool={{
                        state: 'completed',
                        input: { intent: 'delegate' },
                        result: { summary: 'Delegated output.' },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />)).tree;

        const text = collectHostText(tree).join('\\n');
        expect(text).toContain('tools.subAgentRunView.delegateTitle');
        expect(text).toContain('Delegated output.');
    });

    it('renders structured fallback for error state when result payload exists', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
                    tool={{
                        state: 'error',
                        input: { intent: 'delegate' },
                        result: { summary: 'Timed out', status: 'failed', error: { code: 'execution_run_failed' } },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />)).tree;

        expect(structuredResultViewPropsSpy).toHaveBeenCalledTimes(1);
    });

    it('coerces error tool state to completed for structured timeout fallback', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
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
                />)).tree;

        expect(structuredResultViewPropsSpy).toHaveBeenCalledTimes(1);
        const firstCall = structuredResultViewPropsSpy.mock.calls[0]?.[0];
        expect(firstCall?.tool?.state).toBe('completed');
    });
});
