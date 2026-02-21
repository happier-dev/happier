import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionReadLogTailMock = vi.fn(async (_sessionId?: string, _options?: unknown) => ({
    success: true,
    path: '/tmp/.happier/logs/session.log',
    tail: 'tail line',
}));

let devModeEnabled = false;
let sessionLogPath: string | null = null;

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: 'session-1' }),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    Platform: {
        OS: 'ios',
        select: (spec: Record<string, unknown>) =>
            spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
    },
}));

vi.mock('@expo/vector-icons', async () => {
    const Ionicons = (props: any) => React.createElement('Ionicons', props);
    return { Ionicons };
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code }: { code: string }) => React.createElement('CodeView', { code }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () =>
        sessionLogPath
            ? {
                id: 'session-1',
                metadata: { sessionLogPath },
            }
            : {
                id: 'session-1',
                metadata: null,
            },
    useLocalSetting: (name: string) => (name === 'devModeEnabled' ? devModeEnabled : null),
    useIsDataReady: () => true,
}));

vi.mock('@/sync/ops', () => ({
    sessionReadLogTail: (sessionId: string, options?: unknown) => sessionReadLogTailMock(sessionId, options),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('Session log screen', () => {
    beforeEach(() => {
        devModeEnabled = false;
        sessionLogPath = null;
        sessionReadLogTailMock.mockClear();
    });

    it('does not fetch log tail when developer mode is disabled', async () => {
        const { default: SessionLogScreen } = await import('./log');

        await act(async () => {
            renderer.create(React.createElement(SessionLogScreen));
        });

        expect(sessionReadLogTailMock).not.toHaveBeenCalled();
    });

    it('fetches session log tail when developer mode is enabled and log path exists', async () => {
        devModeEnabled = true;
        sessionLogPath = '/tmp/.happier/logs/session.log';
        const { default: SessionLogScreen } = await import('./log');

        await act(async () => {
            renderer.create(React.createElement(SessionLogScreen));
        });

        expect(sessionReadLogTailMock).toHaveBeenCalledWith('session-1', { maxBytes: 200000 });
    });
});
