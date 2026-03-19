import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useLocalSearchParamsMock = vi.fn();

vi.mock('expo-router', () => ({
    Redirect: (props: any) => React.createElement('Redirect', props),
    useLocalSearchParams: () => useLocalSearchParamsMock(),
}));

describe('legacy automation picker route', () => {
    it('redirects to the inline new-session automation flow and preserves automation params', async () => {
        useLocalSearchParamsMock.mockReturnValue({
            automationEnabled: '1',
            automationName: 'Legacy',
            automationDescription: 'Carry this over',
            automationScheduleKind: 'interval',
            automationEveryMinutes: '90',
            automationCronExpr: '0 * * * *',
            automationTimezone: 'Europe/Zurich',
        });

        const module = await import('@/app/(app)/new/pick/automation');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(module.default));
        });

        const redirect = tree.root.findByType('Redirect');
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
            },
        });
    });
});
