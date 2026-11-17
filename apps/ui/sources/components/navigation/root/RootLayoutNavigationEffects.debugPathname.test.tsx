import * as React from 'react';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INVITATION_TOKEN = 'Zq8nT3vLxK1mWc5RpHd7YbJf2GsA4eUo9iNt6XhC0Vw';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: `/join/${INVITATION_TOKEN}`,
        segments: ['(app)', 'join', '[token]'],
        router: { replace: vi.fn() },
    }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false, refreshFromActiveServer: vi.fn(async () => {}) }),
}));
vi.mock('@/hooks/ui/useWebInitialRouteReconcile', () => ({ useWebInitialRouteReconcile: () => {} }));
vi.mock('@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation', () => ({
    consumeLegacySessionDeepLinkFromWebLocation: () => false,
}));
vi.mock('@/activity/notifications/runtime/useNotificationResponseRouting', () => ({
    useNotificationResponseRouting: () => {},
}));
vi.mock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => false,
}));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    invokeDesktopHost: vi.fn(),
    isDesktopHost: () => false,
}));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));

// Compile the real root graph before the per-case behavior deadline.
const { RootLayoutNavigationEffects } = await import('./RootLayoutNavigationEffects');
const { CurrentRouteLocationProvider } = await import('@/components/appShell/workspace/currentRouteLocation');
const { getThemeTryOnOwner } = await import('@/theme/profiles/themeTryOnRuntime');
const { createThemeProfileDraft } = await import('@/theme/profiles/createThemeProfileDraft');
const { parseThemeProfileDocument } = await import('@happier-dev/protocol/account/settings/themeProfiles');
const { storage } = await import('@/sync/domains/state/storage');

afterEach(() => {
    standardCleanup();
    vi.unstubAllEnvs();
});

it('keeps a capability link\'s bearer out of the debug pathname readout', async () => {
    vi.stubEnv('EXPO_PUBLIC_DEBUG', '1');

    const rendered = await renderScreen(<RootLayoutNavigationEffects />);

    const readout = rendered.findByTestId('debug-router-pathname');
    expect(readout).not.toBeNull();
    const text = rendered.getTextContent();
    expect(text).toContain('/join/');
    expect(text).not.toContain(INVITATION_TOKEN);
});

it('ends Store try-on only when the current destination leaves Store, preserving agent and editor previews', async () => {
    const settingsScope = storage.getState().settingsScope;
    const selection = storage.getState().localSettings.themeProfileSelection;
    storage.setState({ settingsScope: { serverId: 'route-home', accountId: 'route-account' } });
    onTestFinished(() => { storage.setState({ settingsScope }); });
    const parsed = parseThemeProfileDocument(createThemeProfileDraft({ id: 'route-preview', name: 'Route preview', now: '2026-11-17' }));
    if (!parsed.ok) throw new Error('Invalid theme fixture');
    const owner = getThemeTryOnOwner();
    const surface = (pathname: string, params: Record<string, string> = {}) => <CurrentRouteLocationProvider value={{ pathname, params }}>
        <RootLayoutNavigationEffects />
    </CurrentRouteLocationProvider>;
    const screen = await renderScreen(surface('/plugins', { selection: 'opened-listing' }));
    const preview = owner.begin({ document: parsed.document, mode: 'dark',
        origin: { kind: 'store', listing: { sourceId: 'catalog', itemId: 'theme' } } });
    const closeDetail = owner.present(preview.previewRef);
    closeDetail();
    await screen.update(surface('/plugins'));
    expect(owner.read()).toBe(preview);
    expect(owner.readGlobalPresentation()).toBe(preview);
    await screen.update(surface('/plugins/listing'));
    expect(owner.read()).toBe(preview);
    let publications = 0;
    const stop = owner.subscribe(() => { publications++; });
    await screen.update(surface('/session/session-a'));
    expect(owner.read()).toBeNull();
    expect(publications).toBe(1);
    await screen.update(surface('/settings'));
    expect(publications).toBe(1);
    stop();

    for (const kind of ['agent', 'editor'] as const) {
        await screen.update(surface('/plugins'));
        const retained = owner.begin({ document: parsed.document, mode: 'dark', origin: { kind } });
        await screen.update(surface('/settings'));
        expect(owner.read()).toBe(retained);
        owner.revert(retained.previewRef);
    }
    // A contributed app page has its own destination despite sharing the URL prefix.
    await screen.update(surface('/plugins'));
    owner.begin({ document: parsed.document, mode: 'dark', origin: { kind: 'store', listing: { sourceId: 'catalog', itemId: 'theme' } } });
    await screen.update(surface('/plugins/sample.palette/board'));
    expect(owner.read()).toBeNull();
    expect(storage.getState().localSettings.themeProfileSelection).toBe(selection);
    await screen.unmount();
});
