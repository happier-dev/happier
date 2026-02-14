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

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/sync/sync', () => ({
    sync: { submitMessage: vi.fn() },
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
});
