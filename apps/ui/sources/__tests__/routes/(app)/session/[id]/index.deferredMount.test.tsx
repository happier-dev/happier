import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from '../../../routeRootTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scheduled: Array<() => void> = [];
const cancelSpy = vi.fn();

installRouteRootCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            InteractionManager: {
                runAfterInteractions: (cb: () => void) => {
                    scheduled.push(cb);
                    return { cancel: cancelSpy };
                },
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            params: { id: 's1' },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: { getState: () => ({ sessions: {} }) } as any,
            },
        });
    },
});

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: any) => React.createElement('SessionView', props),
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => null,
}));

describe('session/[id] route', () => {
    afterEach(() => {
        scheduled.length = 0;
        vi.resetModules();
        cancelSpy.mockClear();
    });

    it('defers mounting SessionView on native to keep navigation snappy', async () => {
        const Route = (await import('@/app/(app)/session/[id]')).default;

        const screen = await renderScreen(<Route />);

        expect(screen.findAllByType('SessionView' as any)).toHaveLength(0);
        expect(scheduled).toHaveLength(1);

        await act(async () => {
            scheduled[0]!();
        });

        expect(screen.findAllByType('SessionView' as any)).toHaveLength(1);
    });
});
