import * as React from 'react';

import type { StageDevice } from './DeviceFrame';

export const STAGE_SURFACE_IDS = [
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
] as const;

export type StageSurfaceId = typeof STAGE_SURFACE_IDS[number];
export type StageSurfaceTier = 'A' | 'B' | 'C';
export type StageWorldSeed = 'sessions' | 'messages' | 'machines' | 'settings' | 'server';
export type StageSurfaceComponent = React.ComponentType<Readonly<{ device: StageDevice }>>;
type StageSurfaceModule = Readonly<{ default: StageSurfaceComponent }>;

export type StageSurface = Readonly<{
    id: StageSurfaceId;
    component: React.LazyExoticComponent<StageSurfaceComponent>;
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

const loadRelaySettingsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const serverSettingsModule = await import('@/components/settings/server/screens/ServerSettingsScreen');

    return { default: serverSettingsModule.ServerSettingsScreen };
});

const RelaySettingsStageSurface = React.lazy(loadRelaySettingsStageSurface);

const loadMachinesSettingsStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const machinesSettingsModule = await import('@/components/settings/machines/MachinesSettingsView');

    return { default: machinesSettingsModule.MachinesSettingsView };
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
    const module = await import('@/components/settings/mcpServers/McpServersSettingsScreen');
    return { default: module.McpServersSettingsScreen };
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

// A8 review reuses the real desktop split, pointing the detail owner at the
// seeded review session (its review-comment drafts render the diff feedback loop).
const loadReviewStageSurface = cacheStageSurfaceLoader<StageSurfaceModule>(async () => {
    const [{ StageAppShell }, { DEMO_REVIEW_SESSION_ID }, sessionDetailModule] = await Promise.all([
        import('./StageAppShell'),
        import('@/demoMode/world/constants'),
        loadStageSessionDetail(),
    ]);
    function ReviewStageSurfaceComponent(props: Readonly<{ device: StageDevice }>): React.ReactElement {
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
        id: 'sessions-list',
        component: SessionsListStageSurface,
        seeds: ['sessions', 'messages', 'machines', 'settings', 'server'],
        tier: 'A',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'session-view',
        component: SessionViewStageSurface,
        seeds: ['sessions', 'messages', 'machines', 'settings', 'server'],
        tier: 'A',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'relay-settings',
        component: RelaySettingsStageSurface,
        seeds: ['server', 'settings'],
        tier: 'A',
        devices: ['desktop'],
    },
    {
        id: 'machines-settings',
        component: MachinesSettingsStageSurface,
        seeds: ['machines', 'settings', 'server'],
        tier: 'A',
        devices: ['desktop'],
    },
    {
        id: 'subagents',
        component: SubagentsStageSurface,
        seeds: ['settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'review',
        component: ReviewStageSurface,
        seeds: ['sessions', 'messages', 'settings', 'server'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'source-control',
        component: SourceControlStageSurface,
        seeds: ['settings', 'server'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'voice',
        component: VoiceStageSurface,
        seeds: ['sessions', 'settings', 'server'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'mcp-servers',
        component: McpServersStageSurface,
        seeds: ['settings', 'server', 'machines'],
        tier: 'B',
        devices: ['desktop'],
    },
    {
        id: 'connected-services',
        component: ConnectedServicesStageSurface,
        seeds: ['settings', 'server'],
        tier: 'B',
        devices: ['desktop', 'phone'],
    },
    {
        id: 'theme-profiles',
        component: ThemeProfilesStageSurface,
        seeds: ['settings'],
        tier: 'B',
        devices: ['desktop'],
    },
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
