import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';

import { FEATURE_IDS, FeaturesResponseSchema, PluginProjectionV2Schema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { normalizePluginUiSettingsPageBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderHook as renderRealHook } from '@/dev/testkit';
import {
    normalizePluginUiProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const routeParamsState = vi.hoisted(() => ({ value: {} as Record<string, string | string[] | undefined> }));
const featureGateState = vi.hoisted(() => ({
    enabled: (_featureId: string): boolean => true,
}));
const settingsState = vi.hoisted(() => ({
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
        params: () => routeParamsState.value,
    }).module;
});

/** The viewer's language for page search words; other keys render as themselves. */
const searchWordsState = vi.hoisted(() => ({ overrides: {} as Record<string, string> }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { settingsSearchKeywordsTranslations } = await import('@/text/translations/settingsSearchKeywordsTranslations');
    const english: Record<string, string> = settingsSearchKeywordsTranslations.en.settingsSearchKeywords;
    return createTextModuleMock({
        translate: (key) => searchWordsState.overrides[key]
            ?? (key.startsWith('settingsSearchKeywords.') ? english[key.slice('settingsSearchKeywords.'.length)] : undefined)
            ?? key,
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => settingsState.tauriDesktop,
}));

// Initialize the declarations before the real store's app-context import graph.
await import('../settingsPageDeclarations');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const profiles = await import('@/sync/domains/server/serverProfiles');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');

function CatalogProjectionProvider({ children }: React.PropsWithChildren) {
    // The wire projection fixture enters the actual AppShell context owner.
    // Neither the catalog hooks nor its localized-text resolver are replaced.
    return <AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: appShellPluginProjectionState.projection,
        pluginBrowserProjection: null,
        phase: 'current',
        interactionEnabled: true,
        machineId: null,
        serverId: null,
        platform: 'web',
        reloadConnectedAccountProjection() {},
        clientExecutableActivation: { status: 'ready' },
        reloadClientExecutables() {},
    }}>{children}</AppShellPluginUiProjectionValueProvider>;
}

async function renderHook<Value>(useValue: () => Value) {
    // Build-time environment and observed server response are genuine inputs to
    // the real feature decision owner. Keep dependencies and local policy real.
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', FEATURE_IDS.filter((id) => !featureGateState.enabled(id)).join(','));
    return renderRealHook(useValue, { wrapper: CatalogProjectionProvider });
}

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
    return normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2, generation: 0, installedPackagesById: {}, agentsById: {}, actionsById: {},
        toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            'settingsGroup:examples.descriptor-only:descriptor-preferences': {
                id: 'settingsGroup:examples.descriptor-only:descriptor-preferences',
                occurrenceId: 'descriptor-preferences-occurrence',
                pluginId: 'examples.descriptor-only',
                contributionKind: 'settingsGroup',
                group: {
                    id: { pluginId: 'examples.descriptor-only', localId: 'descriptor-preferences' },
                    title: 'Descriptor preferences',
                },
            },
            'settingsPage:examples.descriptor-only:settings': {
                id: 'settingsPage:examples.descriptor-only:settings',
                occurrenceId: 'descriptor-settings-occurrence',
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
                renderer: {
                    kind: 'declarative', contributionId: 'settings-form', model: {
                        identity: { pluginId: 'examples.descriptor-only', localId: 'settings-form', qualifiedId: 'examples.descriptor-only/settings-form', occurrenceId: 'settings-form-occurrence' },
                        visible: true, requiredHostMethods: [],
                        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
                        root: { kind: 'text', path: 'root', order: 0, text: 'Settings' },
                    },
                },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
        } } },
    }));
}

describe('useResolvedSettingsPageCatalog', () => {
    let priorStorage: ReturnType<typeof storage.getState>;
    let priorView: ReturnType<typeof profiles.loadHomeViewState>;
    let fixtureHomeId: string;
    beforeEach(async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        // Device credential persistence is the boundary; Home admission stays real.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
        priorStorage = storage.getState();
        priorView = profiles.loadHomeViewState();
        const home = await profiles.upsertServerProfile({ name: 'Catalog fixture', serverUrl: 'https://catalog-fixture.example' });
        fixtureHomeId = home.id;
        const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
        for (const id of FEATURE_IDS) tryWriteServerEnabledBitInPlace(features, id, true);
        primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features } });
        await profiles.saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: home.id });
        storage.setState({ settings: { ...settingsDefaults, experiments: true, featureToggles: Object.fromEntries(FEATURE_IDS.map((id) => [id, true])) } });
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW', '');
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV', '');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        storage.setState(priorStorage, true);
        if (priorView) await profiles.saveHomeViewState(priorView);
        await profiles.removeServerProfile(fixtureHomeId);
        resetServerFeaturesClientForTests();
        pathnameState.value = '/settings';
        routeParamsState.value = {};
        featureGateState.enabled = () => true;
        settingsState.tauriDesktop = false;
        appShellPluginProjectionState.projection = null;
    });

    it('keeps Teams in navigation and search for a capable secondary Home, then removes it outside that Home set', async () => {
        const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { useTeamsSettingsAdmission } = await import('@/hooks/teams/useTeamsSettingsAdmission');
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const priorView = profiles.loadHomeViewState();
        const homeA = await profiles.upsertServerProfile({ name: 'Catalog A', serverUrl: 'https://catalog-a.example' });
        const homeB = await profiles.upsertServerProfile({ name: 'Catalog B', serverUrl: 'https://catalog-b.example' });
        primeServerFeaturesSnapshot({
            serverId: homeA.id,
            snapshot: { status: 'unsupported', reason: 'endpoint_missing' },
        });
        primeServerFeaturesSnapshot({
            serverId: homeB.id,
            snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} }) },
        });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'catalog-group', name: 'Both Homes', serverIds: [homeA.id, homeB.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'catalog-group',
        });
        // Teams admission reads the saved Home set and observed feature responses.
        pathnameState.value = `/settings/teams/${homeB.id}/team-one`;
        const hook = await renderHook(() => ({
            admission: useTeamsSettingsAdmission(),
            catalog: useResolvedSettingsPageCatalog(),
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().admission.capableServerIds).toEqual([homeB.id]));
            expect(flattenIds(hook.getCurrent().catalog.tree)).toContain('teams');
            expect(hook.getCurrent().catalog.search('teams')).toContainEqual({ id: 'teams', route: '/settings/teams' });
            expect(hook.getCurrent().catalog.activePageId).toBe('teams');

            routeParamsState.value = { serverId: homeB.id, teamId: 'team-one', connectionId: 'connection-one', providerId: 'provider-one' };
            pathnameState.value = `/settings/teams/${homeB.id}/team-one/authentication/connection-one/edit`;
            await hook.rerender();
            expect(hook.getCurrent().catalog.search('issuer')).toContainEqual(expect.objectContaining({
                route: `${pathnameState.value}?providerId=provider-one&setting=teams.oidc.issuer`,
                setting: expect.objectContaining({ anchor: 'teams.oidc.issuer' }),
            }));
            routeParamsState.value = { ...routeParamsState.value, serverId: homeA.id };
            pathnameState.value = `/settings/teams/${homeA.id}/team-one/authentication/connection-one/edit`;
            await hook.rerender();
            expect(hook.getCurrent().catalog.search('issuer').some((result) => result.setting?.anchor === 'teams.oidc.issuer')).toBe(false);
            // Route parameters left over from an editor never become a current entity.
            pathnameState.value = '/settings';
            await hook.rerender();
            expect(hook.getCurrent().catalog.search('issuer').some((result) => result.setting?.anchor === 'teams.oidc.issuer')).toBe(false);
            pathnameState.value = `/settings/teams/${homeB.id}/team-one`;

            await act(async () => await profiles.saveHomeViewState({
                version: 1, groups: [], activeTargetKind: 'server', activeTargetId: homeA.id,
            }));
            await vi.waitFor(() => expect(hook.getCurrent().admission.admitted).toBe(false));
            expect(flattenIds(hook.getCurrent().catalog.tree)).not.toContain('teams');
            expect(hook.getCurrent().catalog.search('teams').some((result) => result.id === 'teams')).toBe(false);
            // No visible catalog row remains selected. The exact-Home route
            // still belongs to TeamSection/useTeamBinding, independently of
            // the selected Home set and this navigation/search projection.
            expect(pathnameState.value).toBe(`/settings/teams/${homeB.id}/team-one`);
            expect(hook.getCurrent().catalog.activePageId).toBeNull();
        } finally {
            await hook.unmount();
            if (priorView) await profiles.saveHomeViewState(priorView);
            await profiles.removeServerProfile(homeA.id);
            await profiles.removeServerProfile(homeB.id);
            resetServerFeaturesClientForTests();
        }
    });

    it('lists Teams unless the Home says this viewer is not shown it', async () => {
        const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const eligibility = await import('@/sync/store/home/governance/homeGovernanceEligibilitySnapshots');
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const priorView = profiles.loadHomeViewState();
        const home = await profiles.upsertServerProfile({ name: 'Visibility Home', serverUrl: 'https://visibility.example' });
        // Credential persistence is a device boundary; the scope, snapshot store and admission stay real.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (_url, options) => ({
            token: `header.${Buffer.from(JSON.stringify({ sub: `viewer-${options?.serverId}` })).toString('base64')}.signature`,
        }));
        primeServerFeaturesSnapshot({
            serverId: home.id,
            snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} }) },
        });
        const answer = (showTeams: boolean) => act(async () => eligibility.applyHomeGovernanceEligibility({
            scope: { serverId: home.id, accountId: `viewer-${home.id}` },
            eligibility: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false, showTeams },
            observedAt: Date.now(),
        }));
        await profiles.saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: home.id });
        await answer(false);
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());
        try {
            await vi.waitFor(() => expect(flattenIds(hook.getCurrent().tree)).not.toContain('teams'));
            expect(hook.getCurrent().search('teams').some((result) => result.id === 'teams')).toBe(false);

            await answer(true);
            await vi.waitFor(() => expect(flattenIds(hook.getCurrent().tree)).toContain('teams'));
        } finally {
            await hook.unmount();
            if (priorView) await profiles.saveHomeViewState(priorView);
            await profiles.removeServerProfile(home.id);
            resetServerFeaturesClientForTests();
            eligibility.resetHomeGovernanceEligibilitySnapshotsForTests();
        }
    });

    it('admits Home Administration from each Home projection and owner setup without a feature gate', async () => {
        const { HomeGovernanceProjectionV1Schema, NO_HOME_CAPABILITIES_V1 } = await import('@happier-dev/protocol/home/governance');
        const { homeAdministrationIdentityProviderEditPath } = await import('@/components/settings/home/governance/homeAdministrationRoutes');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const snapshots = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
        const { useHomeAdministrationSettingsAdmission } = await import('@/hooks/home/useHomeAdministrationSettingsAdmission');
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const priorView = profiles.loadHomeViewState();
        const homeA = await profiles.upsertServerProfile({ name: 'Administration A', serverUrl: 'https://administration-a.example' });
        const homeB = await profiles.upsertServerProfile({ name: 'Administration B', serverUrl: 'https://administration-b.example' });
        // Credential persistence is a device boundary. Account parsing, Home selection,
        // snapshot subscriptions and admission below it remain real.
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (_url, options) => ({
            token: `header.${Buffer.from(JSON.stringify({ sub: `viewer-${options?.serverId}` })).toString('base64')}.signature`,
        }));
        const project = (serverId: string, admitted: boolean, setupState: 'owned' | 'setup_required' = 'owned') => {
            const scope = { serverId, accountId: `viewer-${serverId}` };
            snapshots.applyHomeGovernanceProjection({
                scope,
                projection: HomeGovernanceProjectionV1Schema.parse({
                    viewer: { accountId: scope.accountId, homeRole: 'owner', status: 'active' },
                    capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: admitted },
                    policy: { revision: 1, teamCreationPolicy: 'managed_only', authentication: { status: 'inherited' } },
                    authenticationOptions: {
                        methods: [],
                        permittedAccountModes: ['e2ee'],
                        recommendedProvisioningMode: 'e2ee',
                        signInService: { deploymentMode: null, canDisable: false },
                    },
                    setupState,
                    activeOwnerCount: setupState === 'owned' ? 1 : 0,
                    teamsEnabled: false,
                }),
                observedAt: Date.now(),
            });
        };
        project(homeA.id, false);
        project(homeB.id, true);
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'administration-group', name: 'Both Homes', serverIds: [homeA.id, homeB.id] }],
            activeTargetKind: 'group', activeTargetId: 'administration-group',
        });
        pathnameState.value = `/settings/home/${homeB.id}/people`;
        const hook = await renderHook(() => ({
            admission: useHomeAdministrationSettingsAdmission(),
            catalog: useResolvedSettingsPageCatalog(),
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().admission.admittedServerIds).toEqual([homeB.id]));
            expect(flattenIds(hook.getCurrent().catalog.tree)).toContain('homeAdministration');
            // Entering from Settings says so, so one administrable Home opens its console directly.
            expect(hook.getCurrent().catalog.search('governance')).toContainEqual({ id: 'homeAdministration', route: '/settings/home?entry=settings' });
            expect(hook.getCurrent().catalog.activePageId).toBe('homeAdministration');
            pathnameState.value = '/settings/home';
            await hook.rerender();
            expect(hook.getCurrent().catalog.activePageId).toBe('homeAdministration');
            pathnameState.value = `/settings/home/${homeB.id}/people`;
            await hook.rerender();
            routeParamsState.value = { serverId: homeB.id, providerId: 'provider-one' };
            pathnameState.value = homeAdministrationIdentityProviderEditPath(homeB.id, 'provider-one');
            await hook.rerender();
            expect(hook.getCurrent().catalog.search('issuer')).toContainEqual(expect.objectContaining({
                route: `${pathnameState.value}?setting=homeAdministration.oidc.issuer`,
                setting: expect.objectContaining({ anchor: 'homeAdministration.oidc.issuer' }),
            }));
            // An unrelated Home's route never borrows these params or its display name.
            pathnameState.value = homeAdministrationIdentityProviderEditPath(homeA.id, 'provider-one');
            await hook.rerender();
            expect(hook.getCurrent().catalog.search('issuer').some((result) => result.setting?.anchor === 'homeAdministration.oidc.issuer')).toBe(false);
            routeParamsState.value = { serverId: homeA.id, providerId: 'provider-one' };
            await hook.rerender();
            // Admitting Home B does not admit fields on Home A, even with matching route params.
            expect(hook.getCurrent().catalog.search('issuer').some((result) => result.setting?.anchor === 'homeAdministration.oidc.issuer')).toBe(false);
            await act(async () => await profiles.saveHomeViewState({
                version: 1, groups: [], activeTargetKind: 'server', activeTargetId: homeA.id,
            }));
            await vi.waitFor(() => expect(hook.getCurrent().admission.admitted).toBe(false));
            expect(flattenIds(hook.getCurrent().catalog.tree)).not.toContain('homeAdministration');
            await act(() => project(homeA.id, false, 'setup_required'));
            await vi.waitFor(() => expect(hook.getCurrent().admission.admitted).toBe(true));
            expect(flattenIds(hook.getCurrent().catalog.tree)).toContain('homeAdministration');
        } finally {
            await hook.unmount();
            credentials.mockRestore();
            snapshots.clearHomeGovernanceSnapshotsForServer(homeA.id);
            snapshots.clearHomeGovernanceSnapshotsForServer(homeB.id);
            if (priorView) await profiles.saveHomeViewState(priorView);
            await profiles.removeServerProfile(homeA.id);
            await profiles.removeServerProfile(homeB.id);
        }
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

    it('keeps the generic Machine Pool chooser discoverable without borrowing the focused Home feature decision', async () => {
        featureGateState.enabled = () => false;

        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        expect(flattenIds(hook.getCurrent().tree)).toContain('machinePoolsNew');
        expect(hook.getCurrent().search('machine pools')).toContainEqual({
            id: 'machinePoolsNew',
            route: '/settings/machines/pools/new',
        });

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

    it('offers the prompt registries and external assets pages only while their features are on', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');

        featureGateState.enabled = (featureId: string) => featureId === 'prompts.library'
            || featureId === 'prompts.skills.registries'
            || featureId === 'prompts.assets.external';
        const enabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(flattenIds(enabledHook.getCurrent().tree)).toEqual(expect.arrayContaining(['promptsRegistries', 'promptsAssets']));
        await enabledHook.unmount();

        featureGateState.enabled = (featureId: string) => featureId === 'prompts.library';
        const disabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        const ids = flattenIds(disabledHook.getCurrent().tree);
        expect(ids).toContain('prompts');
        expect(ids).not.toContain('promptsRegistries');
        expect(ids).not.toContain('promptsAssets');
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

    it("finds a page by the search words of the viewer's language", async () => {
        searchWordsState.overrides = { 'settingsSearchKeywords.pets': 'mascotte, compagnon' };
        try {
            const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
            const hook = await renderHook(() => useResolvedSettingsPageCatalog());

            expect(hook.getCurrent().search('mascotte').some((result: any) => result.id === 'pets' && !result.setting)).toBe(true);

            await hook.unmount();
        } finally {
            searchWordsState.overrides = {};
        }
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

    it('finds an individual setting by its own label and points at its row on the page', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        // The mocked translator returns keys, so the setting's label is its title key.
        expect(hook.getCurrent().search('itemDensity')).toContainEqual(expect.objectContaining({
            id: 'appearance',
            route: '/settings/appearance?setting=appearance.density',
            setting: expect.objectContaining({
                anchor: 'appearance.density',
                title: 'settingsAppearance.itemDensity',
                path: ['settings.appearance', 'settingsAppearance.text'],
            }),
        }));
        // Sessions declares its settings too: its label, and its choices as keywords, find the row.
        for (const query of ['startWithTitle', 'startWithWizard']) {
            expect(hook.getCurrent().search(query)).toContainEqual(expect.objectContaining({
                id: 'session',
                route: '/settings/session?setting=session.startWith',
                setting: expect.objectContaining({ anchor: 'session.startWith' }),
            }));
        }
        // Page results keep their existing shape.
        expect(hook.getCurrent().search('teams').every((result: any) => result.setting === undefined || result.id !== 'teams')).toBe(true);

        await hook.unmount();
    });

    it('finds every prospective auto-follow preference at its Notifications row', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());
        for (const field of ['assigned', 'direct', 'team', 'group']) {
            const anchor = `notifications.autoFollow${field[0]!.toUpperCase()}${field.slice(1)}`;
            expect(hook.getCurrent().search(`session.follow.preferences.${field}`)).toContainEqual(expect.objectContaining({
                id: 'notifications',
                route: `/settings/notifications?setting=${anchor}`,
                setting: expect.objectContaining({ anchor }),
            }));
        }
        await hook.unmount();
    });

    it("finds the Settings home's About rows, and the EULA only where it is shown", async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        for (const [query, anchor] of [
            ['whatsNew', 'settings.whatsNew'],
            ['rateUs', 'settings.rateUs'],
            ['supportUs', 'settings.supportUs'],
        ] as const) {
            expect(hook.getCurrent().search(query)).toContainEqual(expect.objectContaining({
                setting: expect.objectContaining({ anchor }),
            }));
        }
        // The test host is the web app; the EULA row renders on iOS only.
        expect(hook.getCurrent().search('eula').some((result: any) => result.setting?.anchor === 'settings.eula')).toBe(false);

        await hook.unmount();
    });

    it('finds a setting on a sub-page that is not in the rail and opens that sub-page at its row', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        // Runtime is reached from Sessions; its settings belong to Sessions but live on their own route.
        expect(hook.getCurrent().search('profiles.tmuxSession')).toContainEqual(expect.objectContaining({
            id: 'session',
            route: '/settings/session/runtime?setting=session.runtime.sessionName',
            setting: expect.objectContaining({
                anchor: 'session.runtime.sessionName',
                path: ['settings.sessions', 'settingsSession.runtime.title', 'settingsSessionPages.runtime.terminalSection'],
            }),
        }));

        await hook.unmount();
    });

    it('lists the pages a query names before the rows of those pages, however many rows match', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());

        // Notifications declares dozens of rows whose path names the page; the page still comes first.
        const results = hook.getCurrent().search('settings.notifications');
        expect(results[0]).toEqual({ id: 'notifications', route: '/settings/notifications' });
        const firstSettingIndex = results.findIndex((result: any) => result.setting);
        const lastPageIndex = results.map((result: any) => !result.setting).lastIndexOf(true);
        expect(firstSettingIndex === -1 || lastPageIndex < firstSettingIndex).toBe(true);
        expect(results.some((result: any) => result.setting?.anchor.startsWith('notifications.'))).toBe(true);

        await hook.unmount();
    });

    it('offers a row only on the hosts where its page renders it', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const commandPalette = expect.objectContaining({
            setting: expect.objectContaining({ anchor: 'features.commandPalette' }),
        });

        // The test host is the web app: the command palette row renders there.
        const webHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(webHook.getCurrent().search('commandPalette')).toContainEqual(commandPalette);
        // Live Activities render only on iOS, so the web app never offers them.
        expect(webHook.getCurrent().search('liveActivities').some((result: any) => result.setting?.anchor === 'notifications.liveActivitiesEnabled')).toBe(false);
        await webHook.unmount();
    });

    it('evaluates every feature a declared section is gated on, with no hand-kept list', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const { SETTINGS_PAGE_DECLARATIONS } = await import('../settingsPageDeclarations');
        const webhookRows = SETTINGS_PAGE_DECLARATIONS
            .flatMap((declaration) => Object.values(declaration.settings))
            .filter((ref) => ref.featureId === 'plugins.webhooks');
        expect(webhookRows.length).toBeGreaterThan(0);

        // Every feature is on here, so a gated row is withheld only when its feature was never evaluated.
        const hook = await renderHook(() => useResolvedSettingsPageCatalog());
        for (const ref of webhookRows) {
            expect(hook.getCurrent().search(ref.titleKey).some((result: any) => result.setting?.anchor === ref.anchor)).toBe(true);
        }
        await hook.unmount();
    });

    it('offers a gated section’s settings only while its feature is on, as the page renders them', async () => {
        const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
        const gaugeWindow = expect.objectContaining({
            setting: expect.objectContaining({ anchor: 'session.providerLimits.gaugeWindow' }),
        });

        const enabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(enabledHook.getCurrent().search('providerUsageGauge.windowTitle')).toContainEqual(gaugeWindow);
        await enabledHook.unmount();

        featureGateState.enabled = (featureId) => featureId !== 'connectedServices.quotas';
        const disabledHook = await renderHook(() => useResolvedSettingsPageCatalog());
        expect(disabledHook.getCurrent().search('providerUsageGauge.windowTitle')).not.toContainEqual(gaugeWindow);
        await disabledHook.unmount();
    });
});
