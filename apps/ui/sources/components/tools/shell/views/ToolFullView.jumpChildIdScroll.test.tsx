import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    findTestInstanceByTypeWithProps,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
        loadOlderSidechainMessages: vi.fn(),
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
        }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                        View: 'View',
                                                        Text: 'Text',
                                                        Pressable: 'Pressable',
                                                        ScrollView: 'ScrollView',
                                                        Platform: { OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null },
                                                        useWindowDimensions: () => ({ width: 800, height: 600 }),
                                                    }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: () => false,
            useSessionTranscriptDraftMessages: () => [],
        },
    }));

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/shell/presentation/resolveToolHeaderTextPresentation', () => ({
    resolveToolHeaderTextPresentation: () => ({
        normalizedToolName: 'Task',
        title: 'Task',
        subtitle: null,
        statusText: null,
    }),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => React.createElement('MessageView', props),
}));

vi.mock('@/components/sessions/transcript/ChainTranscriptList', () => ({
    ChainTranscriptList: (props: any) => React.createElement('ChainTranscriptList', props, props.footer),
}));

describe('ToolFullView (jumpChildId)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('scrolls to the child message when jumpChildId is provided', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const messages: Message[] = [
            {
                kind: 'tool-call',
                id: 'child-1',
                localId: null,
                createdAt: Date.now(),
                tool: makeToolCall({ name: 'edit' }),
                children: [],
            },
            {
                kind: 'tool-call',
                id: 'child-2',
                localId: null,
                createdAt: Date.now(),
                tool: makeToolCall({ name: 'edit' }),
                children: [],
            },
        ];

        const screen = await renderScreen(React.createElement(ToolFullView, {
            tool: makeToolCall({ name: 'Task' }),
            sessionId: 's1',
            metadata: null,
            messages,
            jumpChildId: 'child-2',
        }));

        expect(findTestInstanceByTypeWithProps(screen, 'ChainTranscriptList', {
            jumpToMessageId: 'child-2',
        })).toBeTruthy();
    });
});
