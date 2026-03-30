import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('react-native-reanimated', () => ({
    default: { View: (props: any) => React.createElement('Animated.View', props) },
    useSharedValue: (init: any) => ({ value: init }),
    useAnimatedStyle: (fn: () => any) => fn(),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const routerPushSpy = vi.fn();
const setPinnedSessionKeysV1 = vi.fn();
const setSessionListGroupOrderV1 = vi.fn();
const setSessionTagsV1 = vi.fn();
const recoveryBannerMountSpy = vi.fn();
const recoveryBannerUnmountSpy = vi.fn();

let pinnedSessionKeysV1: string[] = [];
let sessionListGroupOrderV1: Record<string, string[]> = {};
let sessionTagsV1: Record<string, string[]> = {};

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ...rest }: any) =>
                React.createElement(
                    'FlatList',
                    { ...rest },
                    ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
                    (data ?? []).map((item: any, index: number) => {
                        const key = keyExtractor ? keyExtractor(item, index) : String(index);
                        return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
                    }),
                ),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPushSpy, replace: vi.fn(), back: vi.fn() },
            pathname: '',
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => [],
        useSetting: (key: string) => {
            if (key === 'compactSessionView') return false;
            if (key === 'compactSessionViewMinimal') return false;
            if (key === 'sessionTagsEnabled') return true;
            return null;
        },
        useSettingMutable: (key: string) => {
            if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
            if (key === 'sessionListGroupOrderV1') return [sessionListGroupOrderV1, setSessionListGroupOrderV1];
            if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
            return [null, vi.fn()];
        },
    }),
});

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: () => {
        React.useEffect(() => {
            recoveryBannerMountSpy();
            return () => {
                recoveryBannerUnmountSpy();
            };
        }, []);
        return React.createElement('RecoveryKeyReminderBanner');
    },
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    formatPathRelativeToHome: (path: string) => path,
}));

const useSessionInlineDragSpy = vi.hoisted(() => vi.fn((params: any) => ({ gesture: undefined, animatedStyle: params ? {} : {} })));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: ['server_a'],
    }),
}));

const groupKey = 'server:server_a:day:2026-02-17';
const sessionA = { id: 'sess_a', createdAt: 1, active: true, presence: 'online', metadata: { host: 'h', path: '/p', homeDir: '/h' } } as any;
const sessionB = { id: 'sess_b', createdAt: 2, active: true, presence: 'online', metadata: { host: 'h', path: '/p', homeDir: '/h' } } as any;
const mockVisibleSessionListViewData: any[] = [
    { type: 'header', title: 'Today', headerKind: 'date', groupKey, serverId: 'server_a', serverName: 'Server A' },
    { type: 'session', session: sessionA, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
    { type: 'session', session: sessionB, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
];

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => mockVisibleSessionListViewData,
}));

const requestReviewSpy = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/requestReview', () => ({
    requestReview: requestReviewSpy,
}));

vi.mock('./useSessionInlineDrag', () => ({
    useSessionInlineDrag: (params: any) => useSessionInlineDragSpy(params),
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', props),
}));

describe('SessionsList (inline reorder)', () => {
    it('does not trigger store-review prompts automatically when the list renders', async () => {
        requestReviewSpy.mockClear();
        const { SessionsList } = await import('./SessionsList');

        await renderScreen(<SessionsList />);

        expect(requestReviewSpy).not.toHaveBeenCalled();
    });

    it('renders SessionItem rows with reorder drag props', async () => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};
        useSessionInlineDragSpy.mockClear();

        const { SessionsList } = await import('./SessionsList');

        const screen = await renderScreen(<SessionsList />);

        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items.length).toBe(2);
        // reorderHandleGesture is passed from SessionListRow.
        // reorderDragStyle is no longer passed (Animated.View is in SessionListRow).
        expect(items[0].props).toHaveProperty('reorderHandleGesture');
        // isBeingDragged is passed from SessionListRow
        expect(items[0].props.isBeingDragged).toBe(false);
        expect(useSessionInlineDragSpy).toHaveBeenCalledWith(expect.objectContaining({ rowHeight: 84 }));
    });

    it('keeps the recovery banner mounted across SessionsList rerenders', async () => {
        recoveryBannerMountSpy.mockClear();
        recoveryBannerUnmountSpy.mockClear();

        const { SessionsList } = await import('./SessionsList');
        const screen = await renderScreen(<SessionsList />);

        expect(recoveryBannerMountSpy).toHaveBeenCalledTimes(1);
        expect(recoveryBannerUnmountSpy).not.toHaveBeenCalled();

        await screen.update(<SessionsList />);

        expect(recoveryBannerMountSpy).toHaveBeenCalledTimes(1);
        expect(recoveryBannerUnmountSpy).not.toHaveBeenCalled();
    });
});
