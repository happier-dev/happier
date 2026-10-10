import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { useServerSettingsServerProfileActions } from './useServerSettingsServerProfileActions';

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { prompt: vi.fn(async () => 'Renamed locally') } }).module;
});
vi.mock('expo-secure-store', () => ({}));
// The native markdown SDK is reached by unrelated dialog imports; this hook never renders markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Home rename does not render streaming markdown'); },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
    standardCleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    profiles.resetServerProfilesRuntimeForTests();
});

describe('Home rename entry', () => {
    it('opens the addressed Home name editor without overwriting its retained local name', async () => {
        const localStorage = installLocalStorageMock();
        try {
            const legacyProfile = await profiles.upsertServerProfile({ serverUrl: 'https://rename-target.example', name: 'Legacy name' });
            const addressedHome = await profiles.setServerProfileIdentityForUrl(legacyProfile.serverUrl, 'srv_home_rename_target');
            if (!addressedHome) throw new Error('Expected the Home identity to bind to its saved profile');
            const otherHome = await profiles.upsertServerProfile({ serverUrl: 'https://other-home.example', name: 'Other Home' });
            await profiles.setActiveServerId(otherHome.id, { scope: 'device' });
            const actions = await renderHook(() => useServerSettingsServerProfileActions({
                authStatusByServerId: { [profiles.resolveServerProfileScopeId(addressedHome)]: 'signedOut' },
                selectionScope: 'tab',
                onSwitchServerById: async () => 'switched',
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: vi.fn(),
            }));

            await actions.getCurrent().onRenameServer(addressedHome);

            expect(profiles.getServerProfileById(addressedHome.id)?.name).toBe('Legacy name');
            expect(profiles.getActiveServerId()).toBe(otherHome.id);
            const { homeAdministrationOverviewPath } = await import('@/components/settings/home/governance/homeAdministrationRoutes');
            const { HOME_OVERVIEW_SETTINGS } = await import('@/components/settings/home/governance/homeOverviewSettings');
            const { buildSettingHref } = await import('@/components/settings/catalog/settingDeclarations');
            expect(routerPush).toHaveBeenCalledWith(buildSettingHref(
                homeAdministrationOverviewPath(profiles.resolveServerProfileScopeId(addressedHome)),
                HOME_OVERVIEW_SETTINGS.settings.homeName,
            ));
        } finally {
            localStorage.restore();
        }
    });
});
