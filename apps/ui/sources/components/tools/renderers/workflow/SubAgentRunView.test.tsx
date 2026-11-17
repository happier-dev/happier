import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithSessionTranscriptSource, createTestSessionTranscriptSource } from '@/dev/testkit';
import { collectHostText } from '@/dev/testkit';
import type { Message, ToolCall } from '@happier-dev/session-core/messages';


function renderScreen(element: React.ReactElement<React.ComponentProps<typeof import('./SubAgentRunView')['SubAgentRunView']>>) {
    return renderWithSessionTranscriptSource(element, createTestSessionTranscriptSource({
        sessionId: element.props.sessionId ?? 's1', messages: element.props.messages,
        metadata: element.props.metadata, navigate: null,
    }));
}

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
}));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

describe('SubAgentRunView', () => {
    let SubAgentRunView: any;

    beforeAll(async () => {
        ({ SubAgentRunView } = await import('./SubAgentRunView'));
    }, 120_000);

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

    it('uses the Run visibility projection for parent previews and Find text', async () => {
        const tool: ToolCall = { name: 'SubAgentRun', state: 'running', input: { runId: 'run_7425823b-704c-445f-aa46-a2ceb57bcfa1' },
            result: null, createdAt: 1, startedAt: 1, completedAt: null, description: null };
        const host: Message = { kind: 'user-text', id: 'host', realID: 'cmvlva2g0007mmcdtsorblbuf',
            localId: '96fbe1db-c2de-4d0f-a564-e1076982ef2b', createdAt: 1792814190028, seq: 14,
            text: '[host startup context]', meta: {
                happierProvenanceV1: { v: 1, kind: 'host', producer: 'happierApp' },
                happierInputAuthorityV1: { v: 1, producer: 'happierApp', caller: { kind: 'host' }, permission: { admittedPermissionCeiling: 'default' } },
            } };
        const question: Message = { kind: 'user-text', id: 'question', realID: 'cmvlvcymq007ymcdtu4qqa7xj',
            localId: '9e38ea44-a338-4e25-bc57-cef1250b0856', createdAt: 1792814325035, seq: 16,
            text: '[expanded question context]', displayText: '[person question]' };
        const screen = await renderScreen(<SubAgentRunView tool={tool} metadata={null} messages={[host, question]} detailLevel="full" />);
        expect(screen.getTextContent()).toContain(question.displayText);
        expect(screen.getTextContent()).not.toContain(question.text);
        expect(screen.getTextContent()).not.toContain(host.text);
        const { projectSubAgentRunDisplayText } = await import('./SubAgentRunView');
        const findText = projectSubAgentRunDisplayText(tool, null, { messages: [host, question] }).map(block => block.text).join('\n');
        expect(findText).toContain(question.displayText);
        expect(findText).not.toContain(question.text);
        expect(findText).not.toContain(host.text);
    });

    it('keeps nested +N tool navigation inert when the source withholds navigation', async () => {
        const messages = Array.from({ length: 5 }, (_, index) => ({
            kind: 'tool-call',
            id: `message-${index}`,
            localId: null,
            createdAt: index + 2,
            children: [],
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
        expect(text).not.toContain('Request interrupted');
    });

    it('still renders a reported outcome that carries an interruption marker beside it', async () => {
        // The execution-run manager reported `succeeded`, so the run is terminal however torn down
        // the parent call was. Deferring to the status owner is what keeps this from becoming a
        // second, drifting copy of that precedence rule.
        const screen = await renderScreen(<SubAgentRunView
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

        expect(screen.getTextContent()).toContain('Delegated output.');
        expect(screen.getTextContent()).not.toContain('TICK 5');
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

    it('says a failed Run with an untranslated code in the Run\'s words', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SubAgentRunView
                    tool={{
                        state: 'error',
                        input: { intent: 'delegate' },
                        result: { summary: 'Timed out', status: 'failed', error: { code: 'execution_run_failed', message: 'Execution failed while reviewing' } },
                    } as any}
                    metadata={null as any}
                    messages={[] as any}
                />)).tree;

        // A failed Run says its cause in the Run's words; the executor's raw text is not the page.
        expect(collectHostText(tree).join(' ')).toContain('errors.errorWithCode');
        expect(collectHostText(tree).join(' ')).not.toContain('Execution failed while reviewing');
    });

    it('never shows a failed Run\'s raw SDK text or a local path', async () => {
        const raw = 'Claude Agent SDK process exited before emitting a result (exitCode=1): Error: Invalid MCP configuration:\nMCP config file not found: /tmp/happier-1000/happier-claude-mcp-config-HhARAc/payload.json';
        const screen = await renderScreen(<SubAgentRunView tool={{
            name: 'SubAgentRun', state: 'error', input: { runId: 'run_1', intent: 'delegate' },
            createdAt: 1, startedAt: 1, completedAt: 2, description: null,
            result: { status: 'failed', summary: raw, runId: 'run_1', callId: 'call_1', sidechainId: 'call_1',
                error: { code: 'claude_send_rejected', message: raw } },
        }} metadata={null} messages={[]} />);
        const text = screen.getTextContent();
        expect(text).toContain('errors.errorWithCode');
        expect(text).not.toContain('/tmp/');
        expect(text).not.toContain('Claude Agent SDK');
    });

    it('presents the typed host failure in words while keeping raw diagnostics out of the result body', async () => {
        const screen = await renderScreen(<SubAgentRunView tool={{
            name: 'SubAgentRun', state: 'error', input: { runId: 'run_1' },
            createdAt: 1, startedAt: 1, completedAt: 2, description: null,
            result: { status: 'failed', runId: 'run_1',
                error: { code: 'codex_tool_restriction_unsupported_auth', message: 'private diagnostic' } },
        }} metadata={null} messages={[]} />);
        const text = screen.getTextContent();
        expect(text).toContain('toolView.actionOutcome.cause.toolPolicyUnsupportedAuth');
        expect(text).not.toContain('private diagnostic');
        expect(text).not.toContain('codex_tool_restriction_unsupported_auth');
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

        expect(collectHostText(tree).join(' ')).toContain('Timed out after 120000ms');
    });
});
