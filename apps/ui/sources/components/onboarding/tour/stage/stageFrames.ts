import type { StageDevice } from './DeviceFrame';
import type { StageSurfaceId } from './stageSurfaces';
import { STAGE_SPOTLIGHT_TARGET_IDS } from './stageSpotlightTargetIds';

export type StageFrame = Readonly<{
    id: string;
    surface: StageSurfaceId;
    device: StageDevice;
    spotlight?: string;
    zoom: number;
    dim: number;
}>;

export const stageFrames = [
    {
        id: 'sessions-list.hero',
        surface: 'sessions-list',
        device: 'desktop',
        zoom: 1,
        dim: 0,
    },
    {
        id: 'sessions-list.spotlight',
        surface: 'sessions-list',
        device: 'desktop',
        spotlight: STAGE_SPOTLIGHT_TARGET_IDS.attentionGroup,
        zoom: 1.35,
        dim: 0.55,
    },
    {
        id: 'session-view.hero',
        surface: 'session-view',
        device: 'desktop',
        zoom: 1,
        dim: 0,
    },
    {
        id: 'session-view.phone',
        surface: 'session-view',
        device: 'phone',
        zoom: 1,
        dim: 0,
    },
    {
        id: 'session-view.spotlight',
        surface: 'session-view',
        device: 'desktop',
        spotlight: STAGE_SPOTLIGHT_TARGET_IDS.composerQueue,
        zoom: 1.35,
        dim: 0.55,
    },
    {
        id: 'relay-settings.hero',
        surface: 'relay-settings',
        device: 'desktop',
        zoom: 1,
        dim: 0,
    },
    {
        id: 'relay-settings.spotlight',
        surface: 'relay-settings',
        device: 'desktop',
        spotlight: 'settings.server.openSetupWizard',
        zoom: 1.55,
        dim: 0.5,
    },
    {
        id: 'machines-settings.hero',
        surface: 'machines-settings',
        device: 'desktop',
        zoom: 1,
        dim: 0,
    },
    {
        id: 'machines-settings.spotlight',
        surface: 'machines-settings',
        device: 'desktop',
        spotlight: 'settings.machines.openWizard.setupThisComputer',
        zoom: 1.55,
        dim: 0.5,
    },
    // Feature-showcase dream beats. These real screens do not expose registered
    // spotlight targets, so composition varies by framing (wide hero vs punch-in
    // detail) rather than by halo — the camera engine reads zoom from these.
    {
        // A3: punch in on the real cockpit the terminal work moves into.
        id: 'session-view.detail',
        surface: 'session-view',
        device: 'desktop',
        zoom: 1.3,
        dim: 0,
    },
    {
        // A5: wide read of the subagents roster.
        id: 'subagents.hero',
        surface: 'subagents',
        device: 'desktop',
        zoom: 1,
        dim: 0,
    },
    {
        // A8: punch in on the seeded review-comment feedback loop.
        id: 'review.detail',
        surface: 'review',
        device: 'desktop',
        zoom: 1.3,
        dim: 0,
    },
    {
        // A9: wide read of the source-control controls.
        id: 'source-control.hero',
        surface: 'source-control',
        device: 'desktop',
        zoom: 1,
        dim: 0,
    },
    {
        // A10: gentle push toward the resting voice panel.
        id: 'voice.hero',
        surface: 'voice',
        device: 'desktop',
        zoom: 1.1,
        dim: 0,
    },
    {
        // A11: wide read of the MCP server catalog.
        id: 'mcp-servers.hero',
        surface: 'mcp-servers',
        device: 'desktop',
        zoom: 1,
        dim: 0,
    },
    {
        // A12: wide read of connected accounts + pools.
        id: 'connected-services.hero',
        surface: 'connected-services',
        device: 'desktop',
        zoom: 1,
        dim: 0,
    },
    {
        // A13: slight push to bring the theme swatches forward.
        id: 'theme-profiles.hero',
        surface: 'theme-profiles',
        device: 'desktop',
        zoom: 1.15,
        dim: 0,
    },
] as const satisfies readonly StageFrame[];

export const stageFrameById = new Map<string, StageFrame>(
    stageFrames.map((frame) => [frame.id, frame]),
);
