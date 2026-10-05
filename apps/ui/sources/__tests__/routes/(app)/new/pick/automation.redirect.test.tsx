import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useLocalSearchParamsMock = vi.fn();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        params: useLocalSearchParamsMock(),
    });
    return expoRouterMock.module;
});

describe('legacy automation picker route', () => {
    afterEach(() => {
        standardCleanup();
        vi.resetModules();
    });

    it('reaches canonical Workflow authoring instead of a second inline authoring surface', async () => {
        useLocalSearchParamsMock.mockReturnValue({
            automationEnabled: '1',
            automationName: 'Legacy',
            automationScheduleKind: 'interval',
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        });

        const module = await import('@/app/(app)/new/pick/automation');
        const screen = await renderScreen(React.createElement(module.default));

        const redirect = screen.findByType('Redirect' as any);
        // The old destination forced New Session into an Automation entry and
        // manufactured a fresh inline draft that reached the retained one-shot
        // writer directly, bypassing the trigger editor and its save owner.
        expect(redirect.props.href).toEqual({ pathname: '/workflows/new' });
    });

    it('carries no prompt, setting or manufactured draft in the URL', async () => {
        useLocalSearchParamsMock.mockReturnValue({});

        const module = await import('@/app/(app)/new/pick/automation');
        const screen = await renderScreen(React.createElement(module.default));

        const redirect = screen.findByType('Redirect' as any);
        expect(redirect.props.href).toEqual({ pathname: '/workflows/new' });
    });
});
