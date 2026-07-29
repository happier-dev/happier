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

function cacheStageSurfaceLoader(loader: () => Promise<StageSurfaceModule>): () => Promise<StageSurfaceModule> {
    let cachedPromise: Promise<StageSurfaceModule> | null = null;
    return () => {
        cachedPromise ??= loader();
        return cachedPromise;
    };
}

const loadSessionsListStageSurface = cacheStageSurfaceLoader(async () => {
    const appShellModule = await import('./StageAppShell');

    function SessionsListStageSurfaceComponent(props: Readonly<{ device: StageDevice }>): React.ReactElement {
        return React.createElement(appShellModule.StageAppShell, {
            device: props.device,
            surface: 'sessions-list',
        });
    }

    return { default: SessionsListStageSurfaceComponent };
});

const SessionsListStageSurface = React.lazy(loadSessionsListStageSurface);

const loadSessionViewStageSurface = cacheStageSurfaceLoader(async () => {
    const appShellModule = await import('./StageAppShell');

    function SessionViewStageSurfaceComponent(props: Readonly<{ device: StageDevice }>): React.ReactElement {
        return React.createElement(appShellModule.StageAppShell, {
            device: props.device,
            surface: 'session-view',
        });
    }

    return { default: SessionViewStageSurfaceComponent };
});

const SessionViewStageSurface = React.lazy(loadSessionViewStageSurface);

const loadRelaySettingsStageSurface = cacheStageSurfaceLoader(async () => {
    const serverSettingsModule = await import('@/components/settings/server/screens/ServerSettingsScreen');

    return { default: serverSettingsModule.ServerSettingsScreen };
});

const RelaySettingsStageSurface = React.lazy(loadRelaySettingsStageSurface);

const loadMachinesSettingsStageSurface = cacheStageSurfaceLoader(async () => {
    const machinesSettingsModule = await import('@/components/settings/machines/MachinesSettingsView');

    return { default: machinesSettingsModule.MachinesSettingsView };
});

const MachinesSettingsStageSurface = React.lazy(loadMachinesSettingsStageSurface);

// Feature-showcase dream beats mount real, prop-free settings screens exactly
// like relay/machines above — each reads the seeded store and renders offline.
const loadSubagentsStageSurface = cacheStageSurfaceLoader(async () => {
    const module = await import('@/components/settings/subAgent/SubAgentSettingsView');
    return { default: module.SubAgentSettingsView };
});
const SubagentsStageSurface = React.lazy(loadSubagentsStageSurface);

const loadSourceControlStageSurface = cacheStageSurfaceLoader(async () => {
    const module = await import('@/components/settings/sourceControl/SourceControlSettingsView');
    return { default: module.SourceControlSettingsView };
});
const SourceControlStageSurface = React.lazy(loadSourceControlStageSurface);

const loadMcpServersStageSurface = cacheStageSurfaceLoader(async () => {
    const module = await import('@/components/settings/mcpServers/McpServersSettingsScreen');
    return { default: module.McpServersSettingsScreen };
});
const McpServersStageSurface = React.lazy(loadMcpServersStageSurface);

const loadConnectedServicesStageSurface = cacheStageSurfaceLoader(async () => {
    const module = await import('@/components/settings/connectedServices/ConnectedServicesSettingsView');
    return { default: module.ConnectedServicesSettingsView };
});
const ConnectedServicesStageSurface = React.lazy(loadConnectedServicesStageSurface);

const loadThemeProfilesStageSurface = cacheStageSurfaceLoader(async () => {
    const module = await import('@/components/settings/appearance/themeProfiles/ThemeProfilesSettingsScreen');
    return { default: module.ThemeProfilesSettingsScreen };
});
const ThemeProfilesStageSurface = React.lazy(loadThemeProfilesStageSurface);

// A8 review reuses the real desktop split, pointing the detail owner at the
// seeded review session (its review-comment drafts render the diff feedback loop).
const loadReviewStageSurface = cacheStageSurfaceLoader(async () => {
    const [{ StageAppShell }, { DEMO_REVIEW_SESSION_ID }] = await Promise.all([
        import('./StageAppShell'),
        import('@/demoMode/world/constants'),
    ]);
    function ReviewStageSurfaceComponent(props: Readonly<{ device: StageDevice }>): React.ReactElement {
        return React.createElement(StageAppShell, {
            device: props.device,
            surface: 'session-view',
            sessionId: DEMO_REVIEW_SESSION_ID,
            detailTestID: 'demo-stage-review-detail',
        });
    }
    return { default: ReviewStageSurfaceComponent };
});
const ReviewStageSurface = React.lazy(loadReviewStageSurface);

const loadVoiceStageSurface = cacheStageSurfaceLoader(async () => {
    const module = await import('./surfaces/JourneyVoiceStageSurface');
    return { default: module.JourneyVoiceStageSurface };
});
const VoiceStageSurface = React.lazy(loadVoiceStageSurface);

const stageSurfaceLoaders = new Map<StageSurfaceId, () => Promise<StageSurfaceModule>>([
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
