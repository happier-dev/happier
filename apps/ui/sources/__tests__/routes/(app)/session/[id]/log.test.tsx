import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionReadLogTailMock = vi.fn(async (_sessionId?: string, _options?: unknown) => ({
    success: true,
    path: '/tmp/.happier/logs/session.log',
    tail: 'tail line',
}));

let sessionLogPath: string | null = null;

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'ios')
                        ? (spec as Record<string, unknown> & { ios?: unknown }).ios
                        : (spec as Record<string, unknown> & { default?: unknown }).default,
            },
        });
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Boundary fixture: this route only reads `metadata.sessionLogPath` from the session object.
                useSession: (() =>
                    (sessionLogPath
                        ? {
                              id: 'session-1',
                              metadata: { sessionLogPath },
                          }
                        : {
                              id: 'session-1',
                              metadata: null,
                          }) as unknown) as typeof import('@/sync/domains/state/storage')['useSession'],
                useIsDataReady: () => true,
            },
        });
    },
});

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

vi.mock('@/sync/ops', () => ({
    sessionReadLogTail: (sessionId: string, options?: unknown) => sessionReadLogTailMock(sessionId, options),
}));

describe('Session log screen', () => {
    beforeEach(() => {
        sessionLogPath = null;
        sessionReadLogTailMock.mockClear();
    });

    it('does not fetch log tail when log path is unavailable', async () => {
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(sessionReadLogTailMock).not.toHaveBeenCalled();
    });

    it('fetches session log tail when log path exists', async () => {
        sessionLogPath = '/tmp/.happier/logs/session.log';
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(sessionReadLogTailMock).toHaveBeenCalledWith('session-1', { maxBytes: 200000 });
    });
});
