import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useAutomationsSupportMock = vi.fn();
const routerReplaceMock = vi.fn();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: {
        replace: routerReplaceMock,
    },
    });
    return routerMock.module;
});

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => useAutomationsSupportMock(),
}));

describe('/automations/new redirect', () => {
    beforeEach(() => {
        routerReplaceMock.mockReset();
    });

    it('waits for automations support to resolve before redirecting', async () => {
        useAutomationsSupportMock.mockReturnValue({ enabled: false, loading: true });
        const module = await import('@/app/(app)/automations/new');

        await renderScreen(React.createElement(module.default));

        expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it('redirects to the shared new-session composer with automation intent params when automations are enabled', async () => {
        useAutomationsSupportMock.mockReturnValue({ enabled: true, loading: false });
        const module = await import('@/app/(app)/automations/new');

        await renderScreen(React.createElement(module.default));

        expect(routerReplaceMock).toHaveBeenCalledWith('/new?automation=1');
    });

    it('redirects to the plain new-session route when automations are unavailable', async () => {
        useAutomationsSupportMock.mockReturnValue({ enabled: false, loading: false });
        const module = await import('@/app/(app)/automations/new');

        await renderScreen(React.createElement(module.default));

        expect(routerReplaceMock).toHaveBeenCalledWith('/new');
    });
});
