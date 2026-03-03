import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let capturedPressables: any[] = [];
vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ...rest }: any) => {
            return React.createElement(
                'FlatList',
                { ...rest },
                ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
                (data ?? []).map((item: any, index: number) => {
                    const key = keyExtractor ? keyExtractor(item, index) : String(index);
                    return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
                }),
            );
        },
    };
});

vi.mock('expo-router', () => ({
    usePathname: () => '',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

let pinnedSessionKeysV1: string[] = [];
const setPinnedSessionKeysV1 = vi.fn();
let sessionListGroupOrderV1: Record<string, string[]> = {};
const setSessionListGroupOrderV1 = vi.fn();
let sessionTagsV1: Record<string, string[]> = {};
const setSessionTagsV1 = vi.fn();

vi.mock('@/sync/domains/state/storage', () => ({
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
}));

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

vi.mock('./SessionGroupDragList', () => ({
    SessionGroupDragList: 'SessionGroupDragList',
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', props),
}));

describe('SessionsList (reorder mode)', () => {
    it('does not trigger store-review prompts automatically when the list renders', async () => {
        requestReviewSpy.mockClear();
        const { SessionsList } = await import('./SessionsList');

        await act(async () => {
            renderer.create(<SessionsList />);
        });

        expect(requestReviewSpy).not.toHaveBeenCalled();
    });

    it('enters reorder mode from a row handle and exits after a reorder completes', async () => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};
        setSessionListGroupOrderV1.mockClear();

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        expect((tree as any).root.findAllByType('SessionGroupDragList')).toHaveLength(0);

        const items = (tree as any).root.findAllByType('SessionItem');
        expect(items.length).toBeGreaterThan(0);
        expect(typeof items[0]?.props?.onRequestReorder).toBe('function');

        await act(async () => {
            items[0].props.onRequestReorder();
        });
        expect((tree as any).root.findAllByType('SessionGroupDragList')).toHaveLength(1);

        await act(async () => {
            const group = (tree as any).root.findByType('SessionGroupDragList');
            group.props.onReorderKeys(['server_a:sess_b', 'server_a:sess_a']);
        });
        expect((tree as any).root.findAllByType('SessionGroupDragList')).toHaveLength(0);
        expect(setSessionListGroupOrderV1).toHaveBeenCalledTimes(1);

        const itemsAfter = (tree as any).root.findAllByType('SessionItem');
        expect(itemsAfter.length).toBeGreaterThan(0);

        await act(async () => {
            itemsAfter[0].props.onRequestReorder();
        });
        expect((tree as any).root.findAllByType('SessionGroupDragList')).toHaveLength(1);
    });
});
