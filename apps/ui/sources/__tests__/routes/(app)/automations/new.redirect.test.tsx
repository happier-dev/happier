import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useAutomationsSupportMock = vi.fn();
const routerReplaceMock = vi.fn();

vi.mock('expo-router', () => ({
    useRouter: () => ({
        replace: routerReplaceMock,
    }),
}));

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

        await act(async () => {
            renderer.create(React.createElement(module.default));
        });

        expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it('redirects to the shared new-session composer with automation intent params when automations are enabled', async () => {
        useAutomationsSupportMock.mockReturnValue({ enabled: true, loading: false });
        const module = await import('@/app/(app)/automations/new');

        await act(async () => {
            renderer.create(React.createElement(module.default));
        });

        expect(routerReplaceMock).toHaveBeenCalledWith('/new?automation=1');
    });

    it('redirects to the plain new-session route when automations are unavailable', async () => {
        useAutomationsSupportMock.mockReturnValue({ enabled: false, loading: false });
        const module = await import('@/app/(app)/automations/new');

        await act(async () => {
            renderer.create(React.createElement(module.default));
        });

        expect(routerReplaceMock).toHaveBeenCalledWith('/new');
    });
});
