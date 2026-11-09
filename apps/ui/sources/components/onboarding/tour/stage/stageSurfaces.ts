import * as React from 'react';

import type { StageDevice } from './DeviceFrame';

export const STAGE_SURFACE_IDS = [
    'home',
    'sessions-list',
    'session-view',
    'relay-settings',
    'machines-settings',
    'subagents',
    'review',
    'source-control',
    'voice',
    'mcp-servers',
    'connected-services',
    'theme-profiles',
    'workflow-run',
    'deployments',
    'delegated-work',
    'delegated-tool-detail',
    'session-handoff',
    'bots',
    'session-share',
    'store',
    'providers',
    'accounts',
    'browser',
    'store-listing',
    'skills',
    'discussion',
    'team',
    'browser-session',
    'session-choice',
    'machine-share',
    'store-install-result',
    'team-credential-usage',
    'computer',
    'channels',
    'triage',
] as const;

export type StageSurfaceId = typeof STAGE_SURFACE_IDS[number];
export type StageSurfaceTier = 'A' | 'B' | 'C';
export type StageWorldSeed = 'sessions' | 'messages' | 'machines' | 'settings' | 'server';
export type StageSurfaceComponent = React.ComponentType<Readonly<{ device: StageDevice }>>;
type StageSurfaceModule = Readonly<{ default: StageSurfaceComponent }>;

export type StageSurface = Readonly<{
    id: StageSurfaceId;
    component: React.LazyExoticComponent<StageSurfaceComponent>;
    /** Capture restores the device boundary omitted by bare route bodies. */
    phoneSafeArea: 'surface' | 'capture';
    seeds: readonly StageWorldSeed[];
    tier: StageSurfaceTier;
    devices: readonly StageDevice[];
}>;

export type CachedStageModuleLoader<TModule> = (() => Promise<TModule>) & Readonly<{ reset: () => void }>;

/**
 * Caches the RESOLVED module only. Caching the promise unconditionally also
 * cached rejections: one failed chunk poisoned that surface for the rest of the
 * session, and because `React.lazy` additionally freezes its own rejected state
 * the beat could never recover. A failed load therefore drops the cache entry so
 * the next attempt re-imports.
 *
 * `reset` drops a SUCCESSFUL cache entry as well, so a surface whose composition
 * captured a now-poisoned nested lazy can be rebuilt from scratch; see
 * `resetStageSurfaceComponent`.
 */
export function cacheStageSurfaceLoader<TModule>(loader: () => Promise<TModule>): CachedStageModuleLoader<TModule> {
    let cachedPromise: Promise<TModule> | null = null;
    const load = (): Promise<TModule> => {
        const cached = cachedPromise;
        if (cached) return cached;
        const pending = loader().catch((error: unknown) => {
            if (cachedPromise === pending) cachedPromise = null;
            throw error;
        });
        cachedPromise = pending;
        return pending;
    };
    load.reset = (): void => {
        cachedPromise = null;
    };
    return load;
}

const loadStageSessionDetail = cacheStageSurfaceLoader(async () => {
    const module = await import('./StageSessionDetail');
    return { default: module.StageSessionDetail };
});

const loadSessionsListStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    // The fallbacks module is imported here rather than at module scope so this
    // registry keeps its own graph free of UI modules; the stage already holds it
    // eagerly, so this resolves from cache.
    const [appShellModule, { StageDetailSkeleton }] = await Promise.all([
        import('./StageAppShell'),
        import('./StageSurfaceFallbacks'),
    ]);
    // Streamed session cockpit: this beat's subject is the LIST, so the sidebar
    // paints as soon as the shell chunk lands instead of waiting for
    // `SessionView`'s import graph, and the detail fills in behind a skeleton.
    // The lazy is built per loader run so resetting this surface also replaces it.
    const StreamedStageSessionDetail = React.lazy(loadStageSessionDetail);

    function SessionsListStageSurfaceComponent(props: Readonly<{ device: StageDevice }>): React.ReactElement {
        return React.createElement(appShellModule.StageAppShell, {
            device: props.device,
            surface: 'sessions-list',
            detail: React.createElement(
                React.Suspense,
                { fallback: React.createElement(StageDetailSkeleton, {}) },
                React.createElement(StreamedStageSessionDetail, {}),
            ),
        });
    }

    return { default: SessionsListStageSurfaceComponent };
});

const SessionsListStageSurface = React.lazy(loadSessionsListStageSurface);

const loadSessionViewStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    // The session IS the subject here, so the surface only resolves once the
    // cockpit is ready — no visible skeleton-to-content swap under the camera.
    const [appShellModule, sessionDetailModule] = await Promise.all([
        import('./StageAppShell'),
        loadStageSessionDetail(),
    ]);

    function SessionViewStageSurfaceComponent(props: Readonly<{ device: StageDevice }>): React.ReactElement {
        return React.createElement(appShellModule.StageAppShell, {
            device: props.device,
            surface: 'session-view',
            detail: React.createElement(sessionDetailModule.default, {}),
        });
    }

    return { default: SessionViewStageSurfaceComponent };
});

const SessionViewStageSurface = React.lazy(loadSessionViewStageSurface);

const loadHomeStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const [{ StageAppShell }, { HomeHub }] = await Promise.all([
        import('./StageAppShell'),
        import('@/components/hub/HomeHub'),
    ]);
    return { default: ({ device }) => React.createElement(StageAppShell, {
        device, surface: 'home', detail: React.createElement(HomeHub),
    }) };
});
const HomeStageSurface = React.lazy(loadHomeStageSurface);

const loadRelaySettingsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const homesModule = await import('@/components/settings/server/collection/HomesSettingsIndex');

    return { default: homesModule.HomesSettingsStageSurface };
});

const RelaySettingsStageSurface = React.lazy(loadRelaySettingsStageSurface);

const loadMachinesSettingsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const machinesIndexModule = await import('@/components/machines/index/AllMachinesIndex');

    return { default: machinesIndexModule.AllMachinesIndex };
});

const MachinesSettingsStageSurface = React.lazy(loadMachinesSettingsStageSurface);

// Feature-showcase dream beats mount real, prop-free settings screens exactly
// like relay/machines above — each reads the seeded store and renders offline.
const loadSubagentsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('@/components/settings/subAgent/SubAgentSettingsView');
    return { default: module.SubAgentSettingsView };
});
const SubagentsStageSurface = React.lazy(loadSubagentsStageSurface);

const loadSourceControlStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('@/components/settings/sourceControl/SourceControlSettingsView');
    return { default: module.SourceControlSettingsView };
});
const SourceControlStageSurface = React.lazy(loadSourceControlStageSurface);

const loadMcpServersStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('@/components/settings/mcpServers/collection/McpServerCollection');
    return { default: () => React.createElement(module.McpServerCollection, { variant: 'page' }) };
});
const McpServersStageSurface = React.lazy(loadMcpServersStageSurface);

const loadConnectedServicesStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('@/components/settings/connectedServices/ConnectedServicesSettingsView');
    return { default: module.ConnectedServicesSettingsView };
});
const ConnectedServicesStageSurface = React.lazy(loadConnectedServicesStageSurface);

const loadThemeProfilesStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('@/components/settings/appearance/themeProfiles/ThemeProfilesSettingsScreen');
    return { default: module.ThemeProfilesSettingsScreen };
});
const ThemeProfilesStageSurface = React.lazy(loadThemeProfilesStageSurface);

const loadWorkflowRunStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/WorkflowRunStageSurface');
    return { default: module.WorkflowRunStageSurface };
});
const WorkflowRunStageSurface = React.lazy(loadWorkflowRunStageSurface);

const loadDeploymentsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/DeploymentsStageSurface');
    return { default: module.DeploymentsStageSurface };
});
const DeploymentsStageSurface = React.lazy(loadDeploymentsStageSurface);

const loadDelegatedWorkStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/FeatureSessionStageSurface');
    return { default: module.DelegatedWorkStageSurface };
});
const DelegatedWorkStageSurface = React.lazy(loadDelegatedWorkStageSurface);

const loadDelegatedToolDetailStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/DelegatedToolDetailStageSurface');
    return { default: module.DelegatedToolDetailStageSurface };
});
const DelegatedToolDetailStageSurface = React.lazy(loadDelegatedToolDetailStageSurface);

const loadSessionHandoffStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/FeatureSessionStageSurface');
    return { default: module.SessionHandoffStageSurface };
});
const SessionHandoffStageSurface = React.lazy(loadSessionHandoffStageSurface);

const loadBotsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/BotsStageSurface');
    return { default: module.BotsStageSurface };
});
const BotsStageSurface = React.lazy(loadBotsStageSurface);

const loadSessionShareStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/SessionShareStageSurface');
    return { default: module.SessionShareStageSurface };
});
const SessionShareStageSurface = React.lazy(loadSessionShareStageSurface);

const loadStoreStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/StoreStageSurface');
    return { default: module.StoreStageSurface };
});
const StoreStageSurface = React.lazy(loadStoreStageSurface);

const loadProvidersStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/ProvidersStageSurface');
    return { default: module.ProvidersStageSurface };
});
const ProvidersStageSurface = React.lazy(loadProvidersStageSurface);

const loadAccountsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/AccountsStageSurface');
    return { default: module.AccountsStageSurface };
});
const AccountsStageSurface = React.lazy(loadAccountsStageSurface);

const loadBrowserStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/BrowserStageSurface');
    return { default: module.BrowserStageSurface };
});
const BrowserStageSurface = React.lazy(loadBrowserStageSurface);

const loadStoreListingStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/StoreListingStageSurface');
    return { default: module.StoreListingStageSurface };
});
const StoreListingStageSurface = React.lazy(loadStoreListingStageSurface);

const loadSkillsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/SkillsStageSurface');
    return { default: module.SkillsStageSurface };
});
const SkillsStageSurface = React.lazy(loadSkillsStageSurface);

const loadDiscussionStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/DiscussionStageSurface');
    return { default: module.DiscussionStageSurface };
});
const DiscussionStageSurface = React.lazy(loadDiscussionStageSurface);

const loadTeamStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/TeamStageSurface');
    return { default: module.TeamStageSurface };
});
const TeamStageSurface = React.lazy(loadTeamStageSurface);

const loadBrowserSessionStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/BrowserSessionStageSurface');
    return { default: module.BrowserSessionStageSurface };
});
const BrowserSessionStageSurface = React.lazy(loadBrowserSessionStageSurface);

const loadTeamCredentialUsageStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/TeamCredentialUsageStageSurface');
    return { default: module.TeamCredentialUsageStageSurface };
});
const TeamCredentialUsageStageSurface = React.lazy(loadTeamCredentialUsageStageSurface);
const loadNewSessionChoiceStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/NewSessionChoiceStageSurface');
    return { default: module.NewSessionChoiceStageSurface };
});
const NewSessionChoiceStageSurface = React.lazy(loadNewSessionChoiceStageSurface);
const loadMachineShareStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/MachineShareStageSurface');
    return { default: module.MachineShareStageSurface };
});
const MachineShareStageSurface = React.lazy(loadMachineShareStageSurface);
const loadStoreInstallResultStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/StoreListingStageSurface');
    return { default: module.StoreInstallResultStageSurface };
});
const StoreInstallResultStageSurface = React.lazy(loadStoreInstallResultStageSurface);
const loadComputerStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/ComputerStageSurface');
    return { default: module.ComputerStageSurface };
});
const ComputerStageSurface = React.lazy(loadComputerStageSurface);
const loadChannelsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/ChannelsStageSurface');
    return { default: module.ChannelsStageSurface };
});
const ChannelsStageSurface = React.lazy(loadChannelsStageSurface);
const loadTriageStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/TriageStageSurface');
    return { default: module.TriageStageSurface };
});
const TriageStageSurface = React.lazy(loadTriageStageSurface);

// A8 review reuses the real desktop split, pointing the detail owner at the
// seeded review session (its review-comment drafts render the diff feedback loop).
const loadReviewStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const [{ StageAppShell }, { DEMO_REVIEW_SESSION_ID }, sessionDetailModule, { ReviewPhoneStageSurface }, { StagePhoneNavigationHost }] = await Promise.all([
        import('./StageAppShell'),
        import('@/demoMode/world/constants'),
        loadStageSessionDetail(),
        import('./surfaces/ReviewPhoneStageSurface'),
        import('./StagePhoneNavigationHost'),
    ]);
    function ReviewStageSurfaceComponent(props: Readonly<{ device: StageDevice }>): React.ReactElement {
        if (props.device === 'phone') return React.createElement(StagePhoneNavigationHost, {
            surface: 'review', children: React.createElement(ReviewPhoneStageSurface, props),
        });
        return React.createElement(StageAppShell, {
            device: props.device,
            surface: 'session-view',
            detail: React.createElement(sessionDetailModule.default, { sessionId: DEMO_REVIEW_SESSION_ID }),
            detailTestID: 'demo-stage-review-detail',
        });
    }
    return { default: ReviewStageSurfaceComponent };
});
const ReviewStageSurface = React.lazy(loadReviewStageSurface);

const loadVoiceStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const module = await import('./surfaces/JourneyVoiceStageSurface');
    return { default: module.JourneyVoiceStageSurface };
});
const VoiceStageSurface = React.lazy(loadVoiceStageSurface);

const stageSurfaceLoaders = new Map<StageSurfaceId, CachedStageModuleLoader<StageSurfaceModule>>([
    ['home', loadHomeStageSurface],
    ['sessions-list', loadSessionsListStageSurface],
    ['session-view', loadSessionViewStageSurface],
    ['relay-settings', loadRelaySettingsStageSurface],
    ['machines-settings', loadMachinesSettingsStageSurface],
    ['subagents', loadSubagentsStageSurface],
    ['review', loadReviewStageSurface],
    ['source-control', loadSourceControlStageSurface],
    ['voice', loadVoiceStageSurface],
    ['mcp-servers', loadMcpServersStageSurface],
    ['connected-services', loadConnectedServicesStageSurface],
    ['theme-profiles', loadThemeProfilesStageSurface],
    ['workflow-run', loadWorkflowRunStageSurface],
    ['deployments', loadDeploymentsStageSurface],
    ['delegated-work', loadDelegatedWorkStageSurface],
    ['delegated-tool-detail', loadDelegatedToolDetailStageSurface],
    ['session-handoff', loadSessionHandoffStageSurface],
    ['bots', loadBotsStageSurface],
    ['session-share', loadSessionShareStageSurface],
    ['store', loadStoreStageSurface],
    ['providers', loadProvidersStageSurface],
    ['accounts', loadAccountsStageSurface],
    ['browser', loadBrowserStageSurface],
    ['store-listing', loadStoreListingStageSurface],
    ['skills', loadSkillsStageSurface],
    ['discussion', loadDiscussionStageSurface],
    ['team', loadTeamStageSurface],
    ['browser-session', loadBrowserSessionStageSurface],
    ['session-choice', loadNewSessionChoiceStageSurface],
    ['machine-share', loadMachineShareStageSurface],
    ['store-install-result', loadStoreInstallResultStageSurface],
    ['team-credential-usage', loadTeamCredentialUsageStageSurface],
    ['computer', loadComputerStageSurface],
    ['channels', loadChannelsStageSurface],
    ['triage', loadTriageStageSurface],
]);

export async function preloadStageSurfaces(surfaceIds: readonly StageSurfaceId[]): Promise<void> {
    await Promise.all(Array.from(new Set(surfaceIds)).map(async (surfaceId) => {
        const loader = stageSurfaceLoaders.get(surfaceId);
        if (!loader) return;
        await loader();
    }));
}

export const stageSurfaces = [
    {
        id: 'home',
        component: HomeStageSurface,
        phoneSafeArea: 'surface',
        seeds: ['sessions', 'messages', 'machines', 'settings', 'server'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'sessions-list',
        component: SessionsListStageSurface,
        phoneSafeArea: 'surface',
        seeds: ['sessions', 'messages', 'machines', 'settings', 'server'],
        tier: 'A',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'session-view',
        component: SessionViewStageSurface,
        phoneSafeArea: 'surface',
        seeds: ['sessions', 'messages', 'machines', 'settings', 'server'],
        tier: 'A',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'relay-settings',
        component: RelaySettingsStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['server', 'settings'],
        tier: 'A',
        devices: ['desktop'],
    },
    {
        id: 'machines-settings',
        component: MachinesSettingsStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['machines', 'settings', 'server'],
        tier: 'A',
        devices: ['desktop'],
    },
    {
        id: 'subagents',
        component: SubagentsStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'review',
        component: ReviewStageSurface,
        phoneSafeArea: 'surface',
        seeds: ['sessions', 'messages', 'settings', 'server'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'source-control',
        component: SourceControlStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['settings', 'server'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'voice',
        component: VoiceStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['sessions', 'settings', 'server'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'mcp-servers',
        component: McpServersStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'connected-services',
        component: ConnectedServicesStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['settings', 'server'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'theme-profiles',
        component: ThemeProfilesStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['settings'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'workflow-run',
        component: WorkflowRunStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'deployments',
        component: DeploymentsStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'delegated-work',
        component: DelegatedWorkStageSurface,
        phoneSafeArea: 'surface',
        seeds: ['sessions', 'messages', 'settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'delegated-tool-detail',
        component: DelegatedToolDetailStageSurface,
        phoneSafeArea: 'capture',
        seeds: ['sessions', 'messages', 'settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'session-handoff',
        component: SessionHandoffStageSurface,
        phoneSafeArea: 'surface',
        seeds: ['sessions', 'messages', 'settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    { id: 'bots', component: BotsStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server', 'sessions'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'session-share', component: SessionShareStageSurface, phoneSafeArea: 'capture', seeds: [], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'store', component: StoreStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'providers', component: ProvidersStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'accounts', component: AccountsStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'browser', component: BrowserStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop'] },
    { id: 'store-listing', component: StoreListingStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'skills', component: SkillsStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'discussion', component: DiscussionStageSurface, phoneSafeArea: 'capture', seeds: ['sessions', 'settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'team', component: TeamStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'browser-session', component: BrowserSessionStageSurface, phoneSafeArea: 'surface', seeds: ['sessions', 'messages', 'settings', 'server', 'machines'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'session-choice', component: NewSessionChoiceStageSurface, phoneSafeArea: 'capture', seeds: ['sessions', 'settings', 'server', 'machines'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'machine-share', component: MachineShareStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server', 'machines'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'store-install-result', component: StoreInstallResultStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'team-credential-usage', component: TeamCredentialUsageStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'computer', component: ComputerStageSurface, phoneSafeArea: 'capture', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'channels', component: ChannelsStageSurface, phoneSafeArea: 'surface', seeds: ['settings', 'server'], tier: 'B', devices: ['desktop', 'phone'] },
    { id: 'triage', component: TriageStageSurface, phoneSafeArea: 'surface', seeds: ['settings', 'server', 'sessions', 'machines'], tier: 'B', devices: ['desktop', 'phone'] },
] as const satisfies readonly StageSurface[];

export const stageSurfaceById = new Map<StageSurfaceId, StageSurface>(
    stageSurfaces.map((surface) => [surface.id, surface]),
);

/**
 * `React.lazy` remembers a rejected import forever (its payload flips to a
 * permanent rejected status), so clearing the loader cache alone would never let
 * a failed surface recover. Replacing the lazy component is the only retry seam:
 * the next mount of this surface builds a new payload and re-runs the loader.
 */
export function resetStageSurfaceComponent(surfaceId: StageSurfaceId): void {
    const surface = stageSurfaceById.get(surfaceId);
    const loader = stageSurfaceLoaders.get(surfaceId);
    if (!surface || !loader) return;
    // Dropping the resolved module too: a surface can fail because a chunk it
    // COMPOSES failed, and that nested lazy is captured inside the cached module.
    // Re-running the loader is cheap (its imports are already bundler-cached).
    loader.reset();
    stageSurfaceById.set(surfaceId, { ...surface, component: React.lazy(loader) });
}
