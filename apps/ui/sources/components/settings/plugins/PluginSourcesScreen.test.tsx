import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { HAPPIER_PICKS_SOURCE_ID } from '@happier-dev/protocol/registries';
import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

// The router and the device class are the platform adapter boundaries; the page, its route-owned selection and
// the registries view over real registry Actions stay real.
const nav = vi.hoisted(() => ({
    params: {} as ExpoRouterParams,
    replace: vi.fn(),
    device: 'desktop' as 'desktop' | 'phone',
}));
installPromptRegistriesCommonModuleMocks({ storage: original => original(), text: async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock(), router: async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/settings/plugins/sources',
        params: () => nav.params,
        router: { replace: nav.replace },
    }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return { ...actual, useDeviceType: () => nav.device };
});
const { createRegistrySourcesUiHome } = await import('@/dev/testkit/harness/registrySourcesUiHarness');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/navigationTitleChrome');
const { PluginSourcesScreen } = await import('./PluginSourcesScreen');

const page = (showsBack: boolean) => <NavigationTitleChromeProvider showsTitle={showsBack}><PluginSourcesScreen /></NavigationTitleChromeProvider>;
const measure = async (screen: Awaited<ReturnType<typeof renderScreen>>, width: number) => {
    const nodes = screen.root.findAll(node => typeof node.props.onLayout === 'function'
        && typeof node.props.testID === 'string' && node.props.testID.startsWith('settings.plugins.sources'));
    await React.act(async () => {
        for (const node of nodes) node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } } });
    });
};

describe('Settings → Plugins → Sources keeps the open source in its route', () => {
    afterEach(() => { nav.params = {}; nav.device = 'desktop'; nav.replace.mockClear(); });
    it('opens the source a link names beside the list on a wide page', async () => {
        await createRegistrySourcesUiHome('route-wide', { picks: true });
        nav.params = { source: HAPPIER_PICKS_SOURCE_ID };
        const screen = await renderScreen(page(false));
        await measure(screen, 1200);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings.plugins.sources.registries:detail:refresh-now')).not.toBeNull());
        expect(screen.findByTestId('settings.plugins.sources.registries:detail:name')).toBeNull();
    });
    it('on a phone shows a linked source as the page with no Back of its own', async () => {
        nav.device = 'phone';
        await createRegistrySourcesUiHome('route-phone', { picks: true });
        nav.params = { source: HAPPIER_PICKS_SOURCE_ID };
        const screen = await renderScreen(page(true));
        await measure(screen, 390);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings.plugins.sources.registries:detail:refresh-now')).not.toBeNull());
        expect(screen.findByTestId('settings.plugins.sources.registries:detail-pane:back')).toBeNull();
    });
    it('on a phone leaves a removed source for the list', async () => {
        nav.device = 'phone';
        await createRegistrySourcesUiHome('route-stale', { picks: true });
        nav.params = { source: 'removed-source' };
        const screen = await renderScreen(page(true));
        await measure(screen, 390);
        await waitForHomeGovernance(() => expect(nav.replace).toHaveBeenCalledWith('/settings/plugins/sources'));
        expect(screen.findByTestId('settings.plugins.sources.registries:detail:refresh-now')).toBeNull();
    });
});
