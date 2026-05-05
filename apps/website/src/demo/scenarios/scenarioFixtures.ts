import type {
    BeatCamera,
    BeatMedia,
    DemoBridgeState,
    DemoScenarioId,
    DemoState,
    DemoSurfaceView,
    DeviceFocus,
    ScenarioBeat,
    ScenarioEvent,
    TerminalBeatState,
    VoiceBeatState,
} from '../timeline/scenarioTypes';
import { authSkeletonMessages } from './demoTranscriptFixtures';

export const emptyDemoState: DemoState = {
    sessionTitle: 'Happier',
    sessionMeta: '',
    messageCount: 0,
    messages: [],
    permission: null,
    terminal: [],
    activityChip: null,
    phoneNotification: null,
    syncPulseKey: 0,
    syncDirection: 'forward',
};

export function createInitialBridgeState(
    scenarioId: DemoScenarioId,
    activeView: DemoSurfaceView,
): DemoBridgeState {
    return {
        scenarioId,
        beatId: 'boot',
        activeView,
        sessions: [
            {
                id: 's-auth-skeleton',
                title: 'Dashboard auth skeleton',
                provider: 'Claude',
                status: 'running',
                machineId: 'm-macbook-pro',
                path: '/Users/demo/code/happier',
                startedBy: 'terminal',
            },
        ],
        messagesBySession: {
            's-auth-skeleton': authSkeletonMessages,
        },
        machines: [
            {
                id: 'm-macbook-pro',
                name: 'MacBook Pro',
                status: 'online',
                path: '/Users/demo/code/happier',
            },
        ],
        profile: { id: 'u-demo', name: 'Demo' },
        activeSessionId: 's-auth-skeleton',
        permissionsBySession: {},
        terminal: { lines: [], commands: [] },
        syncPulseKey: 0,
    };
}

export function createBeat(args: {
    id: string;
    atMs: number;
    durationMs: number;
    focus: DeviceFocus;
    visibleSurfaces: readonly (DemoSurfaceView | 'terminal')[];
    state?: Partial<DemoState>;
    terminal?: TerminalBeatState;
    voice?: VoiceBeatState;
    bridgePatch?: ScenarioBeat['bridgePatch'];
    events?: readonly ScenarioEvent[];
    /** Human-readable caption for the NarrativeLayer (captions/character variants). */
    label?: string;
    /** Per-surface screenshots/recordings to display during this beat. */
    media?: BeatMedia;
    /** Camera framing override (zoom + offset) for cinematic punch-in beats. */
    camera?: BeatCamera;
}): ScenarioBeat {
    const terminal = args.terminal
        ? {
              ...args.terminal,
              commands: args.terminal.commands ?? [],
          }
        : undefined;
    const state = {
        ...emptyDemoState,
        ...args.state,
        terminal: [...(terminal?.lines ?? args.state?.terminal ?? [])],
    };

    return {
        id: args.id,
        label: args.label ?? args.id,
        at: args.atMs,
        atMs: args.atMs,
        duration: args.durationMs,
        durationMs: args.durationMs,
        focus: args.focus,
        visibleSurfaces: args.visibleSurfaces,
        state,
        terminal,
        voice: args.voice,
        bridgePatch: {
            beatId: args.id,
            activeView: args.visibleSurfaces.find((surface) => surface !== 'terminal') as
                | DemoSurfaceView
                | undefined,
            terminal,
            syncPulseKey: state.syncPulseKey,
            ...args.bridgePatch,
        },
        events: args.events,
        media: args.media,
        camera: args.camera,
    };
}
