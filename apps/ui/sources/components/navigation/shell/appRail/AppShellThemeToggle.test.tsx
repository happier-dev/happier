import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup, pressTestInstanceAsync } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

const routeParams = vi.hoisted(() => ({ setting: undefined as string | undefined }));
const osLinking = vi.hoisted(() => ({ openSettings: vi.fn(async () => {}), sendIntent: vi.fn(async (_action: string) => {}) }));
const osFeedback = vi.hoisted(() => ({ alertAsync: vi.fn(async (_title: string, _message: string) => {}), desktop: false }));

installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// The real local-settings store: hiding the switch is a device-local preference the strip must obey.
installNavigationShellCommonModuleMocks({
    storage: (importOriginal) => importOriginal(),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alertAsync: osFeedback.alertAsync } }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => routeParams }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Appearance: { getColorScheme: () => 'light' }, Linking: osLinking });
    },
});

// Only the OS host boundary is substituted; the desktop settings adapter remains real.
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => osFeedback.desktop,
    invokeDesktopHost: async () => false,
}));

// The real optional pane context and activity entry remain under their canonical owners.
vi.doUnmock('@/components/appShell/panes/AppPaneProvider');
// Native OS appearance paints are outside the renderer; keep the theme mutation real beneath them.
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
// The popover's portal/measurement boundary renders the open menu inline; the menu itself is real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

// Warm the real sync graph during collection; each fixture retains its own require bridge.
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');

let previousState: ReturnType<typeof storage.getState>;
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
beforeEach(async () => {
    routeParams.setting = undefined;
    osLinking.openSettings.mockClear();
    osLinking.sendIntent.mockClear();
    osFeedback.alertAsync.mockClear();
    osFeedback.desktop = false;
    await loadSyncSingletonForTests();
    previousState = storage.getState();
    home = await serveActionHomes({
        homes: [{ key: 'appearance', serverUrl: 'https://appearance.test', accountId: 'appearance-account', currentAccount: true }],
        route: ({ path, method }) => path === '/v1/features' || path === '/v1/features/authenticated'
            ? Response.json(createRootLayoutFeaturesResponse())
            : createEmptyAccountBootstrapHttpResponse(path, { method }) ?? undefined,
    });
    await waitForHomeGovernance(() => {
        expect(storage.getState().settingsScope?.accountId).toBe('appearance-account');
        expect(storage.getState().settingsVersion).toBeTypeOf('number');
    });
});

afterEach(async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    standardCleanup();
    await home?.dispose();
    home = undefined;
    act(() => storage.setState(previousState, true));
});

/** The toggle's secondary invocations, as its press owner receives them. */
function toggleWith(screen: Awaited<ReturnType<typeof renderScreen>>, handler: 'onContextMenu' | 'onLongPress') {
    const node = screen.findAllByTestId('app-shell-theme-toggle').find((candidate) => typeof candidate.props[handler] === 'function');
    expect(node).toBeDefined();
    return node?.props[handler] as ((event?: unknown) => void) | undefined;
}

async function renderStrip() {
    const { AppShellTitleStrip } = await import('./AppShellTitleStrip');
    return renderScreen(<AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} />);
}

describe('AppShellThemeToggle', () => {
    it('offers one Appearance settings path and an honest browser state in the popover', async () => {
        const screen = await renderStrip();
        await screen.pressByTestIdAsync('app-shell-theme-toggle');
        expect(screen.findByTestId('appearance-material:custom')).toBeNull();
        expect(screen.findByTestId('appearance-customize-link')).toBeNull();
        expect(screen.findByTestId('appearance-more-settings')).not.toBeNull();
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveBrowser' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('appearance-desktop-download')).not.toBeNull();
        await screen.pressByTestIdAsync('appearance-material:solid');
        await vi.waitFor(() => expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveBrowserSolid' }).length).toBeGreaterThan(0));
        expect(screen.findByTestId('appearance-desktop-download')).not.toBeNull();
    });

    it('keeps the effective state visible for every preset and names native window unavailability', async () => {
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true }}><GlassAppearanceSection /></GlassRuntimeEnvironmentProvider>);
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveUnavailable' }).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('appearance-material:solid');
        await vi.waitFor(() => expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveSolid' }).length).toBeGreaterThan(0));
        await screen.pressByTestIdAsync('appearance-material:everywhere');
        await vi.waitFor(() => expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveUnavailable' }).length).toBeGreaterThan(0));
    });

    it('describes a Custom browser material without claiming background blur when it is off', async () => {
        const { GlassEffectiveStateLine } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const screen = await renderScreen(<GlassEffectiveStateLine settings={{ glassSurfaceMaterials: {
            ...glassPresetMaterials('everywhere'), floating: { blur: 'off', opacity: 0.4 },
        } }} />);
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveBrowserCustom' }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveBrowser' })).toHaveLength(0);
    });

    it('distinguishes Android tint fallback from an opaque Custom floating coat', async () => {
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Platform.OS = 'android';
        try {
            const { GlassEffectiveStateLine } = await import('@/components/settings/appearance/GlassAppearanceControls');
            const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
            for (const opacity of [1, 0.4]) {
                const screen = await renderScreen(<GlassEffectiveStateLine settings={{ glassSurfaceMaterials: {
                    ...glassPresetMaterials('everywhere'), floating: { blur: 'off', opacity },
                } }} />);
                expect(screen.findAllByProps({ title: `settingsAppearance.glassControls.${opacity === 1 ? 'effectiveFloatingSolid' : 'effectiveTint'}` }).length).toBeGreaterThan(0);
                standardCleanup();
            }
            // A named preset asks for blur, which Android lacks: its floating controls are solid there.
            const named = await renderScreen(<GlassEffectiveStateLine settings={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }} />);
            expect(named.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveFloatingSolid' }).length).toBeGreaterThan(0);
            standardCleanup();
        } finally {
            Platform.OS = previousOS;
        }
    });

    it.each(['tiles', 'compact', 'panel'] as const)('hides ineffective Android blur controls in the %s presentation while retaining tint choices', async (presentation) => {
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Platform.OS = 'android';
        try {
            const { GlassAppearanceControls } = await import('@/components/settings/appearance/GlassAppearanceControls');
            const screen = await renderScreen(<GlassAppearanceControls presentation={presentation} />);
            expect(screen.findByTestId('appearance-material:everywhere')).not.toBeNull();
            expect(screen.findByTestId('appearance-tint-track')).not.toBeNull();
            expect(screen.findByTestId('appearance-blur:regular')).toBeNull();
        } finally {
            Platform.OS = previousOS;
        }
    });

    it.each(['ios', 'web'] as const)('retains effective %s blur controls alongside material and tint choices', async (platform) => {
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Platform.OS = platform;
        try {
            const { GlassAppearanceControls } = await import('@/components/settings/appearance/GlassAppearanceControls');
            const screen = await renderScreen(<GlassAppearanceControls presentation="compact" />);
            expect(screen.findByTestId('appearance-material:everywhere')).not.toBeNull();
            expect(screen.findByTestId('appearance-tint-track')).not.toBeNull();
            expect(screen.findByTestId('appearance-blur:regular')).not.toBeNull();
        } finally {
            Platform.OS = previousOS;
        }
    });

    it('opens Appearance on an ordinary press and changes materials through the shared account owner', async () => {
        const screen = await renderStrip();
        await screen.pressByTestIdAsync('app-shell-theme-toggle');
        expect(screen.findByTestId('appearance-material:everywhere')).not.toBeNull();
        await screen.pressByTestIdAsync('appearance-material:solid');
        const { storage } = await import('@/sync/domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().settings.glassBlurEnabled).toBe(false));
        await vi.waitFor(() => {
            const blur = screen.findByTestId('appearance-blur:regular');
            expect(blur?.props.accessibilityState?.disabled ?? blur?.props.disabled).toBe(true);
        });
        await screen.pressByTestIdAsync('appearance-material:everywhere');
        await vi.waitFor(() => expect(storage.getState().settings.glassSurfaceMaterials?.content.blur).not.toBe('off'));
        await screen.pressByTestIdAsync('appearance-material:clear');
        await vi.waitFor(() => expect(storage.getState().settings.glassSurfaceMaterials?.floating).toEqual({ blur: 'strong', opacity: 0.02 }));
        await vi.waitFor(() => expect(storage.getState().settings.glassBlurIntensity).toBe('strong'));
    });
    it.each(['light', 'dark', 'adaptive'] as const)('marks only the stored %s mode as selected', async (mode) => {
        const { storage } = await import('@/sync/domains/state/storage');
        act(() => storage.getState().applyLocalSettings({ themePreference: mode }));
        const screen = await renderStrip();
        await act(async () => { toggleWith(screen, 'onLongPress')?.(); });
        for (const id of ['light', 'dark', 'adaptive']) {
            const rows = screen.findAllByTestId(`app-shell-theme-menu:${id}`);
            expect(rows.some(row => row.props['aria-checked'] === (id === mode)
                || row.props.accessibilityState?.checked === (id === mode))).toBe(true);
        }
    });

    it('opens its menu on a long press and on a right click, and hides itself from the toolbar on request', async () => {
        const screen = await renderStrip();
        expect(screen.findByTestId('app-shell-theme-menu-hide')).toBeNull();

        await act(async () => { toggleWith(screen, 'onContextMenu')?.({ preventDefault: () => {} }); });
        expect(screen.findByTestId('app-shell-theme-menu-hide')).not.toBeNull();
        expect(screen.findByTestId('app-shell-theme-menu:adaptive')).not.toBeNull();
        await act(async () => { toggleWith(screen, 'onContextMenu')?.({ preventDefault: () => {} }); });

        await act(async () => { toggleWith(screen, 'onLongPress')?.(); });
        await screen.pressByTestIdAsync('app-shell-theme-menu-hide');
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().localSettings.titleStripThemeToggleVisible).toBe(false);
        expect(screen.findByTestId('app-shell-theme-toggle')).toBeNull();
    });

    it('stays out of the toolbar while the device preference hides it', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        act(() => { storage.getState().applyLocalSettings({ titleStripThemeToggleVisible: false }); });
        const screen = await renderStrip();
        expect(screen.findByTestId('app-shell-theme-toggle')).toBeNull();
        expect(screen.findByTestId('app-shell-column-toggle')).not.toBeNull();
    });

    it('edits Elements without leaving Auto and keeps non-card layer choices Custom', async () => {
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const screen = await renderScreen(<GlassAppearanceSection />);
        expect(screen.findByTestId('appearance-customize')).toBeNull();
        expect(screen.findByTestId('appearance-content:glass')).toBeNull();
        await screen.pressByTestIdAsync('appearance-card:solid');
        const { storage } = await import('@/sync/domains/state/storage');
        const { readGlassPreset, readGlassMaterials } = await import('@/components/ui/glass/glassMaterial');
        expect(readGlassPreset(storage.getState().settings)).toBe('auto');
        await vi.waitFor(() => expect(readGlassMaterials(storage.getState().settings).card).toEqual({ blur: 'off', opacity: 1 }));
        await screen.pressByTestIdAsync('appearance-card:glass');
        await vi.waitFor(() => expect(readGlassMaterials(storage.getState().settings).card.blur).not.toBe('off'));
        expect(readGlassPreset(storage.getState().settings)).toBe('auto');
        await screen.pressByTestIdAsync('appearance-sidebar:solid');
        await vi.waitFor(() => expect(readGlassPreset(storage.getState().settings)).toBe('custom'));
        await vi.waitFor(() => expect(readGlassMaterials(storage.getState().settings).sidebar).toEqual({ blur: 'off', opacity: 1 }));
    });

    it('sets Tint as a whole number from the slider (default 12 + one step) and keeps it disabled for Solid', async () => {
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const { storage } = await import('@/sync/domains/state/storage');
        const screen = await renderScreen(<GlassAppearanceSection />);
        const slider = screen.findByTestId('appearance-tint');
        await act(async () => { slider?.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); });
        await vi.waitFor(() => expect(storage.getState().settings.glassTintIntensity).toBe(13));
        await screen.pressByTestIdAsync('appearance-material:solid');
        await vi.waitFor(() => expect(storage.getState().settings.glassBlurEnabled).toBe(false));
        await act(async () => { screen.findByTestId('appearance-tint')?.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); });
        expect(storage.getState().settings.glassTintIntensity).toBe(13);
    });

    it('shows the Window layer only in a desktop app', async () => {
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true }}><GlassAppearanceSection /></GlassRuntimeEnvironmentProvider>);
        expect(screen.findByTestId('appearance-content:glass')).not.toBeNull();
        expect(screen.findByTestId('appearance-chrome:glass')).not.toBeNull();
        expect(screen.findByTestId('appearance-floating:glass')).not.toBeNull();
    });

    it('reveals a requested layer directly from settings search', async () => {
        routeParams.setting = 'appearance.glassElements';
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const screen = await renderScreen(<GlassAppearanceSection />);
        expect(screen.findByTestId('appearance-card:glass')).not.toBeNull();
    });

    it('opens Android accessibility settings from the Reduce Transparency notice, not app settings', async () => {
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Platform.OS = 'android';
        try {
            const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
            const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: true }}>
                <GlassAppearanceSection />
            </GlassRuntimeEnvironmentProvider>);
            const notice = screen.findAllByProps({ title: 'settingsAppearance.glassControls.reduceTransparency' }).find(node => typeof node.props.onPress === 'function');
            await pressTestInstanceAsync(notice, 'Reduce Transparency notice');
            expect(osLinking.sendIntent).toHaveBeenCalledWith('android.settings.ACCESSIBILITY_SETTINGS');
            expect(osLinking.openSettings).not.toHaveBeenCalled();
            expect(osFeedback.alertAsync).not.toHaveBeenCalled();
        } finally {
            Platform.OS = previousOS;
        }
    });

    it('gives the manual iOS accessibility path without offering app settings as that control', async () => {
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Platform.OS = 'ios';
        try {
            const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
            const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: true }}><GlassAppearanceSection /></GlassRuntimeEnvironmentProvider>);
            const notices = screen.findAllByProps({ title: 'settingsAppearance.glassControls.reduceTransparency' });
            expect(notices.length).toBeGreaterThan(0);
            expect(notices.every(node => node.props.onPress === undefined)).toBe(true);
            expect(notices[0]?.props.subtitle).toBe('settingsAppearance.glassControls.iosReduceTransparencyPath');
            expect(osLinking.openSettings).not.toHaveBeenCalled();
        } finally { Platform.OS = previousOS; }
    });

    it('shows an error when Android cannot open accessibility settings', async () => {
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Platform.OS = 'android';
        osLinking.sendIntent.mockRejectedValueOnce(new Error('No matching activity'));
        try {
            const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
            const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: true }}>
                <GlassAppearanceSection />
            </GlassRuntimeEnvironmentProvider>);
            const notice = screen.findAllByProps({ title: 'settingsAppearance.glassControls.reduceTransparency' }).find(node => typeof node.props.onPress === 'function');
            await pressTestInstanceAsync(notice, 'Reduce Transparency notice');
            expect(osFeedback.alertAsync).toHaveBeenCalledWith('common.error', 'settingsAppearance.glassControls.osSettingsUnavailable');
            expect(osLinking.openSettings).not.toHaveBeenCalled();
        } finally {
            Platform.OS = previousOS;
        }
    });

    it('shows unavailable when the desktop settings bridge cannot open the OS pane', async () => {
        osFeedback.desktop = true;
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: true, desktopWindow: true }}>
            <GlassAppearanceSection />
        </GlassRuntimeEnvironmentProvider>);
        const notice = screen.findAllByProps({ title: 'settingsAppearance.glassControls.reduceTransparency' }).find(node => typeof node.props.onPress === 'function');
        await pressTestInstanceAsync(notice, 'Reduce Transparency notice');
        expect(osFeedback.alertAsync).toHaveBeenCalledWith('common.error', 'settingsAppearance.glassControls.osSettingsUnavailable');
    });
});
