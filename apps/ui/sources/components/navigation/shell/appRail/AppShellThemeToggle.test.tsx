import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup, pressTestInstanceAsync } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

const routeParams = vi.hoisted(() => ({ setting: undefined as string | undefined }));
const osLinking = vi.hoisted(() => ({ openSettings: vi.fn(async () => {}), sendIntent: vi.fn(async (_action: string) => {}) }));
const osFeedback = vi.hoisted(() => ({ alertAsync: vi.fn(async (_title: string, _message: string) => {}), desktop: false }));

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

vi.mock('@/components/inbox/actionOperations/ActionOperationActivityButton', () => ({
    ActionOperationActivityButton: () => null,
}));
// Native OS appearance paints are outside the renderer; keep the theme mutation real beneath them.
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
// The popover's portal/measurement boundary renders the open menu inline; the menu itself is real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

let previousState: ReturnType<typeof import('@/sync/domains/state/storage')['storage']['getState']>;
beforeEach(async () => {
    routeParams.setting = undefined;
    osLinking.openSettings.mockClear();
    osLinking.sendIntent.mockClear();
    osFeedback.alertAsync.mockClear();
    osFeedback.desktop = false;
    await loadSyncSingletonForTests();
    const { storage } = await import('@/sync/domains/state/storage');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    previousState = storage.getState();
    act(() => storage.setState({ settingsScope: { serverId: 'glass-test-server', accountId: 'glass-test-account' }, settingsVersion: 0, settings: settingsDefaults }));
});

afterEach(async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    standardCleanup();
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
    it('offers one Customize path and an honest browser state in the popover', async () => {
        const screen = await renderStrip();
        await screen.pressByTestIdAsync('app-shell-theme-toggle');
        expect(screen.findByTestId('appearance-material:custom')).toBeNull();
        expect(screen.findByTestId('appearance-customize-link')).not.toBeNull();
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveBrowser' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('appearance-desktop-download')).not.toBeNull();
        await screen.pressByTestIdAsync('appearance-material:solid');
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveBrowserSolid' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('appearance-desktop-download')).not.toBeNull();
    });

    it('keeps the effective state visible for every preset and names native window unavailability', async () => {
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true }}><GlassAppearanceSection /></GlassRuntimeEnvironmentProvider>);
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveUnavailable' }).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('appearance-material:solid');
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveSolid' }).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('appearance-material:everywhere');
        expect(screen.findAllByProps({ title: 'settingsAppearance.glassControls.effectiveUnavailable' }).length).toBeGreaterThan(0);
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
        expect(storage.getState().settings.glassBlurEnabled).toBe(false);
        const blur = screen.findByTestId('appearance-blur:regular');
        expect(blur?.props.accessibilityState?.disabled ?? blur?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('appearance-material:everywhere');
        expect(storage.getState().settings.glassSurfaceMaterials?.content.blur).not.toBe('off');
        await screen.pressByTestIdAsync('appearance-material:clear');
        expect(storage.getState().settings.glassSurfaceMaterials?.floating).toEqual({ blur: 'strong', opacity: 0.02 });
        expect(storage.getState().settings.glassBlurIntensity).toBe('strong');
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

    it('applies strongest blur and fully transparent content from the Appearance disclosure', async () => {
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const screen = await renderScreen(<GlassAppearanceSection />);
        await screen.pressByTestIdAsync('appearance-customize');
        await screen.pressByTestIdAsync('appearance-content-blur:strong');
        const slider = screen.findAllByTestId('appearance-content-opacity').find(node => typeof node.props.onKeyDown === 'function');
        expect(slider).toBeDefined();
        await act(async () => { slider?.props.onKeyDown({ key: 'Home', preventDefault: () => {} }); });
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().settings.glassSurfaceMaterials?.content).toEqual({ blur: 'strong', opacity: 0 });
        expect(screen.findByTestId('appearance-content-opacity-value')?.findAll(node => node.props.children === '0%').length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('appearance-material:auto');
        expect(storage.getState().settings.glassSurfaceMaterials).toBeNull();
    });

    it('reveals a requested group inside the closed Customize disclosure', async () => {
        routeParams.setting = 'appearance.glassContentOpacity';
        const { GlassAppearanceSection } = await import('@/components/settings/appearance/GlassAppearanceControls');
        const screen = await renderScreen(<GlassAppearanceSection />);
        expect(screen.findByTestId('appearance-content-opacity')).not.toBeNull();
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
