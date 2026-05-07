import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AgentTextMessage } from '@/sync/domains/messages/messageTypes';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const buildChatListItemsCachedSpy = vi.hoisted(() => vi.fn((_args: unknown) => ({ cache: null, items: [] })));
const preloadEnrichedMarkdownRuntimeSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: () => [],
    buildChatListItemsCached: (args: unknown) => buildChatListItemsCachedSpy(args),
}));

vi.mock('@/components/markdown/enriched/preloadEnrichedMarkdownRuntime', () => ({
    preloadEnrichedMarkdownRuntime: preloadEnrichedMarkdownRuntimeSpy,
}));

vi.mock('@shopify/flash-list', () => ({
    FlashList: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function installSwrFallbackMocks(params: { transcriptLoaded: boolean }) {
    installTranscriptCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock();
        },
        storage: async () => {
            const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');

            const cachedMessage: AgentTextMessage = {
                kind: 'agent-text',
                id: 'm1',
                localId: null,
                createdAt: 1,
                text: 'hello',
            };

            return createStorageModuleStub({
                useSession: () => null,
                useSessionTranscriptIds: () => ({ ids: [], isLoaded: params.transcriptLoaded }),
                useSessionMessagesById: () => ({}),
                useSessionMessages: () => ({ messages: [cachedMessage], isLoaded: params.transcriptLoaded }),
                useForkedTranscriptSnapshot: () => null,
                useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: false }),
                useSessionActionDrafts: () => ([]),
                useSessionLatestThinkingMessageId: () => null,
                useSessionLatestThinkingMessageActivityAtMs: () => null,
                useMessage: () => null,
                useSetting: (key: string) => {
                    if (key === 'transcriptListImplementation') return 'flatlist_legacy';
                    if (key === 'transcriptGroupingMode') return 'linear';
                    if (key === 'transcriptGroupToolCalls') return false;
                    if (key === 'transcriptTurnToolCallsGroupStrategy') return 'consecutive_tools';
                    if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
                    return null;
                },
            });
        },
    });
}

describe('ChatList (SWR fallback)', () => {
    afterEach(() => {
        resetTranscriptCommonModuleMockState();
        buildChatListItemsCachedSpy.mockClear();
        preloadEnrichedMarkdownRuntimeSpy.mockClear();
        vi.resetModules();
    });

    it('preloads the enriched markdown runtime when the transcript mounts', async () => {
        installSwrFallbackMocks({ transcriptLoaded: false });
        const { ChatList } = await import('./ChatList');

        const session = {
            id: 'session-1',
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
        } as any;

        await renderScreen(<ChatList session={session} />);

        expect(preloadEnrichedMarkdownRuntimeSpy).toHaveBeenCalledOnce();
    });

    it('uses the SWR messages array when transcript ids are empty during a refresh', async () => {
        installSwrFallbackMocks({ transcriptLoaded: false });
        const { ChatList } = await import('./ChatList');

        const session = {
            id: 'session-1',
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
        } as any;

        await renderScreen(<ChatList session={session} />);

        expect(buildChatListItemsCachedSpy).toHaveBeenCalled();
        const call = (buildChatListItemsCachedSpy.mock.calls[0] as any)?.[0];
        expect(call?.messageIdsOldestFirst).toEqual(['m1']);
        expect(call?.messagesById?.m1).toMatchObject({ id: 'm1', kind: 'agent-text' });
    });

    it('uses the SWR messages array when transcript ids are empty but the transcript is incorrectly marked loaded', async () => {
        installSwrFallbackMocks({ transcriptLoaded: true });
        const { ChatList } = await import('./ChatList');

        const session = {
            id: 'session-1',
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
        } as any;

        await renderScreen(<ChatList session={session} />);

        expect(buildChatListItemsCachedSpy).toHaveBeenCalled();
        const call = (buildChatListItemsCachedSpy.mock.calls[0] as any)?.[0];
        expect(call?.messageIdsOldestFirst).toEqual(['m1']);
        expect(call?.messagesById?.m1).toMatchObject({ id: 'm1', kind: 'agent-text' });
    });
});
