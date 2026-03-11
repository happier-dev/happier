import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    return {
        Platform: {
            OS: 'web',
            select: (values: any) => values?.web ?? values?.default,
        },
        Easing: {
            bezier: () => ({}),
            linear: () => ({}),
        },
        Dimensions: {
            get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        },
        useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        Animated: {
            Value: class AnimatedValue {
                constructor(public _value: number) {}
                interpolate() {
                    return this as any;
                }
            },
            timing: (_value: any, _config: any) => ({
                start: (cb?: any) => {
                    cb?.();
                },
            }),
            View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
        },
        View: 'View',
        Text: 'Text',
        ScrollView: 'ScrollView',
        Image: 'Image',
        ActivityIndicator: 'ActivityIndicator',
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
                    surfaceHigh: '#f5f5f5',
                    surface: '#fff',
                    divider: '#ddd',
                    overlay: { text: '#fff', scrimStrong: 'rgba(0,0,0,0.7)' },
                    shadow: { color: '#000' },
                    input: { background: '#f7f7f7' },
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
                    surfaceHigh: '#f5f5f5',
                    surface: '#fff',
                    divider: '#ddd',
                    overlay: { text: '#fff', scrimStrong: 'rgba(0,0,0,0.7)' },
                    shadow: { color: '#000' },
                    input: { background: '#f7f7f7' },
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

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({
    shouldShowMessageCopyButton: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: any) => {
        if (key === 'session.reviewFindings.findingTitle' && params && typeof params.title === 'string') {
            return params.title;
        }
        if (typeof key === 'string' && key.startsWith('session.reviewFindings.status.')) {
            return key.split('.').pop();
        }
        if (key === 'session.reviewFindings.title' && params && typeof params.count === 'number') {
            return `Review findings (${params.count})`;
        }
        if (key === 'session.reviewFindings.actions.applyAcceptedFindings') return 'Apply accepted findings';
        if (key === 'session.reviewFindings.actions.applyTriage') return 'Apply triage';
        if (key === 'session.reviewFindings.actions.sending') return 'Sending…';
        if (key === 'session.reviewFindings.actions.applying') return 'Applying…';
        return key;
    },
}));

const modalShowSpy = vi.fn();
vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), show: (config: unknown) => modalShowSpy(config) },
}));

const sendMessageSpy = vi.fn<(sessionId: string, text: string, opts?: unknown) => Promise<void>>(async () => undefined);
vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (sessionId: string, text: string, opts?: unknown) => sendMessageSpy(sessionId, text, opts),
        submitMessage: vi.fn(),
    },
}));

const { sessionReadFileSpy } = vi.hoisted(() => ({
    sessionReadFileSpy: vi.fn(async (_sessionId: string, _path: string) => ({ success: true, content: 'aGVsbG8=' })),
}));

vi.mock('@/sync/ops', async () => {
    const actual = await vi.importActual<any>('@/sync/ops');
    return {
        ...actual,
        sessionReadFile: (sessionId: string, path: string) => sessionReadFileSpy(sessionId, path),
    };
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

let thinkingDisplayMode: 'inline' | 'tool' | 'hidden' = 'inline';
let thinkingInlinePresentation: 'full' | 'summary' = 'full';
let filesImagePreviewMaxBytes: number | null = null;
vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => null,
    useSetting: (key: string) => {
        if (key === 'sessionThinkingDisplayMode') return thinkingDisplayMode;
        if (key === 'sessionThinkingInlinePresentation') return thinkingInlinePresentation;
        if (key === 'filesImagePreviewMaxBytes') return filesImagePreviewMaxBytes;
        return null;
    },
    useSessionMessagesById: () => ({}),
    useSessionMessagesReducerState: () => null,
}));

afterEach(() => {
    thinkingDisplayMode = 'inline';
    thinkingInlinePresentation = 'full';
    filesImagePreviewMaxBytes = null;
});

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

const routerPushSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

describe('MessageView (structured meta)', { timeout: 60_000 }, () => {
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

    it('renders an inline attachments row for user messages with happier meta attachments.v1', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: [
                'hello',
                '',
                'Attachments: read each file path with the Read tool before answering.',
                '[attachments]',
                '- .happier/uploads/messages/m1/file.png (file.png, image/png, 10 bytes)',
                '[/attachments]',
            ].join('\n'),
            displayText: 'hello',
            meta: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            { name: 'file.png', path: '.happier/uploads/messages/m1/file.png', mimeType: 'image/png', sizeBytes: 10, sha256: 'h1' },
                        ],
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const markdownViews = tree!.root.findAllByType('MarkdownView' as any);
        expect(markdownViews).toHaveLength(1);
        expect(markdownViews[0]!.props.markdown).toBe('hello');

        expect(() => tree!.root.findByProps({ testID: 'message-attachments-inline-images' })).not.toThrow();
        expect(tree!.root.findAllByProps({ testID: 'message-attachments-row' })).toHaveLength(0);
    });

    it('normalizes wrapped voice agent turn text before rendering it in the hidden voice transcript', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-voice-1',
            text: [
                'At the start of your reply, include a short friendly greeting (one sentence).',
                'Then continue with your response.',
                'Context updates since your last voice turn:',
                'New messages in session: s1 (1 new message)',
                '',
                'User said:',
                'Create a file named voice_perm_local_active_20260307_d.txt containing exactly HELLO.',
            ].join('\n'),
            meta: {
                happier: {
                    kind: 'voice_agent_turn.v1',
                    payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const markdownViews = tree!.root.findAllByType('MarkdownView' as any);
        expect(markdownViews).toHaveLength(1);
        expect(markdownViews[0]!.props.markdown).toBe(
            'Create a file named voice_perm_local_active_20260307_d.txt containing exactly HELLO.',
        );
    });

    it('hides internal voice tool follow-up payload turns from the hidden voice transcript', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-voice-2',
            text: [
                'VOICE_TOOL_RESULTS_JSON:{"toolResults":[{"t":"sendSessionMessage"}]}',
                'VOICE_TOOL_RESULT_INSTRUCTIONS: All actions succeeded. Summarize the completed outcome accurately.',
            ].join('\n'),
            meta: {
                happier: {
                    kind: 'voice_agent_turn.v1',
                    payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        expect(tree!.toJSON()).toBeNull();
    });

    it('renders a placeholder tile for inline image attachments when filesImagePreviewMaxBytes is tiny', async () => {
        const { MessageView } = await import('./MessageView');

        filesImagePreviewMaxBytes = 1;

        const path = '.happier/uploads/messages/m2/file.png';
        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: [
                'hello',
                '',
                'Attachments: read each file path with the Read tool before answering.',
                '[attachments]',
                `- ${path} (file.png, image/png, 10 bytes)`,
                '[/attachments]',
            ].join('\n'),
            displayText: 'hello',
            meta: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            { name: 'file.png', path, mimeType: 'image/png', sizeBytes: 10, sha256: 'h2' },
                        ],
                    },
                },
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        expect(() => tree!.root.findByProps({ testID: 'message-attachments-inline-images' })).not.toThrow();
        expect(() => tree!.root.findByProps({ testID: `message-attachments-inline-image:${path}` })).not.toThrow();
        expect(tree!.root.findAllByProps({ testID: `message-attachments-inline-image-preview:${path}` })).toHaveLength(0);
    });

    it('opens inline transcript images in the shared attachment preview modal', async () => {
        const { MessageView } = await import('./MessageView');

        const firstPath = '.happier/uploads/messages/m3/one.png';
        const secondPath = '.happier/uploads/messages/m3/two.png';
        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: [
                'hello',
                '',
                'Attachments: read each file path with the Read tool before answering.',
                '[attachments]',
                `- ${firstPath} (one.png, image/png, 10 bytes)`,
                `- ${secondPath} (two.png, image/png, 10 bytes)`,
                '[/attachments]',
            ].join('\n'),
            displayText: 'hello',
            meta: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            { name: 'one.png', path: firstPath, mimeType: 'image/png', sizeBytes: 10, sha256: 'h3' },
                            { name: 'two.png', path: secondPath, mimeType: 'image/png', sizeBytes: 10, sha256: 'h4' },
                        ],
                    },
                },
            },
        };

        modalShowSpy.mockClear();
        routerPushSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const firstImage = tree!.root.findByProps({ testID: `message-attachments-inline-image:${firstPath}` });
        await act(async () => {
            firstImage.props.onPress();
        });

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const modalConfig = modalShowSpy.mock.calls[0]?.[0] as null | {
            props?: Readonly<{
                images?: ReadonlyArray<Readonly<{ kind: string; filePath?: string; title: string }>>;
                initialIndex?: number;
            }>;
        };
        expect(modalConfig?.props).toEqual(expect.objectContaining({
            initialIndex: 0,
            images: expect.arrayContaining([
                expect.objectContaining({ kind: 'session-image', filePath: firstPath, title: 'one.png' }),
                expect.objectContaining({ kind: 'session-image', filePath: secondPath, title: 'two.png' }),
            ]),
        }));
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
            return textChildren.some((t: any) => (t.children || []).join('') === 'files.reviewComments.jump');
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
            return String((node as any).props?.testID ?? '') === 'adopt-plan-button';
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

    it('renders a thinking label for agent thinking messages and passes markdown through unchanged', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'agent-text',
            localId: null,
            text: '**Title**\n\n- first\n- second',
            isThinking: true,
            meta: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const markdownViews = tree!.root.findAllByType('MarkdownView' as any);
        expect(markdownViews).toHaveLength(1);
        expect((markdownViews[0] as any).props.markdown).toBe('**Title**\n\n- first\n- second');

        const thinkingLabels = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            const children = (node as any).props?.children;
            return children === 'sessionInfo.thinking';
        });
        expect(thinkingLabels).toHaveLength(1);
    });

    it('unwraps legacy "*Thinking...*" markdown wrapper when rendering thinking messages', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'agent-text',
            localId: null,
            text: '*Thinking...*\n\n*Hello*',
            isThinking: true,
            meta: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const markdownViews = tree!.root.findAllByType('MarkdownView' as any);
        expect(markdownViews).toHaveLength(1);
        expect((markdownViews[0] as any).props.markdown).toBe('Hello');
    });

    it('renders inline thinking in summary mode as a collapsible row (no markdown until expanded)', async () => {
        const { MessageView } = await import('./MessageView');
        thinkingDisplayMode = 'inline';
        thinkingInlinePresentation = 'summary';

        const message: any = {
            kind: 'agent-text',
            id: 'm1',
            localId: null,
            createdAt: 1,
            text: 'Hello there',
            isThinking: true,
            meta: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" activeThinkingMessageId={null} />);
        });

        expect(tree!.root.findAll((node) => (node.props as any).testID === 'transcript-thinking-summary-inline').length).toBeGreaterThan(0);
        expect(tree!.root.findAll((node) => (node.props as any).testID === 'transcript-thinking-body-markdown')).toHaveLength(0);

        const header = tree!.root.findAll((node) => (node.props as any).testID === 'transcript-thinking-header')[0]!;
        await act(async () => {
            header.props.onPress?.();
        });

        const bodyMarkdownNodes = tree!.root.findAll((node) => (node.props as any).testID === 'transcript-thinking-body-markdown');
        expect(bodyMarkdownNodes.length).toBeGreaterThan(0);
        expect(bodyMarkdownNodes.some((n) => (n.props as any).markdown === 'Hello there')).toBe(true);
    });

    it('can render thinking messages as a Reasoning tool card when sessionThinkingDisplayMode=tool', async () => {
        thinkingDisplayMode = 'tool';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'agent-text',
            localId: null,
            text: '**Title**\n\nHello',
            isThinking: true,
            meta: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        const markdownViews = tree!.root.findAllByType('MarkdownView' as any);
        expect(markdownViews).toHaveLength(0);

        const toolViews = tree!.root.findAllByType('ToolView' as any);
        expect(toolViews).toHaveLength(1);
        expect((toolViews[0] as any).props.tool?.name).toBe('Reasoning');
        expect((toolViews[0] as any).props.tool?.result?.content).toBe('**Title**\n\nHello');
    });

    it('can hide thinking messages when sessionThinkingDisplayMode=hidden', async () => {
        thinkingDisplayMode = 'hidden';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'agent-text',
            localId: null,
            text: 'Hello',
            isThinking: true,
            meta: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        expect(tree!.root.findAllByType('MarkdownView' as any)).toHaveLength(0);
        expect(tree!.root.findAllByType('ToolView' as any)).toHaveLength(0);
    });
});
