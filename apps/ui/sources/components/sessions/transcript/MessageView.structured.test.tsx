import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createReducer } from '@/sync/reducer/reducer';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { UserTextMessage } from '@/sync/domains/messages/messageTypes';
import {
    formatVoiceToolResultsFollowUp,
    VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX,
} from '@happier-dev/protocol';

const structuredRouterState = vi.hoisted(() => ({
    push: vi.fn(),
}));

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Easing: {
                bezier: () => ({}),
                linear: () => ({}),
            },
            Dimensions: {
                get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            View: 'View',
            Text: 'Text',
            ScrollView: 'ScrollView',
            Image: 'Image',
            ActivityIndicator: 'ActivityIndicator',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        // The transcript byline is asserted against the REAL English catalog.
        // A hand-written literal here would let the shipped copy drift while
        // this test kept passing, which is the exact shape of a guard that
        // cannot fail.
        const { en } = await import('@/text/translations/en');
        const englishMessage = en.message as unknown as Readonly<Record<string, unknown>>;
        return createTextModuleMock({
            translate: (key: string, params?: any) => {
                if (key.startsWith('message.pluginAttribution')) {
                    const leaf = englishMessage[key.slice('message.'.length)];
                    if (typeof leaf === 'function') return (leaf as (input: unknown) => string)(params);
                    if (typeof leaf === 'string') return leaf;
                }
                if (key === 'session.reviewFindings.findingTitle' && params && typeof params.title === 'string') {
                    return params.title;
                }
                if (typeof key === 'string' && key.startsWith('session.reviewFindings.status.')) {
                    return key.split('.').pop();
                }
                if (key === 'session.reviewFindings.title' && params && typeof params.count === 'number') {
                    return `Review findings (${params.count})`;
                }
                if (key === 'session.reviewFindings.actions.applyAcceptedFindings') return 'Implement selected fixes';
                if (key === 'session.reviewFindings.actions.applyTriage') return 'Apply review actions';
                if (key === 'session.reviewFindings.actions.sending') return 'Sending…';
                if (key === 'session.reviewFindings.actions.applying') return 'Applying…';
                return key;
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        modalMock.spies.show.mockImplementation((config: unknown) => {
            modalShowSpy(config);
            return 'modal-id';
        });
        return modalMock.module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: structuredRouterState.push },
        });
        return {
            ...routerMock.module,
            useRouter: () => ({ push: structuredRouterState.push }),
        };
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => ({
                accessLevel: null,
                canApprovePermissions: true,
                active: true,
                presence: 'online',
            }),
            useSessionInteractionSource: () => ({
                accessLevel: null,
                canApprovePermissions: true,
                active: true,
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSetting: (key: string) => {
                if (key === 'sessionThinkingDisplayMode') return thinkingDisplayMode;
                if (key === 'sessionThinkingInlinePresentation') return thinkingInlinePresentation;
                if (key === 'filesImagePreviewMaxBytes') return filesImagePreviewMaxBytes;
                if (key === 'toolViewTimelineChromeMode') return toolViewTimelineChromeMode;
                return null;
            },
            useLocalSetting: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => createReducer(),
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/sessions/transcript/transcriptRowActionVisibility', () => ({
    shouldShowTranscriptRowActions: () => false,
    shouldShowTranscriptRowPinAction: () => false,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
    getAgentBehavior: () => ({ permissions: { footer: {} } }),
    getAgentCore: () => ({
        permissions: { promptProtocol: 'codexDecision' },
        toolRendering: { hideUnknownToolsByDefault: false },
    }),
    resolveAgentIdFromFlavor: () => 'codex',
}));

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'codex',
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'codexDecision',
        yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
        yesForSessionKey: 'codex.permissions.yesForSession',
        stopKey: 'codex.permissions.stop',
    }),
}));

const modalShowSpy = vi.fn();

const submitMessageSpy = vi.fn<
    (
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
    ) => Promise<void>
>(async () => undefined);
vi.mock('@/sync/sync', () => ({
    sync: {
        submitMessage: (
            sessionId: string,
            text: string,
            displayText?: string,
            metaOverrides?: Record<string, unknown>,
        ) => submitMessageSpy(sessionId, text, displayText, metaOverrides),
        sendMessage: vi.fn(),
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
let toolViewTimelineChromeMode: 'activity_feed' | 'cards' | null = null;

afterEach(() => {
    structuredRouterState.push = routerPushSpy;
    routerPushSpy.mockReset();
    thinkingDisplayMode = 'inline';
    thinkingInlinePresentation = 'full';
    filesImagePreviewMaxBytes = null;
    toolViewTimelineChromeMode = null;
    standardCleanup();
});

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

const routerPushSpy = structuredRouterState.push;
const sessionInteraction = deriveTranscriptInteraction({
    kind: 'session',
    accessLevel: null,
    canApprovePermissions: true,
    isSessionActive: true,
});
const publicInteraction = deriveTranscriptInteraction({ kind: 'public' });
const viewOnlyInteraction = deriveTranscriptInteraction({
    kind: 'session',
    accessLevel: 'view',
    canApprovePermissions: false,
    isSessionActive: true,
});

function createStructuredToolMessage(
    kind: 'plan_output.v1' | 'review_findings.v1' | 'review_findings.v2',
    payload: Record<string, unknown>,
) {
    return {
        kind: 'tool-call',
        id: `msg-${kind}`,
        localId: null,
        createdAt: 1,
        tool: {
            id: `call-${kind}`,
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
                kind,
                payload,
            },
        },
    };
}

function createPlanOutputMessage() {
    return createStructuredToolMessage('plan_output.v1', {
        runRef: { runId: 'run-plan', callId: 'call-plan', backendId: 'b1' },
        summary: 'Plan summary.',
        sections: [{ title: 'Approach', items: ['Step 1'] }],
        risks: [],
        milestones: [],
        generatedAtMs: 1,
    });
}

function createReviewFindingsMessage(kind: 'review_findings.v1' | 'review_findings.v2') {
    return createStructuredToolMessage(kind, {
        runRef: {
            runId: `run-${kind}`,
            callId: `call-${kind}`,
            backendId: 'b1',
            retentionPolicy: 'resumable',
        },
        summary: 'Review summary.',
        ...(kind === 'review_findings.v2'
            ? {
                overviewMarkdown: '## Overview\n\nReview summary.',
                questions: [],
                assumptions: [],
            }
            : {}),
        findings: [{
            id: 'f1',
            title: 'Nit',
            severity: 'nit',
            category: 'style',
            filePath: 'src/foo.ts',
            startLine: 1,
            endLine: 1,
            summary: 'Consider renaming.',
        }],
        triage: {
            findings: [{ id: 'f1', status: 'accept' }],
        },
        generatedAtMs: 1,
    });
}

describe('MessageView (structured meta)', { timeout: 60_000 }, () => {
    it('renders every persisted composer attachment as host-only transcript context', async () => {
        const { MessageView } = await import('./MessageView');
        const message = {
            kind: 'user-text' as const,
            id: 'composer-attachments',
            localId: 'local-composer-attachments',
            createdAt: 0,
            text: 'Please investigate these issues.',
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [
                        {
                            v: 1,
                            instanceId: 'issue-42',
                            attachment: { pluginId: 'acme.issues', localId: 'issue' },
                            key: '42',
                            value: { issueId: 42 },
                            presentation: {
                                typeLabel: 'Issue',
                                label: 'Issue #42',
                                description: 'Production error',
                                icon: 'error',
                            },
                        },
                        {
                            v: 1,
                            instanceId: 'run-7',
                            attachment: { pluginId: 'acme.deployments', localId: 'run' },
                            key: '7',
                            value: { runId: 7 },
                            presentation: {
                                typeLabel: 'Deployment',
                                label: 'Deploy #7',
                                tone: 'warning',
                            },
                        },
                    ],
                },
            },
        } satisfies UserTextMessage;

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
            />,
        );

        expect(screen.findByTestId('transcript-composer-attachment:composer-attachments:issue-42')).not.toBeNull();
        expect(screen.findByTestId('transcript-composer-attachment:composer-attachments:run-7')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Issue #42');
        expect(screen.getTextContent()).toContain('Production error');
        expect(screen.getTextContent()).toContain('Deploy #7');
    });

    it('renders durable plugin provenance in ordinary and structured user messages, but fails closed otherwise', async () => {
        const { MessageView } = await import('./MessageView');
        const pluginProvenance = {
            v: 1,
            kind: 'pluginSession',
            pluginId: 'acme.preview',
            contributionLocalId: 'inbound',
            surface: 'unspecified',
        } as const;
        const messages = [
            {
                kind: 'user-text',
                id: 'plugin-ordinary',
                localId: 'local-plugin-ordinary',
                createdAt: 0,
                text: 'Plugin input',
                meta: { happierProvenanceV1: pluginProvenance },
            },
            {
                kind: 'user-text',
                id: 'plugin-structured',
                localId: 'local-plugin-structured',
                createdAt: 0,
                text: 'Plugin preview',
                meta: {
                    happierProvenanceV1: pluginProvenance,
                    happier: {
                        kind: 'acme.preview/preview-card.v1',
                        payload: { title: 'Preview ready' },
                    },
                },
            },
            {
                kind: 'user-text',
                id: 'legacy-plugin',
                localId: 'local-legacy-plugin',
                createdAt: 0,
                text: 'Legacy plugin input',
                meta: {
                    happier: {
                        kind: 'conversation_turn.v1',
                        payload: { v: 1 },
                        conversationTurnOriginV1: {
                            v: 1,
                            channel: 'realtime_conversation',
                            modality: 'voice',
                            source: {
                                pluginId: 'example.channels',
                                contributionId: 'inbound',
                            },
                        },
                    },
                },
            },
            {
                kind: 'user-text',
                id: 'no-provenance',
                localId: 'local-no-provenance',
                createdAt: 0,
                text: 'Ordinary input',
                meta: {},
            },
            {
                kind: 'user-text',
                id: 'malformed-provenance',
                localId: 'local-malformed-provenance',
                createdAt: 0,
                text: 'Malformed input',
                meta: {
                    happierProvenanceV1: {
                        v: 1,
                        kind: 'pluginSession',
                        pluginId: 'acme.preview',
                    },
                },
            },
            {
                kind: 'user-text',
                id: 'other-provenance',
                localId: 'local-other-provenance',
                createdAt: 0,
                text: 'Voice input',
                meta: { happierProvenanceV1: { v: 1, kind: 'voice' } },
            },
        ] satisfies UserTextMessage[];

        const screen = await renderScreen(
            <>
                {messages.map((message) => (
                    <MessageView
                        key={message.id}
                        message={message}
                        metadata={null}
                        sessionId="s1"
                    />
                ))}
            </>,
        );

        for (const [id, label] of [
            ['plugin-ordinary', 'From plugin acme.preview'],
            ['plugin-structured', 'From plugin acme.preview'],
            ['legacy-plugin', 'From plugin example.channels'],
        ]) {
            const attribution = screen.findByTestId(`transcript-plugin-attribution:${id}`);
            expect(attribution).not.toBeNull();
            expect(attribution?.props.accessibilityRole).toBe('text');
            expect(attribution?.props.accessibilityLabel).toBe(label);
            expect(attribution?.props.numberOfLines).toBe(1);
            expect(attribution?.props.ellipsizeMode).toBe('tail');
            expect(attribution?.props.children).toBe(label);
        }
        expect(screen.findByTestId('transcript-plugin-attribution:no-provenance')).toBeNull();
        expect(screen.findByTestId('transcript-plugin-attribution:malformed-provenance')).toBeNull();
        expect(screen.findByTestId('transcript-plugin-attribution:other-provenance')).toBeNull();
    });

    it('names the external sender and discloses forwarding in the durable plugin byline', async () => {
        const { MessageView } = await import('./MessageView');
        const external = (
            id: string,
            externalActor: Readonly<{ kind: 'human' | 'bot'; displayNameSnapshot?: string }>,
            contentProvenance: 'original' | 'forwarded' | 'viaBot',
        ) => ({
            kind: 'user-text',
            id,
            localId: `local-${id}`,
            createdAt: 0,
            text: 'External input',
            meta: {
                happierProvenanceV1: {
                    v: 1,
                    kind: 'pluginSession',
                    pluginId: 'happier.channels',
                    contributionLocalId: 'inbound',
                    surface: 'unspecified',
                    sourceRef: 'channels:binding:binding-1',
                    sourceRevisionOrEpoch: '1:1',
                    externalActor,
                    contentProvenance,
                },
            },
        }) satisfies UserTextMessage;
        const messages = [
            external('external-named', { kind: 'human', displayNameSnapshot: 'Ada Lovelace' }, 'original'),
            external('external-forwarded', { kind: 'human', displayNameSnapshot: 'Ada Lovelace' }, 'forwarded'),
            external('external-anonymous-person', { kind: 'human' }, 'original'),
            external('external-anonymous-bot', { kind: 'bot' }, 'viaBot'),
        ];

        const screen = await renderScreen(
            <>
                {messages.map((message) => (
                    <MessageView
                        key={message.id}
                        message={message}
                        metadata={null}
                        sessionId="s1"
                    />
                ))}
            </>,
        );

        for (const [id, label] of [
            ['external-named', 'From Ada Lovelace via plugin happier.channels'],
            // Forwarding changes WHO wrote the message. Rendering the plain
            // "From <sender>" byline for it would state something false.
            ['external-forwarded', 'Forwarded by Ada Lovelace via plugin happier.channels'],
            ['external-anonymous-person', 'From an external sender via plugin happier.channels'],
            ['external-anonymous-bot', 'From an external bot via plugin happier.channels'],
        ]) {
            const attribution = screen.findByTestId(`transcript-plugin-attribution:${id}`);
            expect(attribution?.props.accessibilityLabel).toBe(label);
            expect(attribution?.props.children).toBe(label);
        }
    });

    it('fails closed for an unpersisted generic plugin envelope', async () => {
        const { MessageView } = await import('./MessageView');
        const kind = 'acme.preview/preview-card.v1';
        const message = {
            kind: 'user-text',
            id: 'plugin-structured-message-1',
            localId: 'local-plugin-structured-message-1',
            createdAt: 0,
            text: 'Plugin preview',
            meta: {
                happier: {
                    kind,
                    payload: {
                        title: 'Preview ready',
                        summary: 'Open the local preview when you need to inspect it.',
                    },
                },
            },
        } satisfies UserTextMessage;

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
            />,
        );

        expect(screen.findByTestId('structured-message-unavailable')).toBeTruthy();
    });

    it('renders session_media.v1 inline images from the dedicated media metadata slot', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-media-1',
            text: 'Generated image',
            meta: {
                happierMedia: {
                    kind: 'session_media.v1',
                    payload: {
                        media: [{
                            id: 'media-1',
                            role: 'output',
                            category: 'generated',
                            mediaKind: 'image',
                            mimeType: 'image/png',
                            name: 'generated.png',
                            path: '.happier/uploads/generated/session-1/message-1/generated.png',
                            sizeBytes: 42,
                            width: 1600,
                            height: 900,
                            origin: { source: 'provider-generated' },
                        }],
                    },
                },
            },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findByTestId('message-session-media-inline-images')).toBeTruthy();
        expect(screen.findByTestId('message-session-media-inline-image:.happier/uploads/generated/session-1/message-1/generated.png')).toBeTruthy();
    });

    it('renders failure-only session_media.v1 image rows from the dedicated media metadata slot', async () => {
        const { MessageView } = await import('./MessageView');

        const message = {
            kind: 'user-text',
            id: 'message-media-failure-1',
            localId: 'local-media-failure-1',
            createdAt: 0,
            text: 'Generated image',
            meta: {
                happierMedia: {
                    kind: 'session_media.v1',
                    payload: {
                        media: [],
                        failures: [{
                            index: 0,
                            code: 'invalid_source_file',
                            role: 'output',
                            category: 'generated',
                            mediaKind: 'image',
                            mimeType: 'image/png',
                            name: 'generated.png',
                            origin: { source: 'provider-generated' },
                        }],
                    },
                },
            },
        } satisfies UserTextMessage;

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findByTestId('message-session-media-inline-images')).toBeTruthy();
        expect(screen.findByTestId('message-session-media-inline-image-unavailable:failure-0')).toBeTruthy();
    });

    it('renders session_media.v1 video evidence references from the dedicated media metadata slot', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-media-video-1',
            text: 'Browser recording',
            meta: {
                happierMedia: {
                    kind: 'session_media.v1',
                    payload: {
                        media: [{
                            id: 'recording-1',
                            role: 'output',
                            category: 'tool-artifact',
                            mediaKind: 'video',
                            mimeType: 'video/webm',
                            name: 'browser-recording.webm',
                            path: '.happier/uploads/artifacts/session-1/message-1/browser-recording.webm',
                            sizeBytes: 2048,
                            origin: { source: 'tool-output' },
                        }],
                    },
                },
            },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findByTestId('message-session-media-inline-images')).toBeTruthy();
        expect(screen.findByTestId('message-session-media-inline-video:.happier/uploads/artifacts/session-1/message-1/browser-recording.webm')).toBeTruthy();
    });

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

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
            />,
        );

        // This should fail until MessageView wires StructuredMessageBlock into its rendering.
        expect(screen.findAllByType(ReviewCommentsMessageCard as any)).toHaveLength(1);
    });

    it('keeps structured review jump handlers stable across equivalent parent renders', async () => {
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

        const renderMessage = () => (
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
            />
        );
        const screen = await renderScreen(renderMessage());
        const firstJumpHandler = screen.tree.root.findByType(ReviewCommentsMessageCard as any).props.onJumpToAnchor;

        await act(async () => {
            screen.tree.update(renderMessage());
        });

        const secondJumpHandler = screen.tree.root.findByType(ReviewCommentsMessageCard as any).props.onJumpToAnchor;
        expect(secondJumpHandler).toBe(firstJumpHandler);
    });

    it('keeps the committed router authoritative through an abandoned same-session structured-row render', async () => {
        const { MessageView } = await import('./MessageView');
        const { ReviewCommentsMessageCard } = await import('../reviews/messages/ReviewCommentsMessageCard');
        const interaction = deriveTranscriptInteraction({
            kind: 'session',
            accessLevel: null,
            canApprovePermissions: true,
            isSessionActive: true,
        });
        const routerA = vi.fn();
        const routerB = vi.fn();
        const neverSettles = new Promise<never>(() => {});
        const message: any = {
            kind: 'user-text',
            id: 'm-review-comments',
            localId: 'local-1',
            text: 'review prompt',
            displayText: 'Review comments (1)',
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        sessionId: 's1',
                        comments: [{
                            id: 'c1',
                            filePath: 'src/foo.ts',
                            source: 'file',
                            body: 'Please refactor',
                            createdAt: 1,
                            anchor: { kind: 'fileLine', startLine: 12 },
                            snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
                        }],
                    },
                },
            },
        };
        const updatedMessage = {
            ...message,
            displayText: 'Review comments (updated)',
        };
        const SuspendAfterRow = (props: Readonly<{ shouldSuspend: boolean }>) => {
            if (props.shouldSuspend) throw neverSettles;
            return null;
        };
        const renderMessage = (messageValue: typeof message, shouldSuspend = false) => (
            <React.Suspense fallback={null}>
                <MessageView
                    message={messageValue}
                    metadata={null}
                    sessionId="s1"
                    interaction={interaction}
                />
                <SuspendAfterRow shouldSuspend={shouldSuspend} />
            </React.Suspense>
        );
        let tree!: renderer.ReactTestRenderer;

        structuredRouterState.push = routerA;
        await act(async () => {
            tree = renderer.create(renderMessage(message), {
                unstable_isConcurrent: true,
            } as unknown as renderer.TestRendererOptions);
        });
        const committedAJump = tree.root.findByType(ReviewCommentsMessageCard as any).props.onJumpToAnchor;

        structuredRouterState.push = routerB;
        await act(async () => {
            React.startTransition(() => {
                tree.update(renderMessage(updatedMessage, true));
            });
            await Promise.resolve();
        });

        committedAJump({
            filePath: 'src/foo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
        });
        expect(routerA).toHaveBeenCalledTimes(1);
        expect(routerB).not.toHaveBeenCalled();

        await act(async () => {
            tree.update(renderMessage(updatedMessage));
        });
        const committedBJump = tree.root.findByType(ReviewCommentsMessageCard as any).props.onJumpToAnchor;
        committedBJump({
            filePath: 'src/foo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
        });
        expect(routerB).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.unmount();
        });
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findAllByType('MarkdownView' as any)).toHaveLength(0);
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        const bubbleViews = screen.findAll((node) => {
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
                'Attachments: open and analyze these files before answering.',
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        const markdownViews = screen.findAllByType('MarkdownView' as any);
        expect(markdownViews).toHaveLength(1);
        expect(markdownViews[0]!.props.markdown).toBe('hello');

        expect(screen.findByTestId('message-attachments-inline-images')).not.toBeNull();
        expect(screen.findAllByTestId('message-attachments-row')).toHaveLength(0);
    });

    it('keeps unsupported image attachments visible as file rows', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-svg-1',
            text: [
                'hello',
                '',
                'Attachments: open and analyze these files before answering.',
                '[attachments]',
                '- .happier/uploads/messages/m1/icon.svg (icon.svg, image/svg+xml, 12 bytes)',
                '[/attachments]',
            ].join('\n'),
            displayText: 'hello',
            meta: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            { name: 'icon.svg', path: '.happier/uploads/messages/m1/icon.svg', mimeType: 'image/svg+xml', sizeBytes: 12, sha256: 'svg-hash' },
                        ],
                    },
                },
            },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findByTestId('message-attachments-inline-images')).toBeNull();
        expect(screen.findByTestId('message-attachments-row')).not.toBeNull();
        expect(screen.getTextContent()).toContain('icon.svg');
    });

    it('renders attachments for structured review-comment messages that carry attachment metadata', async () => {
        const { MessageView } = await import('./MessageView');
        const { ReviewCommentsMessageCard } = await import('../reviews/messages/ReviewCommentsMessageCard');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: 'review prompt\n\n[attachments block]',
            displayText: 'Review comments (1)\n\n[attachments block]',
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
                happierAttachments: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            { name: 'note.txt', path: '.happier/uploads/messages/m1/note.txt', mimeType: 'text/plain', sizeBytes: 10, sha256: 'h1' },
                        ],
                    },
                },
            },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findAllByType(ReviewCommentsMessageCard as any)).toHaveLength(1);
        expect(screen.findByTestId('message-attachments-row')).not.toBeNull();
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        const markdownViews = screen.findAllByType('MarkdownView' as any);
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
                formatVoiceToolResultsFollowUp({ toolResults: [{ t: 'sendSessionMessage' }] }),
                `${VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX} All actions succeeded. Summarize the completed outcome accurately.`,
            ].join('\n'),
            meta: {
                happier: {
                    kind: 'voice_agent_turn.v1',
                    payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 },
                },
            },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.tree.toJSON()).toBeNull();
    });

    it('hides voice transcript turns whose normalized text is empty after trimming', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'agent-text',
            id: 'voice-empty',
            localId: null,
            createdAt: 1,
            text: '   ',
            isThinking: false,
            meta: {
                happier: {
                    kind: 'voice_agent_turn.v1',
                    payload: { v: 1, epoch: 4, role: 'assistant', voiceAgentId: 'mid', ts: 101 },
                },
            },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.tree.toJSON()).toBeNull();
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
                'Attachments: open and analyze these files before answering.',
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findByTestId('message-attachments-inline-images')).not.toBeNull();
        expect(screen.findByTestId(`message-attachments-inline-image:${path}`)).not.toBeNull();
        expect(screen.findAllByTestId(`message-attachments-inline-image-preview:${path}`)).toHaveLength(0);
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
                'Attachments: open and analyze these files before answering.',
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        await screen.pressByTestIdAsync(`message-attachments-inline-image:${firstPath}`);

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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findByTestId('review-comments-jump:c1')).not.toBeNull();
        await screen.pressByTestIdAsync('review-comments-jump:c1');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/file?path=src%2Ffoo.ts&source=file&anchor=fileLine&startLine=12');
    });

    it('keeps public structured file actions inert', async () => {
        const { MessageView } = await import('./MessageView');
        const message: any = {
            kind: 'user-text',
            localId: 'public-review',
            text: 'review prompt',
            displayText: 'Review comments (1)',
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        sessionId: 's1',
                        comments: [{
                            id: 'public-comment',
                            filePath: 'src/private.ts',
                            source: 'file',
                            body: 'Public metadata',
                            createdAt: 1,
                            anchor: { kind: 'fileLine', startLine: 4 },
                            snapshot: { selectedLines: ['secret'], beforeContext: [], afterContext: [] },
                        }],
                    },
                },
            },
        };

        routerPushSpy.mockClear();
        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
                interaction={deriveTranscriptInteraction({ kind: 'public' })}
            />,
        );

        expect(screen.findByTestId('review-comments-jump:public-comment')).toBeNull();
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('navigates transcript markdown range links with normalized file anchors', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            id: 'message-link-1',
            localId: 'local-link-1',
            createdAt: 0,
            text: '[open range](src/foo.ts:5-8)',
            meta: {},
        };

        routerPushSpy.mockClear();

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
        const markdownView = screen.findByType('MarkdownView' as any);

        expect(markdownView.props.onLinkPress('src/foo.ts:5-8')).toBe(true);
        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/file?path=src%2Ffoo.ts&source=file&anchor=range&startLine=5&endLine=8');
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
                    kind: 'review_findings.v2',
                    payload: {
                        runRef: { runId: 'run_1', callId: 'call_1', backendId: 'b1' },
                        summary: 'All good.',
                        overviewMarkdown: '## Overview\n\nAll good.',
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
                        questions: [],
                        assumptions: [],
                        generatedAtMs: 1,
                    },
                },
            },
        };

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
            />,
        );

        expect(screen.findAllByType(ReviewFindingsMessageCard as any)).toHaveLength(1);
    });

    it('suppresses the duplicate ToolTimelineRow for structured review tool-calls in activity feed mode', async () => {
        toolViewTimelineChromeMode = 'activity_feed';
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
                    kind: 'review_findings.v2',
                    payload: {
                        runRef: { runId: 'run_1', callId: 'call_1', backendId: 'b1' },
                        summary: 'All good.',
                        overviewMarkdown: '## Overview\n\nAll good.',
                        findings: [],
                        questions: [],
                        assumptions: [],
                        generatedAtMs: 1,
                    },
                },
            },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findAllByType(ReviewFindingsMessageCard as any)).toHaveLength(1);
        expect(screen.findAllByType('ToolTimelineRow' as any)).toHaveLength(0);
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findAllByType(PlanOutputMessageCard as any)).toHaveLength(1);
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findAllByType(DelegateOutputMessageCard as any)).toHaveLength(1);
    });

    it('can adopt a plan by sending a structured user message to the parent session', async () => {
        submitMessageSpy.mockClear();
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

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
                interaction={sessionInteraction}
            />,
        );

        expect(screen.findByTestId('adopt-plan-button')).not.toBeNull();
        await screen.pressByTestIdAsync('adopt-plan-button');

        expect(submitMessageSpy).toHaveBeenCalledTimes(1);
        expect(submitMessageSpy.mock.calls[0]?.[0]).toBe('s1');
        expect(String(submitMessageSpy.mock.calls[0]?.[1] ?? '')).toContain('@happier/plan.adopt');
    });

    it('can apply accepted findings by sending a structured user message to the parent session', async () => {
        submitMessageSpy.mockClear();
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

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
                interaction={sessionInteraction}
            />,
        );
        expect(screen.findByTestId('review-findings-header:f1')).not.toBeNull();
        await screen.pressByTestIdAsync('review-findings-header:f1');

        expect(screen.findByTestId('review-findings-publish-accepted')).not.toBeNull();
        await screen.pressByTestIdAsync('review-findings-publish-accepted');

        expect(submitMessageSpy).toHaveBeenCalledTimes(1);
        const [sessionId, text, _displayText, metaOverrides] = submitMessageSpy.mock.calls[0] as any[];
        expect(sessionId).toBe('s1');
        expect(String(text)).toContain('Please implement the accepted review findings below.');
        expect(metaOverrides).toEqual({
            happier: {
                kind: 'review_publish_request.v1',
                payload: expect.objectContaining({
                    sourceRunRef: { runId: 'run_1', callId: 'call_1', backendId: 'b1' },
                    findingIds: ['f1'],
                }),
            },
        });
    });

    it.each([
        ['public', publicInteraction],
        ['authenticated view-only', viewOnlyInteraction],
    ] as const)('keeps plan adoption unavailable in %s transcripts', async (_surface, interaction) => {
        submitMessageSpy.mockClear();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                message={createPlanOutputMessage() as any}
                metadata={null}
                sessionId="s1"
                interaction={interaction}
            />,
        );
        const adopt = screen.findByTestId('adopt-plan-button');
        if (adopt) {
            await act(async () => {
                await adopt.props.onPress?.();
            });
        }

        expect(adopt).toBeNull();
        expect(submitMessageSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['public', publicInteraction],
        ['authenticated view-only', viewOnlyInteraction],
    ] as const)('keeps review v1/v2 mutations unavailable in %s transcripts', async (_surface, interaction) => {
        submitMessageSpy.mockClear();
        const { MessageView } = await import('./MessageView');

        for (const kind of ['review_findings.v1', 'review_findings.v2'] as const) {
            const screen = await renderScreen(
                <MessageView
                    message={createReviewFindingsMessage(kind) as any}
                    metadata={null}
                    sessionId="s1"
                    interaction={interaction}
                />,
            );
            await screen.pressByTestIdAsync('review-findings-header:f1');

            const publishAccepted = screen.findByTestId('review-findings-publish-accepted');
            if (publishAccepted) {
                await act(async () => {
                    await publishAccepted.props.onPress?.();
                });
            }

            expect(screen.findByTestId('review-findings-apply-triage')).toBeNull();
            expect(publishAccepted).toBeNull();
            expect(screen.getTextContent()).not.toContain('session.reviewFindings.actions.askReviewer');
        }

        expect(submitMessageSpy).not.toHaveBeenCalled();
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        const markdownViews = screen.findAllByType('MarkdownView' as any);
        expect(markdownViews).toHaveLength(1);
        expect((markdownViews[0] as any).props.markdown).toBe('**Title**\n\n- first\n- second');

        const thinkingLabels = screen.findAll((node) => {
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        const markdownViews = screen.findAllByType('MarkdownView' as any);
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" activeThinkingMessageId={null} />);

        expect(screen.findAllByTestId('transcript-thinking-summary-inline').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('transcript-thinking-body-markdown')).toHaveLength(0);

        await screen.pressByTestIdAsync('transcript-thinking-header');

        const bodyMarkdownNodes = screen.findAllByTestId('transcript-thinking-body-markdown');
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        const markdownViews = screen.findAllByType('MarkdownView' as any);
        expect(markdownViews).toHaveLength(0);

        const toolViews = screen.findAllByType('ToolView' as any);
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

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(screen.findAllByType('MarkdownView' as any)).toHaveLength(0);
        expect(screen.findAllByType('ToolView' as any)).toHaveLength(0);
    });

    it('renders a translated accessible recovered-history indicator with source time', async () => {
        const { MessageView } = await import('./MessageView');
        const message: any = {
            id: 'history-message',
            kind: 'agent-text',
            localId: null,
            createdAt: 9_000,
            sourceCreatedAt: 1_000,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            text: 'Recovered output',
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
        const indicator = screen.findByTestId('transcript-recovered-history:history-message');

        expect(indicator).not.toBeNull();
        expect(indicator?.props.accessibilityRole).toBe('text');
        expect(indicator?.props.accessibilityLabel).toContain('message.recoveredHistory');
        expect(String(indicator?.props.children)).toContain('message.recoveredHistory');
        expect(String(indicator?.props.children)).not.toBe('message.recoveredHistory');
    });
});
