import React from 'react';
import { act } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import type { Message } from '@happier-dev/session-core/messages';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource as renderScreen } from '@/dev/testkit/sessionTranscriptSource';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { TranscriptFindProvider } from './find/TranscriptFindContext';
import { applyTranscriptJumpHighlightForJumpResult, clearTranscriptJumpHighlight, TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS } from './navigation/transcriptJumpHighlightStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: vi.fn() } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
await import('./MessageView');

const FAILURE_TEXT = 'custom-acp turn failed: Internal error: Cannot connect to API: Unable to connect. Is the computer able to access the url?';

/** The persisted shapes the host failure projector commits (runtimeFailureTranscript.ts), read back through the real reducer. */
function projectPersistedRows(rows: readonly Readonly<{ id: string; data: Record<string, unknown>; meta?: Record<string, unknown> }>[]): Message[] {
    const state = createReducer();
    const normalized = rows.map((row, index) => normalizeRawMessage(row.id, row.id, 1_000 + index, {
        role: 'agent',
        content: { type: 'acp', agentId: 'custom-acp', data: row.data },
        ...(row.meta ? { meta: row.meta } : {}),
    }, { seq: index + 1 }));
    return reducer(state, normalized.filter((m): m is NonNullable<typeof m> => m !== null)).messages;
}

const runtimeMeta = { source: 'runtime', runtimeIssueCode: 'acp_turn_failed', runtimeIssueSource: 'agent_session_error' };

describe('MessageView runtime failure rows', () => {
    afterEach(async () => {
        await act(() => clearTranscriptJumpHighlight());
        vi.useRealTimers();
        standardCleanup();
    });

    it.each([false, true])('offers a capability recovery link only when the source can navigate (%s)', async navigationEnabled => {
        const { MessageView } = await import('./MessageView');
        const message: Message = { kind: 'agent-event', id: 'capability', localId: null, createdAt: 1,
            event: { type: 'message', message: 'Linear could not start', capabilityNoticeV1: { v: 1, items: [
                { kind: 'mcp_server', name: 'Linear', itemId: 'linear', code: 'missing_value_ref', detail: 'env:LINEAR_API_KEY' },
            ] } } };
        const source = createTestSessionTranscriptSource({ messages: [message], navigate: navigationEnabled ? vi.fn() : null,
            interaction: { canSendMessages: true, canApprovePermissions: true } });
        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />, source);
        expect(Boolean(screen.findHostByTestId('transcript-event-capability-notice-open'))).toBe(navigationEnabled);
    });

    it.each(['owner', 'shared-editor'] as const)('reads a typed Team failure as a runtime notice for a %s without owner metadata', async viewer => {
        const { MessageView } = await import('./MessageView');
        const preview = 'Shared Team credential refused the request';
        const messages = projectPersistedRows([{ id: 'team-failure', data: { type: 'message', message: preview },
            meta: { source: 'runtime', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed',
                code: 'team_credential', source: 'team_credential', occurredAt: 1_000, sanitizedPreview: preview,
                teamCredential: { v: 1, resourceId: 'selected-resource', reasonCode: 'resource_forbidden' } } } }]);
        const source = createTestSessionTranscriptSource({ sessionId: 's1', messages, metadata: null,
            authorship: { viewerScope: { serverId: 'home', accountId: viewer === 'owner' ? 'B' : 'A' },
                hasOtherNamedCollaborator: true },
            interaction: { canSendMessages: true, canApprovePermissions: viewer === 'owner' } });
        const screen = await renderScreen(<MessageView message={messages[0]!} metadata={null} sessionId="s1" />, source);
        expect(screen.findByTestId('transcript-event-runtime-issue')).not.toBeNull();
        const { MarkdownView } = await import('@/components/markdown/MarkdownView');
        expect(screen.findAllByType(MarkdownView)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('teams.credentials.sessionDeniedTitle');
        expect(screen.getTextContent()).toContain('teams.credentials.forbidden');
        expect(screen.getTextContent()).not.toContain('codex turn failed:');
    });

    it('renders a persisted turn failure as an error event row, not as assistant prose', async () => {
        const { MessageView } = await import('./MessageView');
        const messages = projectPersistedRows([
            { id: 'reply', data: { type: 'message', message: 'Hello! How can I help?' } },
            { id: 'failure', data: { type: 'message', message: FAILURE_TEXT }, meta: runtimeMeta },
        ]);
        const failure = messages.find((message) => message.kind === 'agent-text' && message.text === FAILURE_TEXT);
        expect(failure).toBeTruthy();

        const screen = await renderScreen(<MessageView message={failure!} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-event-runtime-issue')).not.toBeNull();
        const { MarkdownView } = await import('@/components/markdown/MarkdownView');
        expect(screen.findAllByType(MarkdownView)).toHaveLength(0);
        expect(screen.getTextContent()).toContain(FAILURE_TEXT);
        const { Icon } = await import('@/components/ui/icons/Icon');
        expect(screen.findAllByType(Icon).some(icon => icon.props.name === 'warning')).toBe(true);
    });

    it('keeps a typed failure\'s raw cause behind Details and says how many identical failures the row stands for', async () => {
        // QA-SESSION-1109 D6: 11 identical "codex turn failed: Provider session failed" rows, no cause, no Details.
        const { MessageView } = await import('./MessageView');
        const { TranscriptRuntimeIssueRepeatCountsContext } = await import('./events/runtimeIssueRepeatProjection');
        const preview = 'Provider session failed';
        const messages = projectPersistedRows([{ id: 'session-failure', data: { type: 'message', message: `codex turn failed: ${preview}` },
            meta: { source: 'runtime', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed',
                code: 'agent_session_error', source: 'agent_session_error', occurredAt: 1_000, sanitizedPreview: preview,
                failureCause: { phase: 'turn', failureReason: 'unknown', requestId: 'req-42' } } } }]);
        const failure = messages[0]!;
        const screen = await renderScreen(<TranscriptRuntimeIssueRepeatCountsContext.Provider value={{ [failure.id]: 11 }}>
            <MessageView message={failure} metadata={null} sessionId="s1" />
        </TranscriptRuntimeIssueRepeatCountsContext.Provider>);
        expect(screen.findByTestId('transcript-event-runtime-issue')).not.toBeNull();
        expect(screen.getTextContent()).toContain('session.transcriptFailureRepeated');
        expect(screen.findHostByTestId('transcript-event-runtime-issue-details-code')).toBeNull();
        await screen.pressByTestIdAsync('transcript-event-runtime-issue-details-toggle');
        const details = screen.findHostByTestId('transcript-event-runtime-issue-details-code');
        expect(details).not.toBeNull();
        expect(screen.getTextContent()).toContain('agent_session_error');
        expect(screen.getTextContent()).toContain('session.startFailure.requestId');
    });

    it('leaves a start failure to the composer notice while it states it, and keeps the row once the Session recovers', async () => {
        // CALM-1110: the same "couldn't start" cause read in a top banner and again as a transcript row.
        const { MessageView } = await import('./MessageView');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { storage } = await import('@/sync/domains/state/storage');
        const issue = { v: 1, scope: 'primary_session', status: 'failed', code: 'agent_startup_model_reconciliation_failed',
            source: 'agent_session_error', occurredAt: 2_000, sanitizedPreview: 'model rejected' } as const;
        const messages = projectPersistedRows([{ id: 'start-failure', data: { type: 'message', message: 'model rejected' },
            meta: { source: 'runtime', runtimeIssueV1: issue } }]);
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: 'home-a', active: false, lastRuntimeIssue: issue })]);
        const screen = await renderScreen(<MessageView message={messages[0]!} metadata={null} sessionId="s1" serverId="home-a" />,
            createTestSessionTranscriptSource({ sessionId: 's1', serverId: 'home-a', messages }));
        expect(screen.findByTestId('transcript-event-runtime-issue')).toBeNull();
        await act(() => { storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: 'home-a', active: true, lastRuntimeIssue: issue })]); });
        expect(screen.findByTestId('transcript-event-runtime-issue')).not.toBeNull();
    });

    it('renders an input rejection the same way', async () => {
        const { MessageView } = await import('./MessageView');
        const rejection = 'custom-acp input rejected: Internal error: Cannot connect to API';
        const messages = projectPersistedRows([
            { id: 'rejection', data: { type: 'message', message: rejection }, meta: { ...runtimeMeta, runtimeIssueCode: 'acp_input_rejected' } },
        ]);
        const screen = await renderScreen(<MessageView message={messages[0]!} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-event-runtime-issue')).not.toBeNull();
    });

    it('keeps ordinary assistant prose, even when it mentions a failure, as a reply', async () => {
        const { MessageView } = await import('./MessageView');
        const messages = projectPersistedRows([
            { id: 'prose', data: { type: 'message', message: FAILURE_TEXT } },
        ]);
        const screen = await renderScreen(<MessageView message={messages[0]!} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-event-runtime-issue')).toBeNull();
    });

    it('highlights counted failure and rejection matches, moves the current mark, and clears marks when Find closes', async () => {
        const { MessageView } = await import('./MessageView');
        const { createTranscriptFindModel } = await import('./find/useTranscriptFind');
        const messages = projectPersistedRows([
            { id: 'failure', data: { type: 'message', message: FAILURE_TEXT }, meta: runtimeMeta },
            { id: 'rejection', data: { type: 'message', message: 'custom-acp input rejected: Cannot connect to API' },
                meta: { ...runtimeMeta, runtimeIssueCode: 'acp_input_rejected' } },
        ]);
        expect(messages.map(message => message.kind)).toEqual(['agent-text', 'agent-text']);
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {},
        });
        const screen = await renderScreen(<TranscriptFindProvider store={model.rowStore}>
            {messages.map(message => <View key={message.id} testID={`issue:${message.realID}`}>
                <MessageView message={message} metadata={null} sessionId="s1" />
            </View>)}
        </TranscriptFindProvider>, createTestSessionTranscriptSource({ messages }));
        const markedText = (id: string, testID: string) => screen.findHostByTestId(`issue:${id}`)!
            .findAll(node => typeof node.type === 'string' && node.props.testID === testID)
            .map(node => node.children.join('')).join('');
        try {
            await act(async () => { model.setQuery('Cannot connect to API'); await model.settled(); });
            expect(model.status).toMatchObject({ current: 1, total: 2 });
            expect(markedText('failure', 'find-match-current')).toBe('Cannot connect to API');
            expect(markedText('rejection', 'find-match-all')).toBe('Cannot connect to API');
            await act(async () => { model.step(1); await model.settled(); });
            expect(markedText('failure', 'find-match-current')).toBe('');
            expect(markedText('failure', 'find-match-all')).toBe('Cannot connect to API');
            expect(markedText('rejection', 'find-match-current')).toBe('Cannot connect to API');
            await act(() => model.close());
            expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(0);
            expect(screen.findAllHostsByTestId('find-match-all')).toHaveLength(0);
        } finally {
            await screen.unmount();
            model.dispose();
        }
    });

    it('shows landing attention only for the addressed failure or rejection, including seq fallback, and expires it', async () => {
        const { MessageView } = await import('./MessageView');
        const messages = projectPersistedRows([
            { id: 'failure', data: { type: 'message', message: FAILURE_TEXT }, meta: runtimeMeta },
            { id: 'rejection', data: { type: 'message', message: 'custom-acp input rejected: Cannot connect to API' },
                meta: { ...runtimeMeta, runtimeIssueCode: 'acp_input_rejected' } },
        ]);
        const screen = await renderScreen(<>
            {messages.map(message => <View key={message.id} testID={`issue:${message.realID}`}>
                <MessageView message={message} metadata={null} sessionId="s1" serverId="prop-home" />
            </View>)}
        </>, createTestSessionTranscriptSource({ sessionId: 's1', serverId: 'home-a', messages }));
        const rings = (id: string) => screen.findHostByTestId(`issue:${id}`)!
            .findAll(node => typeof node.type === 'string' && node.props.testID === 'transcript-jump-highlight');
        vi.useFakeTimers();
        await act(() => applyTranscriptJumpHighlightForJumpResult({ serverId: 'home-b', sessionId: 's1' }, {
            status: 'scrolled', target: { kind: 'route-message-id', routeMessageId: 'server:failure' },
        }));
        expect(screen.findAllHostsByTestId('transcript-jump-highlight')).toHaveLength(0);
        await act(() => applyTranscriptJumpHighlightForJumpResult({ serverId: 'home-a', sessionId: 's1' }, {
            status: 'scrolled', target: { kind: 'route-message-id', routeMessageId: 'server:failure' },
        }));
        expect(rings('failure')).toHaveLength(1);
        expect(rings('rejection')).toHaveLength(0);
        await act(() => applyTranscriptJumpHighlightForJumpResult({ serverId: 'home-a', sessionId: 's1' }, {
            status: 'window-rendered', target: { kind: 'seq', seq: 2 }, windowId: 'issues',
        }));
        expect(rings('failure')).toHaveLength(0);
        expect(rings('rejection')).toHaveLength(1);
        // The cue's duration starts once the landed row paints it (one frame).
        await act(() => { vi.advanceTimersToNextFrame(); vi.advanceTimersByTime(TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS); });
        expect(screen.findAllHostsByTestId('transcript-jump-highlight')).toHaveLength(0);
    });
});
