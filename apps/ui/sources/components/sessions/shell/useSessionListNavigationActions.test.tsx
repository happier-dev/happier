import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const routerPushSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

describe('useSessionListNavigationActions', () => {
    it('routes project create-session actions into a prefilled new-session flow', async () => {
        const { useSessionListNavigationActions } = await import('./useSessionListNavigationActions');
        const hook = await renderHook(() => useSessionListNavigationActions());

        await act(async () => {
            hook.getCurrent().handleCreateSessionFromWorkspaceScope({
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
            });
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine_a',
                directory: '/repo',
                spawnServerId: 'server_a',
            },
        });

        await hook.unmount();
    });
});
