import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, findGestureByKind, renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

// No local `react-native-reanimated` mock: `dev/vitestSetup.ts` already installs the canonical
// `createReanimatedModuleMock()`, which is a superset of the seven exports this file used to
// restate. The partial copy overrode it, so the first production module to read an export it
// omitted — the spring vocabulary's `ReduceMotion` — failed the whole file at collection.

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
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

vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/sessions/sessionUtils')>(),
    formatPathRelativeToHome: (path: string) => path,
}));

const selectedServerIds = vi.hoisted(() => ['server_a']);

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => ({
        serverIds: selectedServerIds,
    }),
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: selectedServerIds,
    }),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
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

        const { SessionsList } = await import('./SessionsList');

        const screen = await renderScreen(<SessionsList />);

        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items.length).toBe(2);
        // reorderHandleGesture is passed from SessionListRow.
        // reorderDragStyle is no longer passed (Animated.View is in SessionListRow).
        expect(items[0].props).toHaveProperty('reorderHandleGesture');
        expect(findGestureByKind(items[0].props.reorderHandleGesture, 'pan')).toBeTruthy();
        // isBeingDragged is passed from SessionListRow
        expect(items[0].props.isBeingDragged).toBe(false);
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
