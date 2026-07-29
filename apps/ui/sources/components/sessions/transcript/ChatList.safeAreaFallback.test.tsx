import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
        setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

let capturedHeaderSpacerHeight: number | null = null;

function unwrapStyle(style: unknown): Record<string, unknown> | null {
    if (!style) return null;
    if (Array.isArray(style)) {
        for (const entry of style) {
            const resolved = unwrapStyle(entry);
            if (resolved) return resolved;
        }
        return null;
    }
    return typeof style === 'object' ? (style as Record<string, unknown>) : null;
}

function extractFirstNumericHeight(node: unknown): number | null {
    if (!node || typeof node !== 'object') return null;
    const element = node as { type?: unknown; props?: any };
    const style = unwrapStyle(element.props?.style);
    const height = style?.height;
    if (typeof height === 'number') return height;
    const children = React.Children.toArray(element.props?.children ?? []);
    for (const child of children) {
        const found = extractFirstNumericHeight(child);
        if (typeof found === 'number') return found;
    }
    return null;
}

function renderReactElementCandidate(candidate: unknown): React.ReactNode {
    if (!candidate || typeof candidate !== 'object') return candidate as any as React.ReactNode;
    const element = candidate as any;
    if (typeof element.type === 'function') {
        return element.type(element.props) as React.ReactNode;
    }
    if (typeof element.type === 'object' && typeof element.type.type === 'function') {
        return element.type.type(element.props) as React.ReactNode;
    }
    return candidate as React.ReactNode;
}

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (values: any) => values?.ios ?? values?.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => null,
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useForkedTranscriptSnapshot: () => null,
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
            useSessionActionDrafts: () => ([]),
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useMessage: () => null,
            useSetting: () => undefined,
        });
    },
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 40,
}));

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((props: any, ref: any) => {
        const instance = {
            getState: () => ({
                contentLength: 0,
                isAtEnd: true,
                isNearEnd: true,
                isWithinMaintainScrollAtEndThreshold: true,
                positionAtIndex: () => 0,
                scroll: 0,
                scrollLength: 0,
                sizeAtIndex: () => 120,
            }),
            scrollToEnd: () => Promise.resolve(),
            scrollToIndex: () => Promise.resolve(),
            scrollToOffset: () => Promise.resolve(),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        // The visual-top slot on a newest-first frame is ListHeaderComponent; probe both slots
        // for the transcript gutter spacer height.
        for (const slot of [props.ListHeaderComponent, props.ListFooterComponent]) {
            const rendered = renderReactElementCandidate(slot ?? null);
            const height = extractFirstNumericHeight(rendered);
            if (typeof height === 'number' && capturedHeaderSpacerHeight === null) {
                capturedHeaderSpacerHeight = height;
            }
        }
        return React.createElement('LegendList', props);
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 22, bottom: 0, left: 0, right: 0 } },
}));

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: () => [],
    buildChatListItemsCached: () => ({ cache: null, items: [] }),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnView'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

describe('ChatList safe area', () => {
    beforeEach(() => {
        capturedHeaderSpacerHeight = null;
    });

    afterEach(() => {
        resetTranscriptCommonModuleMockState();
    });

    it('uses a compact transcript gutter instead of chrome-safe area inside the list header', async () => {
        const { ChatList } = await import('./ChatList');

        const session = {
            id: 'session-1',
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
            active: true,
            presence: null,
            agentState: null,
            thinking: null,
        } as any;

        await renderScreen(<ChatList session={session} />);
        expect(capturedHeaderSpacerHeight).toBe(12);
    });
});
