import { describe, expect, it, vi, afterEach } from 'vitest';

import { normalizePluginUiSettingsPageBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderHook } from '@/dev/testkit';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const featureGateState = vi.hoisted(() => ({
    enabled: (_featureId: string): boolean => true,
}));
const settingsState = vi.hoisted(() => ({
    useProfiles: false,
    devModeEnabled: false,
    tauriDesktop: false,
}));
const appShellPluginProjectionState = vi.hoisted(() => ({
    projection: null as PluginUiProjectionModel | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => pathnameState.value,
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureGateState.enabled(featureId),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({
        pluginUiProjection: appShellPluginProjectionState.projection,
    }),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => settingsState.tauriDesktop,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: (key: string) => {
            if (key === 'useProfiles') return settingsState.useProfiles;
            return null;
        },
        useLocalSetting: (key: string) => {
            if (key === 'devModeEnabled') return settingsState.devModeEnabled;
            return null;
        },
    });
});

function flattenIds(nodes: readonly { id: string; children?: readonly any[] }[]): string[] {
    const out: string[] = [];
    const visit = (items: readonly { id: string; children?: readonly any[] }[]) => {
        for (const item of items) {
            out.push(item.id);
            if (item.children) {
                visit(item.children);
            }
        }
    };
    visit(nodes);
    return out;
}

function pluginSettingsProjection(): PluginUiProjectionModel {
    const binding = normalizePluginUiSettingsPageBindingV1({
        pluginId: 'examples.descriptor-only',
        pageId: 'settings',
        rendererId: 'settings-form',
    });
    if (!binding) throw new Error('Settings page fixture needs a normalized binding');
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        settingsGroupsById: {
            'settingsGroup:examples.descriptor-only:descriptor-preferences': {
                id: 'settingsGroup:examples.descriptor-only:descriptor-preferences',
                pluginId: 'examples.descriptor-only',
                contributionKind: 'settingsGroup',
                group: {
                    id: { pluginId: 'examples.descriptor-only', localId: 'descriptor-preferences' },
                    title: 'Descriptor preferences',
                },
            },
        },
        settingsPagesById: {
            'settingsPage:examples.descriptor-only:settings': {
                id: 'settingsPage:examples.descriptor-only:settings',
                pluginId: 'examples.descriptor-only',
                contributionKind: 'settingsPage',
                descriptorId: 'settings',
                page: {
                    id: { pluginId: 'examples.descriptor-only', localId: 'settings' },
                    group: {
                        kind: 'plugin',
                        id: { pluginId: 'examples.descriptor-only', localId: 'descriptor-preferences' },
                    },
                    title: 'Descriptor-only settings',
                    icon: 'settings',
                },
                binding,
                renderer: { kind: 'declarative' },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
        },
    };
}

describe('useResolvedSettingsPageCatalog', () => {
    afterEach(() => {
        pathnameState.value = '/settings';
        featureGateState.enabled = () => true;
        settingsState.useProfiles = false;
        settingsState.devModeEnabled = false;
        settingsState.tauriDesktop = false;
        appShellPluginProjectionState.projection = null;
    });

    it('filters feature-gated pages out of the visible tree', async () => {
        featureGateState.enabled = (featureId: string) => featureId !== 'mcp.servers';

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        const current = hook.getCurrent();
        const ids = flattenIds(current.tree);
        expect(ids).not.toContain('mcp');

        await hook.unmount();
    });

    it('uses the canonical providers feature decision for navigation and search', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');

        featureGateState.enabled = (featureId: string) => featureId === 'providers';
        const enabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(enabledHook.getCurrent().tree)).toContain('providers');
        expect(enabledHook.getCurrent().search('openrouter').some((result: any) => result.id === 'providers')).toBe(true);
        await enabledHook.unmount();

        featureGateState.enabled = () => false;
        const disabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(disabledHook.getCurrent().tree)).not.toContain('providers');
        expect(disabledHook.getCurrent().search('openrouter').some((result: any) => result.id === 'providers')).toBe(false);
        await disabledHook.unmount();
    });

    it('uses the canonical external-sessions feature decision for navigation and search', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');

        featureGateState.enabled = (featureId: string) => featureId === 'sessions.direct';
        const enabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(enabledHook.getCurrent().tree)).toContain('externalSessions');
        expect(enabledHook.getCurrent().search('external sessions').some((result: any) => result.id === 'externalSessions')).toBe(true);
        await enabledHook.unmount();

        featureGateState.enabled = () => false;
        const disabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(disabledHook.getCurrent().tree)).not.toContain('externalSessions');
        expect(disabledHook.getCurrent().search('external sessions').some((result: any) => result.id === 'externalSessions')).toBe(false);
        await disabledHook.unmount();
    });

    it('uses the canonical pets companion feature decision for navigation and search', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');

        featureGateState.enabled = (featureId: string) => featureId === 'pets.companion';
        const enabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(enabledHook.getCurrent().tree)).toContain('pets');
        expect(enabledHook.getCurrent().search('companion').some((result: any) => result.id === 'pets')).toBe(true);
        await enabledHook.unmount();

        featureGateState.enabled = () => false;
        const disabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(disabledHook.getCurrent().tree)).not.toContain('pets');
        expect(disabledHook.getCurrent().search('companion').some((result: any) => result.id === 'pets')).toBe(false);
        await disabledHook.unmount();
    });

    it('resolves active page id from the current pathname', async () => {
        pathnameState.value = '/settings/notifications';

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        expect(hook.getCurrent().activePageId).toBe('notifications');
        await hook.unmount();
    });

    it('treats /settings as the Settings home page (not General)', async () => {
        pathnameState.value = '/settings';

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        expect(hook.getCurrent().activePageId).toBe('settings');
        await hook.unmount();
    });

    it('supports keyword search over visible pages', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        const results = hook.getCurrent().search('notif');
        expect(results.some((result: any) => result.id === 'notifications')).toBe(true);

        await hook.unmount();
    });

    it('feeds the public descriptor-only Settings page and an incumbent built-in page through one resolved catalog', async () => {
        pathnameState.value = '/settings/plugins/examples.descriptor-only/settings';
        appShellPluginProjectionState.projection = pluginSettingsProjection();

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        const current = hook.getCurrent();
        expect(flattenIds(current.tree)).toEqual(expect.arrayContaining([
            'plugins',
            'pluginSettingsPage:examples.descriptor-only:settings',
        ]));
        expect(current.search('descriptor').some((result: any) => (
            result.id === 'pluginSettingsPage:examples.descriptor-only:settings'
            && result.route === '/settings/plugins/examples.descriptor-only/settings'
        ))).toBe(true);
        expect(current.search('plugin').some((result: any) => result.id === 'plugins')).toBe(true);
        expect(current.activePageId).toBe('pluginSettingsPage:examples.descriptor-only:settings');
        await hook.unmount();
    });

    it('leaves a plugin Settings tombstone unselected rather than prefix-matching an admitted page', async () => {
        pathnameState.value = '/settings/plugins/examples.descriptor-only/settings-retired';
        appShellPluginProjectionState.projection = pluginSettingsProjection();

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        const current = hook.getCurrent();
        expect(flattenIds(current.tree)).toContain('pluginSettingsPage:examples.descriptor-only:settings');
        expect(current.activePageId).toBeNull();
        await hook.unmount();
    });

    it('keeps the plugin marketplace active for a one-segment plugin detail route', async () => {
        pathnameState.value = '/settings/plugins/examples.descriptor-only';

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        expect(hook.getCurrent().activePageId).toBe('plugins');
        await hook.unmount();
    });

    it('does not treat a route-name prefix as a Settings page match', async () => {
        pathnameState.value = '/settings/plugins-retired';

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        expect(hook.getCurrent().activePageId).toBeNull();
        await hook.unmount();
    });

    it('keeps the owning built-in Settings page active for its nested routes', async () => {
        pathnameState.value = '/settings/agents/claude/models';

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        expect(hook.getCurrent().activePageId).toBe('agents');
        await hook.unmount();
    });

    it('includes the plugin marketplace page in the visible tree and search results', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        const current = hook.getCurrent();
        expect(flattenIds(current.tree)).toContain('plugins');
        expect(current.search('plugin').some((result: any) => result.id === 'plugins')).toBe(true);

        await hook.unmount();
    });

    it('includes keyboard shortcuts in the dev settings catalog and search results', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        const current = hook.getCurrent();
        expect(flattenIds(current.tree)).toContain('keyboard');
        expect(current.search('shortcut').some((result: any) => result.id === 'keyboard')).toBe(true);

        await hook.unmount();
    });

    it('supports fuzzy search for minor typos', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        const results = hook.getCurrent().search('notificatons');
        expect(results.some((result: any) => result.id === 'notifications')).toBe(true);

        await hook.unmount();
    });

    it('exposes Remote Hosts only on Tauri desktop when remoteHosts.management is enabled', async () => {
        featureGateState.enabled = () => true;

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        settingsState.tauriDesktop = false;
        const nonDesktopHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(nonDesktopHook.getCurrent().tree)).not.toContain('remoteHosts');
        expect(nonDesktopHook.getCurrent().search('remote host').some((result: any) => result.id === 'remoteHosts')).toBe(false);
        await nonDesktopHook.unmount();

        settingsState.tauriDesktop = true;
        const desktopHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(desktopHook.getCurrent().tree)).toContain('remoteHosts');
        expect(desktopHook.getCurrent().search('remote host').some((result: any) => result.id === 'remoteHosts')).toBe(true);
        await desktopHook.unmount();

        featureGateState.enabled = (featureId: string) => featureId !== 'remoteHosts.management';
        const disabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(disabledHook.getCurrent().tree)).not.toContain('remoteHosts');
        await disabledHook.unmount();
    });

    it('includes the Desktop app page only on Tauri desktop builds', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');

        settingsState.tauriDesktop = true;
        const desktopHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(desktopHook.getCurrent().tree)).toContain('desktop');
        expect(desktopHook.getCurrent().search('desktop').some((result: any) => result.id === 'desktop')).toBe(true);
        await desktopHook.unmount();

        settingsState.tauriDesktop = false;
        const nonDesktopHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(nonDesktopHook.getCurrent().tree)).not.toContain('desktop');
        expect(nonDesktopHook.getCurrent().search('desktop').some((result: any) => result.id === 'desktop')).toBe(false);
        await nonDesktopHook.unmount();
    });
});
