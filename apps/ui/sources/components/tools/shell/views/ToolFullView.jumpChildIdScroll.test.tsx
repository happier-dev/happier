import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { Message, ToolCall, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let scrollToSpy: ReturnType<typeof vi.fn> | null = null;
let scrollToIndexSpy: ReturnType<typeof vi.fn> | null = null;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
        loadOlderSidechainMessages: vi.fn(),
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
        }),
    },
}));

vi.mock('@shopify/flash-list', async () => {
    const React = await vi.importActual<any>('react');

    scrollToIndexSpy = vi.fn();

    const FlashList = React.forwardRef(function FlashList(props: any, ref: any) {
        const instance = React.useMemo(
            () => ({
                scrollToIndex: scrollToIndexSpy,
                scrollToEnd: vi.fn(),
                scrollToOffset: vi.fn(),
            }),
            [],
        );

        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;

        return React.createElement('FlashList', props, props.children);
    });

    return { FlashList };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<any>('react-native');
    const React = await vi.importActual<any>('react');

    scrollToSpy = vi.fn();

    const ScrollView = React.forwardRef(function ScrollView(props: any, ref: any) {
        React.useImperativeHandle(ref, () => ({
            scrollTo: scrollToSpy,
        }), []);
        return React.createElement('ScrollView', props, props.children);
    });

    return {
        ...actual,
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        ScrollView,
        Platform: { OS: 'ios', select: (v: any) => v.ios },
        useWindowDimensions: () => ({ width: 800, height: 600 }),
    };
});

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => false,
    useSetting: () => false,
    useSessionTranscriptDraftMessages: () => [],
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

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

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
    const now = Date.now();
    return {
        name: 'Task',
        state: 'completed',
        input: {},
        createdAt: now,
        startedAt: now,
        completedAt: now,
        description: null,
        ...overrides,
    };
}

function makeToolCallMessage(id: string): ToolCallMessage {
    const now = Date.now();
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: now,
        tool: makeToolCall({ name: 'edit' }),
        children: [],
    };
}

describe('ToolFullView (jumpChildId)', () => {
    it('scrolls to the child message when jumpChildId is provided', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const messages: Message[] = [makeToolCallMessage('child-1'), makeToolCallMessage('child-2')];

        await act(async () => {
            renderer.create(
                React.createElement(ToolFullView, {
                    tool: makeToolCall({}),
                    sessionId: 's1',
                    metadata: null,
                    messages,
                    jumpChildId: 'child-2',
                }),
            );
            await Promise.resolve();
        });
        expect(scrollToIndexSpy).not.toBeNull();
        expect(scrollToIndexSpy!).toHaveBeenCalledWith(expect.objectContaining({ index: 1, animated: true }));
    });
});
