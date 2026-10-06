import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit';
import { installTerminalRouteCommonModuleMocks, initializeTerminalRouteRuntimeForTests, renderTerminalRoute } from './terminalRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTerminalRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: vi.fn(), replace: vi.fn() },
            params: { key: 'abc123', server: 'https://example.test' },
        }).module;
    },
});

await initializeTerminalRouteRuntimeForTests();

afterEach(() => {
    standardCleanup();
});

describe('TerminalScreen authenticated buttons', () => {
    beforeEach(async () => {
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
    });

    it('exposes stable testIDs for approve/reject buttons on /terminal', async () => {
        const Screen = (await import('@/app/(app)/terminal/index')).default;

        const screen = await renderTerminalRoute(Screen);
        await act(async () => {});

        expect(screen.findByTestId('terminal-connect-surface-card')).toBeTruthy();
        expect(screen.findByTestId('terminal-connect-approve')).toBeTruthy();
        expect(screen.findByTestId('terminal-connect-reject')).toBeTruthy();
    });
});
