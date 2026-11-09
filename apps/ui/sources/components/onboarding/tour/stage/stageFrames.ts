import type { StageDevice } from './DeviceFrame';
import { stageSurfaceById, type StageSurfaceId } from './stageSurfaces';
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
    { id: 'triage.hero', surface: 'triage', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'channels.hero', surface: 'channels', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'computer.hero', surface: 'computer', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'team.credential-usage', surface: 'team-credential-usage', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'browser.session', surface: 'browser-session', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'providers.choice', surface: 'session-choice', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'machine-share.hero', surface: 'machine-share', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'store.install-result', surface: 'store-install-result', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'discussion.hero', surface: 'discussion', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'bots.hero', surface: 'bots', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'session-share.hero', surface: 'session-share', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'team.hero', surface: 'team', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'store.hero', surface: 'store', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'store.listing', surface: 'store-listing', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'store.library', surface: 'skills', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'providers.hero', surface: 'providers', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'accounts.hero', surface: 'accounts', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'browser.hero', surface: 'browser', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'home.hero', surface: 'home', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'home.phone', surface: 'home', device: 'phone', zoom: 1, dim: 0 },
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
        spotlight: 'settings.machines.addMenu.trigger',
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
    { id: 'workflow-run.hero', surface: 'workflow-run', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'deployments.hero', surface: 'deployments', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'delegated-work.hero', surface: 'delegated-work', device: 'desktop', zoom: 1, dim: 0 },
    // The tool-detail conversation owns the real local-worker recipient picker.
    { id: 'subagent-popover', surface: 'delegated-tool-detail', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'subagents.cross-agent', surface: 'delegated-work', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'session-handoff.hero', surface: 'session-handoff', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'control-room.phone', surface: 'delegated-work', device: 'phone', zoom: 1, dim: 0 },
] as const satisfies readonly StageFrame[];

export const stageFrameById = new Map<string, StageFrame>(
    stageFrames.map((frame) => [frame.id, frame]),
);

/**
 * Frame resolution is surface-aware here, at the single frame owner.
 *
 * A frame's `device` is the canvas it was art-directed for, and a presentation
 * that can host the desktop window plays it verbatim — including A4's deliberate
 * phone-inside-desktop cockpit. A phone-width presentation cannot host the
 * 1280x800 window (it lands near 0.2 scale, which renders the app shell
 * unreadable), so it asks for the phone canvas and gets it for every frame whose
 * surface registers phone support.
 *
 * Device capability already has an owner — `stageSurfaces[].devices` — so this
 * reads that registry instead of declaring per-device frame rows: a phone variant
 * differs ONLY by canvas, and a parallel phone frame list would be a second
 * mapping table to keep in sync with every id, spotlight, zoom and dim.
 */
export function resolveStageFrameDevice(frame: StageFrame, hostDevice: StageDevice): StageDevice {
    if (hostDevice !== 'phone' || frame.device === 'phone') return frame.device;
    return stageSurfaceById.get(frame.surface)?.devices.includes('phone') === true ? 'phone' : frame.device;
}

const phoneHostedStageFrames: readonly StageFrame[] = stageFrames.map((frame) => {
    const device = resolveStageFrameDevice(frame, 'phone');
    return device === frame.device ? frame : { ...frame, device };
});

/**
 * The frame list for a presentation whose largest hostable canvas is `hostDevice`.
 * Ids, order and camera data are preserved, so frame lookups and the stage's
 * neighbour mounting are unaffected — only the canvas can change.
 */
export function resolveStageFramesForHostDevice(hostDevice: StageDevice): readonly StageFrame[] {
    return hostDevice === 'phone' ? phoneHostedStageFrames : stageFrames;
}
