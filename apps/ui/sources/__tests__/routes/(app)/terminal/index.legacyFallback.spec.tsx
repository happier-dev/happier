import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installTerminalRouteCommonModuleMocks, initializeTerminalRouteRuntimeForTests, renderTerminalRoute } from './terminalRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackMock = vi.fn();
const localSearchParamsMock = vi.fn((): Record<string, string> => ({ server: 'https://example.test' }));
const routerMock = createTerminalRouterMock();

function createTerminalRouterMock() {
    return createExpoRouterMock({
        router: { back: routerBackMock },
        params: () => localSearchParamsMock(),
    });
}

installTerminalRouteCommonModuleMocks({
    router: () => routerMock.module,
});

await initializeTerminalRouteRuntimeForTests();

describe('TerminalScreen legacy deep-link fallback', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(async () => {
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
        routerBackMock.mockClear();
        localSearchParamsMock.mockReset();
        localSearchParamsMock.mockReturnValue({ server: 'https://example.test' });
    });

    it('does not treat known params like server as a legacy public key', async () => {
        const Screen = (await import('@/app/(app)/terminal/index')).default;
        routerMock.state.params = localSearchParamsMock();

        const screen = await renderTerminalRoute(Screen);
        await act(async () => {});

        expect(screen.getTextContent()).toContain('terminal.invalidConnectionLink');
    });

    it('uses legacy fallback when exactly one unknown search param key is present', async () => {
        localSearchParamsMock.mockReturnValue({ abcdefghijklmnop: '' });
        const Screen = (await import('@/app/(app)/terminal/index')).default;
        routerMock.state.params = localSearchParamsMock();

        const screen = await renderTerminalRoute(Screen);
        await act(async () => {});

        expect(screen.findByTestId('terminal-connect-surface-card')).toBeTruthy();
        expect(screen.findByTestId('terminal-connect-approve')).toBeTruthy();
        expect(screen.getTextContent()).toContain('abcdefghijkl...');
    });

    it('rejects partial authenticated-pairing parameters through the canonical parser', async () => {
        localSearchParamsMock.mockReturnValue({ key: 'abc', pairingSecret: 'secret' });
        const Screen = (await import('@/app/(app)/terminal/index')).default;
        routerMock.state.params = localSearchParamsMock();

        const screen = await renderTerminalRoute(Screen);
        await act(async () => {});

        expect(screen.getTextContent()).toContain('terminal.invalidConnectionLink');
        expect(screen.findByTestId('terminal-connect-approve')).toBeNull();
    });
});
