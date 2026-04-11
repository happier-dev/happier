import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

let routeParams: Record<string, string | string[] | undefined> = {
    period: '7days',
    metric: 'cost',
    costMode: 'reported',
    focusDimension: 'model',
    focusKey: 'gpt-5',
    focusLabel: 'GPT-5',
};

const routerMock = createExpoRouterMock({
    router: {
        back: vi.fn(),
        push: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

vi.mock('expo-router', () => ({
    ...routerMock.module,
    useLocalSearchParams: () => routeParams,
    useGlobalSearchParams: () => routeParams,
}));

vi.mock('@/components/settings/usage/UsagePanel', () => ({
    UsagePanel: (props: Record<string, unknown>) => React.createElement('UsagePanel', props),
}));

describe('/settings/usage', () => {
    let Screen: React.ComponentType<any>;

    beforeAll(async () => {
        Screen = (await import('@/app/(app)/settings/usage')).default;
    }, 60_000);

    beforeEach(() => {
        routeParams = {
            period: '7days',
            metric: 'cost',
            costMode: 'reported',
            focusDimension: 'model',
            focusKey: 'gpt-5',
            focusLabel: 'GPT-5',
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('passes initial usage filters from the settings route search params into UsagePanel', async () => {
        const screen = await renderScreen(<Screen />);
        const panel = screen.findByType('UsagePanel' as never);

        expect(panel.props.initialFilters).toEqual({
            period: '7days',
            metric: 'cost',
            costMode: 'reported',
            focus: {
                dimension: 'model',
                key: 'gpt-5',
                label: 'GPT-5',
            },
        });
    });

    it('drops invalid focus params instead of passing a malformed focus object', async () => {
        routeParams = {
            period: 'today',
            metric: 'tokens',
            costMode: 'auto',
            focusDimension: 'invalid-dimension',
            focusKey: 'gpt-5',
            focusLabel: 'GPT-5',
        };

        const screen = await renderScreen(<Screen />);
        const panel = screen.findByType('UsagePanel' as never);

        expect(panel.props.initialFilters).toEqual({
            period: 'today',
            metric: 'tokens',
            costMode: 'auto',
            focus: null,
        });
    });

    it('accepts the year period from route params', async () => {
        routeParams = {
            period: 'year',
            metric: 'tokens',
            costMode: 'auto',
        };

        const screen = await renderScreen(<Screen />);
        const panel = screen.findByType('UsagePanel' as never);

        expect(panel.props.initialFilters).toEqual({
            period: 'year',
            metric: 'tokens',
            costMode: 'auto',
            focus: null,
        });
    });

    it('syncs updated dashboard filters back into the route params', async () => {
        const screen = await renderScreen(<Screen />);
        const panel = screen.findByType('UsagePanel' as never);

        panel.props.onFiltersChange({
            period: 'year',
            metric: 'cost',
            costMode: 'estimated',
            focus: {
                dimension: 'backendMode',
                key: 'codex:app-server',
                label: 'Codex App Server',
            },
        });

        expect(routerMock.spies.setParams).toHaveBeenCalledWith({
            period: 'year',
            metric: 'cost',
            costMode: 'estimated',
            focusDimension: 'backendMode',
            focusKey: 'codex:app-server',
            focusLabel: 'Codex App Server',
        });
    });

    it('keeps UsagePanel filter props referentially stable across route rerenders with semantically unchanged filters', async () => {
        const screen = await renderScreen(<Screen />);
        const firstPanel = screen.findByType('UsagePanel' as never);
        const firstInitialFilters = firstPanel.props.initialFilters;
        const firstOnFiltersChange = firstPanel.props.onFiltersChange;

        routeParams = {
            ...routeParams,
            metric: 'cost',
        };

        await screen.update(<Screen />);

        const secondPanel = screen.findByType('UsagePanel' as never);

        expect(secondPanel.props.initialFilters).toBe(firstInitialFilters);
        expect(secondPanel.props.onFiltersChange).toBe(firstOnFiltersChange);
    });
});
