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

    it('keeps nested +N tool navigation disabled when the canonical interaction denies it', async () => {
        const messages = Array.from({ length: 5 }, (_, index) => ({
            kind: 'tool-call',
            id: `message-${index}`,
            localId: null,
            createdAt: index + 2,
            tool: {
                id: `tool-${index}`,
                name: 'Read',
                state: 'completed',
                input: { file_path: `/file-${index}.txt` },
                result: 'ok',
                createdAt: index + 2,
                startedAt: index + 2,
                completedAt: index + 2,
            },
        }));

        const screen = await renderScreen(<SubAgentRunView
            tool={{
                id: 'subagent-run',
                name: 'SubAgentRun',
                state: 'running',
                input: { intent: 'delegate' },
                result: null,
            } as any}
            metadata={null as any}
            messages={messages as any}
            sessionId="public-session"
            messageId="parent-message"
            detailLevel="summary"
            interaction={{
                canSendMessages: false,
                canApprovePermissions: false,
                permissionDisabledReason: 'public',
                disableToolNavigation: true,
            }}
        />);

        const moreToolsRow = screen.findByTestId('task-like-summary-more-tools');
        expect(moreToolsRow).toBeTruthy();
        expect(moreToolsRow?.props.onPress).toBeUndefined();
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

    it('renders sidechain text messages when an interrupted call settled as completed', async () => {
        // Same shape as the error case above, only the lifecycle state differs — which is an
        // accident of when the interrupt landed. The status owner reads both as ambiguous, so the
        // renderer must not show one of them as a finished run while the sidechain still streams.
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
                    tool={{
                        state: 'completed',
                        input: { intent: 'delegate' },
                        result: { error: 'Request interrupted' },
                    } as any}
                    metadata={null as any}
                    messages={[
                        { kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'TICK 4', isThinking: false },
                    ] as any}
                    detailLevel="full"
                />)).tree;

        const text = collectHostText(tree).join('\n');
        expect(text).toContain('TICK 4');
        expect(structuredResultViewPropsSpy).not.toHaveBeenCalled();
    });

    it('still renders a reported outcome that carries an interruption marker beside it', async () => {
        // The execution-run manager reported `succeeded`, so the run is terminal however torn down
        // the parent call was. Deferring to the status owner is what keeps this from becoming a
        // second, drifting copy of that precedence rule.
        await renderScreen(<SubAgentRunView
            tool={{
                state: 'completed',
                input: { intent: 'delegate' },
                result: { status: 'succeeded', summary: 'Delegated output.', error: 'Request interrupted' },
            } as any}
            metadata={null as any}
            messages={[
                { kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'TICK 5', isThinking: false },
            ] as any}
            detailLevel="full"
        />);

        expect(structuredResultViewPropsSpy).toHaveBeenCalled();
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
