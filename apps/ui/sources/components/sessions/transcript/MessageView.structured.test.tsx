import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    return {
        Platform: {
            OS: 'web',
            select: (values: any) => values?.web ?? values?.default,
        },
        Dimensions: {
            get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        },
        useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        View: 'View',
        Text: 'Text',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                success: '#0a0',
                text: '#111',
                textSecondary: '#555',
                link: '#06f',
                surfaceHighest: '#fff',
                divider: '#ddd',
                userMessageBackground: '#eef',
                agentEventText: '#777',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => {
            const theme = {
                colors: {
                    success: '#0a0',
                    text: '#111',
                    textSecondary: '#555',
                    link: '#06f',
                    surfaceHighest: '#fff',
                    divider: '#ddd',
                    userMessageBackground: '#eef',
                    agentEventText: '#777',
                },
            };
            return typeof input === 'function' ? input(theme, {}) : input;
        },
    },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({
    shouldShowMessageCopyButton: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

const sendMessageSpy = vi.fn<(sessionId: string, text: string, opts?: unknown) => Promise<void>>(async () => undefined);
vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (sessionId: string, text: string, opts?: unknown) => sendMessageSpy(sessionId, text, opts),
        submitMessage: vi.fn(),
    },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

const routerPushSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

describe('MessageView (structured meta)', () => {
    it('renders a structured review-comments card when meta.happier.kind is review_comments.v1', async () => {
        const { MessageView } = await import('./MessageView');
        const { ReviewCommentsMessageCard } = await import('../reviews/messages/ReviewCommentsMessageCard');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: 'review prompt',
            displayText: 'Review comments (1)',
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        sessionId: 's1',
                        comments: [
                            {
                                id: 'c1',
                                filePath: 'src/foo.ts',
                                source: 'file',
                                body: 'Please refactor',
                                createdAt: 1,
                                anchor: { kind: 'fileLine', startLine: 12 },
                                snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
                            },
                        ],
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <MessageView
                    message={message}
                    metadata={null}
                    sessionId="s1"
                />,
            );
        });

        // This should fail until MessageView wires StructuredMessageBlock into its rendering.
        expect(tree!.root.findAllByType(ReviewCommentsMessageCard as any)).toHaveLength(1);
    });

    it('does not render the MarkdownView for structured user messages', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: '@happier/review.comments ...',
            displayText: 'Review comments (1)',
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        sessionId: 's1',
                        comments: [
                            {
                                id: 'c1',
                                filePath: 'src/foo.ts',
                                source: 'file',
                                body: 'Please refactor',
                                createdAt: 1,
                                anchor: { kind: 'fileLine', startLine: 12 },
                                snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
                            },
                        ],
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        expect(tree!.root.findAllByType('MarkdownView' as any)).toHaveLength(0);
    });

    it('does not wrap structured user messages in a user bubble background', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: '@happier/review.comments ...',
            displayText: 'Review comments (1)',
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        sessionId: 's1',
                        comments: [
                            {
                                id: 'c1',
                                filePath: 'src/foo.ts',
                                source: 'file',
                                body: 'Please refactor',
                                createdAt: 1,
                                anchor: { kind: 'fileLine', startLine: 12 },
                                snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
                            },
                        ],
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const bubbleViews = tree!.root.findAll((node) => {
            if ((node as any).type !== 'View') return false;
            const styleProp = (node as any).props?.style;
            const styles = Array.isArray(styleProp) ? styleProp : [styleProp];
            return styles.some((s: any) => s && typeof s === 'object' && s.backgroundColor === '#eef');
        });
        expect(bubbleViews).toHaveLength(0);
    });

    it('navigates to the file screen when clicking Jump in the review-comments card', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: 'review prompt',
            displayText: 'Review comments (1)',
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        sessionId: 's1',
                        comments: [
                            {
                                id: 'c1',
                                filePath: 'src/foo.ts',
                                source: 'file',
                                body: 'Please refactor',
                                createdAt: 1,
                                anchor: { kind: 'fileLine', startLine: 12 },
                                snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
                            },
                        ],
                    },
                },
            },
        };

        routerPushSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const jumpButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            if (typeof (node as any).props?.onPress !== 'function') return false;
            const textChildren = node.findAllByType('Text' as any);
            return textChildren.some((t: any) => (t.children || []).join('') === 'Jump');
        });

        expect(jumpButtons).toHaveLength(1);
        await act(async () => {
            jumpButtons[0]!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/file?path=src%2Ffoo.ts&source=file&anchor=fileLine&startLine=12');
    });

    it('renders a structured review-findings card for tool-call messages when meta.happier.kind is review_findings.v1', async () => {
        const { MessageView } = await import('./MessageView');
        const { ReviewFindingsMessageCard } = await import('../reviews/messages/ReviewFindingsMessageCard');

        const message: any = {
            kind: 'tool-call',
            id: 'msg-tool-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'call_1',
                name: 'SubAgentRun',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: { ok: true },
            },
            children: [],
            meta: {
                happier: {
                    kind: 'review_findings.v1',
                    payload: {
                        runRef: { runId: 'run_1', callId: 'call_1', backendId: 'b1' },
                        summary: 'All good.',
                        findings: [
                            {
                                id: 'f1',
                                title: 'Nit',
                                severity: 'nit',
                                category: 'style',
                                filePath: 'src/foo.ts',
                                startLine: 1,
                                endLine: 1,
                                summary: 'Consider renaming.',
                            },
                        ],
                        triage: {
                            findings: [{ id: 'f1', status: 'accept' }],
                        },
                        generatedAtMs: 1,
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <MessageView
                    message={message}
                    metadata={null}
                    sessionId="s1"
                />,
            );
        });

        expect(tree!.root.findAllByType(ReviewFindingsMessageCard as any)).toHaveLength(1);
    });

    it('renders a structured plan-output card for tool-call messages when meta.happier.kind is plan_output.v1', async () => {
        const { MessageView } = await import('./MessageView');
        const { PlanOutputMessageCard } = await import('../plans/messages/PlanOutputMessageCard');

        const message: any = {
            kind: 'tool-call',
            id: 'msg-tool-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'call_1',
                name: 'SubAgentRun',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: { ok: true },
            },
            children: [],
            meta: {
                happier: {
                    kind: 'plan_output.v1',
                    payload: {
                        runRef: { runId: 'run_1', callId: 'call_1', backendId: 'b1' },
                        summary: 'Plan summary.',
                        sections: [{ title: 'Approach', items: ['Step 1'] }],
                        risks: ['Risk 1'],
                        milestones: [{ title: 'M1' }],
                        recommendedBackendId: 'b1',
                        generatedAtMs: 1,
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        expect(tree!.root.findAllByType(PlanOutputMessageCard as any)).toHaveLength(1);
    });

    it('renders a structured delegate-output card for tool-call messages when meta.happier.kind is delegate_output.v1', async () => {
        const { MessageView } = await import('./MessageView');
        const { DelegateOutputMessageCard } = await import('../delegations/messages/DelegateOutputMessageCard');

        const message: any = {
            kind: 'tool-call',
            id: 'msg-tool-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'call_1',
                name: 'SubAgentRun',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: { ok: true },
            },
            children: [],
            meta: {
                happier: {
                    kind: 'delegate_output.v1',
                    payload: {
                        runRef: { runId: 'run_1', callId: 'call_1', backendId: 'b1' },
                        summary: 'Delegation summary.',
                        deliverables: [{ id: 'd1', title: 'Deliverable 1', details: 'Do it' }],
                        generatedAtMs: 1,
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        expect(tree!.root.findAllByType(DelegateOutputMessageCard as any)).toHaveLength(1);
    });

    it('can adopt a plan by sending a structured user message to the parent session', async () => {
        sendMessageSpy.mockClear();
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'msg-tool-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'call_1',
                name: 'SubAgentRun',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: { ok: true },
            },
            children: [],
            meta: {
                happier: {
                    kind: 'plan_output.v1',
                    payload: {
                        runRef: { runId: 'run_1', callId: 'call_1', backendId: 'b1' },
                        summary: 'Plan summary.',
                        sections: [{ title: 'Approach', items: ['Step 1'] }],
                        risks: [],
                        milestones: [],
                        generatedAtMs: 1,
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const adoptButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            if (typeof (node as any).props?.onPress !== 'function') return false;
            return String((node as any).props?.accessibilityLabel ?? '') === 'Adopt plan';
        });
        expect(adoptButtons).toHaveLength(1);
        await act(async () => {
            adoptButtons[0]!.props.onPress();
        });

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy.mock.calls[0]?.[0]).toBe('s1');
        expect(String(sendMessageSpy.mock.calls[0]?.[1] ?? '')).toContain('@happier/plan.adopt');
    });

    it('can apply accepted findings by sending a structured user message to the parent session', async () => {
        sendMessageSpy.mockClear();
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'msg-tool-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'call_1',
                name: 'SubAgentRun',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: { ok: true },
            },
            children: [],
            meta: {
                happier: {
                    kind: 'review_findings.v1',
                    payload: {
                        runRef: { runId: 'run_1', callId: 'call_1', backendId: 'b1' },
                        summary: 'All good.',
                        findings: [
                            {
                                id: 'f1',
                                title: 'Nit',
                                severity: 'nit',
                                category: 'style',
                                filePath: 'src/foo.ts',
                                startLine: 1,
                                endLine: 1,
                                summary: 'Consider renaming.',
                            },
                        ],
                        triage: {
                            findings: [{ id: 'f1', status: 'accept' }],
                        },
                        generatedAtMs: 1,
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });
        // Expand the finding and select "accept" so the card has an accepted finding to apply.
        const findingHeaders = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            if (typeof (node as any).props?.onPress !== 'function') return false;
            const textChildren = node.findAllByType('Text' as any);
            return textChildren.some((t: any) => (t.children || []).join('').includes('Nit'));
        });
        expect(findingHeaders.length).toBeGreaterThan(0);
        await act(async () => {
            findingHeaders[0]!.props.onPress();
        });

        const acceptChips = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            if (typeof (node as any).props?.onPress !== 'function') return false;
            const textChildren = node.findAllByType('Text' as any);
            return textChildren.some((t: any) => (t.children || []).join('') === 'accept');
        });
        expect(acceptChips.length).toBeGreaterThan(0);
        await act(async () => {
            acceptChips[0]!.props.onPress();
        });

        const applyButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            if (typeof (node as any).props?.onPress !== 'function') return false;
            const textChildren = node.findAllByType('Text' as any);
            return textChildren.some((t: any) => (t.children || []).join('') === 'Apply accepted findings');
        });

        expect(applyButtons.length).toBe(1);
        await act(async () => {
            await applyButtons[0]!.props.onPress();
        });

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        const [sessionId, text] = sendMessageSpy.mock.calls[0] as any[];
        expect(sessionId).toBe('s1');
        expect(String(text)).toContain('@happier/review.apply_accepted_findings');
        expect(String(text)).toContain('"acceptedFindingIds":["f1"]');
    });
});
