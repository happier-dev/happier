import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useLocalSearchParamsMock = vi.fn();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock();
    return {
        ...expoRouterMock.module,
        useLocalSearchParams: () => useLocalSearchParamsMock(),
    };
});

describe('legacy automation picker route', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('redirects to the inline new-session automation flow and preserves automation params', async () => {
        useLocalSearchParamsMock.mockReturnValue({
            automationEnabled: '1',
            automationName: 'Legacy',
            automationDescription: 'Carry this over',
            automationScheduleKind: 'interval',
            automationEveryMinutes: '90',
            automationCronExpr: '0 * * * *',
            automationTimezone: 'Europe/Zurich',
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        });

        const module = await import('@/app/(app)/new/pick/automation');

        const screen = await renderScreen(React.createElement(module.default));

        const redirect = screen.findByType('Redirect' as any);
        expect(redirect.props.href).toEqual({
            pathname: '/new',
            params: {
                automation: '1',
                automationEnabled: '1',
                automationName: 'Legacy',
                automationDescription: 'Carry this over',
                automationScheduleKind: 'interval',
                automationEveryMinutes: '90',
                automationCronExpr: '0 * * * *',
                automationTimezone: 'Europe/Zurich',
                draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            },
        });
    });

    it('allocates an explicit identity when a legacy picker route has none', async () => {
        useLocalSearchParamsMock.mockReturnValue({ automationName: 'Legacy' });

        const module = await import('@/app/(app)/new/pick/automation');
        const screen = await renderScreen(React.createElement(module.default));

        expect(screen.findByType('Redirect' as any).props.href).toEqual({
            pathname: '/new',
            params: {
                automation: '1',
                automationName: 'Legacy',
                draftId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            },
        });
    });
});
