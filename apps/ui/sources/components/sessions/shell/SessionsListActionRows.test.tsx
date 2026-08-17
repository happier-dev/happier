import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';

import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';

const routeState = vi.hoisted(() => ({
    push: vi.fn(),
    pathname: '/settings/plugins/panels',
    params: { pluginId: 'acme.review', destinationId: 'review-panel' },
}));
const activatePluginAppPage = vi.hoisted(() => vi.fn());
const surfaceState = vi.hoisted(() => ({
    platformOS: 'web' as 'web' | 'ios' | 'android',
    isTablet: false,
    sessionListDensity: 'narrow' as string,
}));
const compactDestinationState = vi.hoisted(() => ({
    value: [{
        kind: 'plugin',
        container: 'rightSidebarTab',
        id: 'rightSidebarTab:plugin:acme.review:review-panel',
        destination: { pluginId: 'acme.review', localId: 'review-panel' },
        title: 'Review',
        icon: 'check-square',
        group: 'plugins',
        order: 50,
        routePath: '/settings/plugins/panels?pluginId=acme.review&destinationId=review-panel',
        availability: 'available',
    }, {
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.notes:notes',
        destination: { pluginId: 'acme.notes', localId: 'notes' },
        title: 'Notes',
        icon: 'note',
        group: 'plugins',
        order: 10,
        routePath: '/plugins/acme.notes/notes',
        availability: 'available',
    }] as readonly CompactAppDestination[],
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routeState.push }),
    usePathname: () => routeState.pathname,
    useGlobalSearchParams: () => routeState.params,
}));
vi.mock('@/components/appShell/plugins/pluginAppPageNavigation', () => ({
    usePluginAppPageCatalogActivationHandler: () => activatePluginAppPage,
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // One runtime that can report either surface, so the desktop-web row and the native touch
    // floor are asserted against the same rendered component rather than two harnesses.
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return surfaceState.platformOS;
            },
            select: <T,>(choices: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                surfaceState.platformOS === 'web'
                    ? choices?.web ?? choices?.default
                    : choices?.[surfaceState.platformOS] ?? choices?.native ?? choices?.default
            ),
        },
    });
});
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useIsTablet: () => surfaceState.isTablet,
}));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: ((key: string) => (
                key === 'sessionListDensity' ? surfaceState.sessionListDensity : undefined
            )) as typeof import('@/sync/domains/state/storage')['useSetting'],
        },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));
vi.mock('@/components/appShell/destinations/compactAppDestinationCatalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/destinations/compactAppDestinationCatalog')>()),
    useCompactAppDestinations: () => compactDestinationState.value,
}));

async function renderActionRowStyle(): Promise<Record<string, number>> {
    const { SessionsListActionRows } = await import('./SessionsListActionRows');
    const screen = await renderScreen(<SessionsListActionRows externalSessionsEnabled={false} />);
    const row = screen.findByTestId('compact-app-destination:plugin:acme.notes:notes');
    return row?.props.style as Record<string, number>;
}

describe('SessionsListActionRows', () => {
    beforeEach(() => {
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        surfaceState.sessionListDensity = 'narrow';
        compactDestinationState.value = [{
            kind: 'plugin',
            container: 'rightSidebarTab',
            id: 'rightSidebarTab:plugin:acme.review:review-panel',
            destination: { pluginId: 'acme.review', localId: 'review-panel' },
            title: 'Review',
            icon: 'check-square',
            group: 'plugins',
            order: 50,
            routePath: '/settings/plugins/panels?pluginId=acme.review&destinationId=review-panel',
            availability: 'available',
        }, {
            kind: 'plugin',
            container: 'appPage',
            id: 'plugin:acme.notes:notes',
            destination: { pluginId: 'acme.notes', localId: 'notes' },
            title: 'Notes',
            icon: 'note',
            group: 'plugins',
            order: 10,
            routePath: '/plugins/acme.notes/notes',
            availability: 'available',
        }] as const;
    });

    it('renders ordinary mobile discovery for an admitted App right-sidebar destination', async () => {
        routeState.push.mockReset();
        activatePluginAppPage.mockReset();
        const { SessionsListActionRows } = await import('./SessionsListActionRows');
        const screen = await renderScreen(<SessionsListActionRows externalSessionsEnabled={false} />);
        const row = screen.findByTestId(
            'compact-app-destination:rightSidebarTab:plugin:acme.review:review-panel',
        );

        expect(row?.props.title).toBe('Review');
        expect(row?.props.selected).toBe(true);
        row?.props.onPress();
        expect(routeState.push).toHaveBeenCalledWith(
            '/settings/plugins/panels?pluginId=acme.review&destinationId=review-panel',
        );
    });

    it('delegates an admitted compact app page to the launch-input route owner', async () => {
        routeState.push.mockReset();
        activatePluginAppPage.mockReset();
        const { SessionsListActionRows } = await import('./SessionsListActionRows');
        const screen = await renderScreen(<SessionsListActionRows externalSessionsEnabled={false} />);
        const row = screen.findByTestId('compact-app-destination:plugin:acme.notes:notes');

        row?.props.onPress();

        expect(activatePluginAppPage).toHaveBeenCalledWith(expect.objectContaining({
            id: 'plugin:acme.notes:notes',
            routePath: '/plugins/acme.notes/notes',
        }));
        expect(routeState.push).not.toHaveBeenCalled();
    });

    it.each([
        { platformOS: 'ios' as const, isTablet: true },
        { platformOS: 'ios' as const, isTablet: false },
        { platformOS: 'android' as const, isTablet: true },
    ])('holds the native touch floor on $platformOS (tablet: $isTablet)', async (surface) => {
        surfaceState.platformOS = surface.platformOS;
        surfaceState.isTablet = surface.isTablet;
        const minimumTargetSize = resolveMinimumInteractiveTargetSize(surface.platformOS);
        const densityHeight = resolveSessionListDensityViewState('narrow', {
            isTablet: surface.isTablet,
            platform: surface.platformOS,
        }).rowHeight;
        // The case only discriminates while the density row is genuinely below the floor.
        expect(densityHeight).toBeLessThan(minimumTargetSize);

        const style = await renderActionRowStyle();

        expect(style.height).toBe(minimumTargetSize);
        expect(style.minHeight).toBe(minimumTargetSize);
    });

    it('keeps the desktop-web row on the session-list density grid', async () => {
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        const densityHeight = resolveSessionListDensityViewState('narrow', {
            isTablet: false,
            platform: 'web',
        }).rowHeight;
        // The approved desktop decision is exactly the case a blanket floor would undo.
        expect(densityHeight).toBeLessThan(resolveMinimumInteractiveTargetSize('web'));

        const style = await renderActionRowStyle();

        expect(style.height).toBe(densityHeight);
        expect(style.minHeight).toBe(densityHeight);
    });

    it('shows a localized unavailable reason instead of a silent disabled compact row', async () => {
        compactDestinationState.value = [{
            kind: 'plugin',
            container: 'appPage',
            id: 'plugin:acme.notes:unavailable',
            destination: { pluginId: 'acme.notes', localId: 'unavailable' },
            title: 'Unavailable notes',
            icon: 'note',
            group: 'plugins',
            order: 10,
            routePath: '/plugins/acme.notes/unavailable',
            availability: 'unavailable',
            unavailableReason: 'feature_disabled',
        }] as const;
        const { SessionsListActionRows } = await import('./SessionsListActionRows');
        const screen = await renderScreen(<SessionsListActionRows externalSessionsEnabled={false} />);
        const row = screen.findByTestId('compact-app-destination:plugin:acme.notes:unavailable');

        expect(row?.props.disabled).toBe(true);
        expect(row?.props.subtitle).toEqual(expect.any(String));
        expect(row?.props.subtitle).not.toBe('feature_disabled');
    });

    it('does not create a second visible sidebar path for a hidden catalog destination', async () => {
        compactDestinationState.value = [{
            kind: 'plugin',
            container: 'appPage',
            id: 'plugin:acme.notes:hidden',
            destination: { pluginId: 'acme.notes', localId: 'hidden' },
            title: 'Hidden notes',
            icon: 'note',
            group: 'plugins',
            order: 10,
            routePath: '/plugins/acme.notes/hidden',
            availability: 'available',
            visibility: 'hidden',
        }] as const;
        const { SessionsListActionRows } = await import('./SessionsListActionRows');
        const screen = await renderScreen(<SessionsListActionRows externalSessionsEnabled={false} />);

        expect(screen.findByTestId('compact-app-destination:plugin:acme.notes:hidden')).toBeNull();
    });
});
