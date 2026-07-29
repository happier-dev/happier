import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderHook } from '@/dev/testkit';

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

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => settingsState.tauriDesktop,
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

describe('useResolvedSettingsPageCatalog', () => {
    afterEach(() => {
        pathnameState.value = '/settings';
        featureGateState.enabled = () => true;
        settingsState.useProfiles = false;
        settingsState.devModeEnabled = false;
        settingsState.tauriDesktop = false;
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

    it('includes remote hosts when remoteHosts.management is enabled, and filters it when disabled', async () => {
        featureGateState.enabled = () => true;

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const enabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(enabledHook.getCurrent().tree)).toContain('remoteHosts');
        await enabledHook.unmount();

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
