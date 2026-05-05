import type { MediaDescriptor } from '../frames/MediaSurface';

/**
 * Scenario types — what the cinematic stage reads each frame.
 *
 * Earlier the marketing site loaded a separate `apps/demo` Web Component
 * to render real apps/ui components inside the device frames. That whole
 * package is gone now (2026-04). The frames render real screenshots and
 * recordings of the live Happier app — see `MediaSurface` and the per-beat
 * `media` field below.
 *
 * The bridge contract types (`DemoBridgeState`, `DemoBridgePatch`,
 * `DemoSurfaceView`, `DemoScenarioId`) used to live in `bridge/`. We keep
 * lightweight local versions here so existing scenarios keep typing.
 */

export type DemoScenarioId =
    | 'handoff'
    | 'remoteLaunch'
    | 'directSessions'
    | 'voice'
    | 'parallel';

export type DemoSurfaceView =
    | 'phone-session'
    | 'phone-new-session'
    | 'desktop-session'
    | 'desktop-new-session'
    | 'direct-browse'
    | 'voice';

/**
 * Per-beat patch on bridge state. Kept loose because nothing reads it
 * anymore — preserved as a Record so existing scenario definitions still
 * compile while we sweep them out.
 */
export type DemoBridgePatch = Readonly<Record<string, unknown>>;
export type DemoBridgeState = Readonly<Record<string, unknown>>;

export type DeviceFocus =
    | 'terminal'
    | 'phone'
    | 'desktop'
    | 'all'
    | 'both'
    | 'terminal-phone'
    | 'phone-desktop';

export type AgentMessage = {
    id: string;
    role: 'user' | 'agent';
    text: string;
    streamProgress?: number;
};

export type PermissionRequest = {
    id: string;
    agent: 'Claude' | 'Codex' | 'OpenCode';
    verb: string;
    target: string;
    state: 'pending' | 'approved' | 'denied';
    diffPreview?: { added: number; removed: number; path: string };
};

export type TerminalLine = {
    kind: 'prompt' | 'user' | 'agent' | 'permission' | 'tool' | 'info';
    text: string;
    accent?: 'green' | 'orange' | 'red' | 'blue' | 'purple' | 'dim';
};

export type SyncDirection = 'forward' | 'back';

export type DemoState = {
    sessionTitle: string;
    sessionMeta: string;
    messageCount: number;
    messages: AgentMessage[];
    permission: PermissionRequest | null;
    terminal: TerminalLine[];
    activityChip?: { device: 'terminal' | 'phone' | 'desktop'; label: string } | null;
    phoneNotification?: {
        phase: 'arriving' | 'opened';
        title: string;
        body: string;
        actionLabel?: string;
    } | null;
    syncPulseKey: number;
    /**
     * Direction of signal travel on the sync indicator. Forward = left→right
     * (e.g. "terminal asked phone"); back = right→left ("phone answered").
     */
    syncDirection?: SyncDirection;
};

export type SurfaceBeatState = Readonly<{
    view: DemoSurfaceView;
    label?: string;
    status?: string;
}>;

/**
 * Describes an animated "cycling typewriter" prompt for the terminal.
 * When present, TerminalBody renders a live typing animation cycling
 * through `tokens` (typing → flash-select → backspace → next), landing
 * on the last token.
 */
export type TerminalTypingPrompt = Readonly<{
    /** Text that's already typed when the beat starts, e.g. "happier ". */
    prefix: string;
    /** Ordered list of tokens to cycle through. The LAST one is the landing command. */
    tokens: readonly string[];
    perCharMs?: number;
    backspaceMs?: number;
    flashMs?: number;
    holdFinalMs?: number;
}>;

/**
 * When set, the terminal frame replays a real asciinema recording of an
 * actual `hdev claude` / `hdev codex` / `hdev opencode` run instead of the
 * synthetic line-based renderer. The line/typingPrompt fields are ignored
 * for the duration of the beat.
 */
export type TerminalCastDescriptor = Readonly<{
    /** Public URL to the .cast file (asciinema v2 JSONL). */
    src: string;
    /** Speed multiplier applied to the original timing. Defaults to 1. */
    speed?: number;
    /** Sub-range to play, in seconds since cast start. */
    startAtSeconds?: number;
    endAtSeconds?: number;
}>;

export type TerminalBeatState = Readonly<{
    lines: readonly TerminalLine[];
    commands?: readonly string[];
    typingPrompt?: TerminalTypingPrompt;
    /** Replays a recorded TUI run; takes precedence over lines/typingPrompt. */
    cast?: TerminalCastDescriptor;
    status?: string;
    attachedSessionId?: string;
}>;

export type VoiceBeatState = Readonly<{
    phase: string;
    transcript: readonly AgentMessage[];
}>;

export type ScenarioEvent = Readonly<{
    id: string;
    type: 'sync-pulse' | 'permission' | 'message' | 'session';
}>;

/**
 * Per-surface media for a beat. Each device frame reads its slot. Pass
 * `null`/omit to leave a frame's content blank for that beat.
 */
export type BeatMedia = Readonly<{
    phone?: MediaDescriptor;
    desktop?: MediaDescriptor;
    /** Terminal still uses the line-based renderer; this is rarely set. */
    terminal?: MediaDescriptor;
}>;

/**
 * Camera framing for a beat — like a director cutting between wide shots and
 * close-ups. The stage's responsive scale gets multiplied by `zoom`, and the
 * whole composition translates by (offsetX, offsetY) px so the active region
 * lands centered. Default is wide framing (zoom=1, offset=0).
 *
 * Use sparingly: zoom in on a single beat when there is something specific to
 * read (a phone notification, a typed prompt) and zoom back out for the next
 * beat. Constant zoom defeats the rhythm.
 */
export type BeatCamera = Readonly<{
    /** Multiplier on stage scale. 1 = wide; 1.3–1.6 = medium close-up; 2+ = tight. */
    zoom?: number;
    /**
     * Pixel offset (pre-zoom) applied to the stage so a particular device or
     * region lands centered after scaling. Positive x shifts the stage left
     * (camera pans right). Useful when zooming in on phone (≈+200) or terminal
     * (≈-220) instead of the geometric center.
     */
    offsetX?: number;
    offsetY?: number;
}>;

export type ScenarioBeat = Readonly<{
    id: string;
    atMs: number;
    durationMs: number;
    focus: DeviceFocus;
    visibleSurfaces: readonly ('terminal' | DemoSurfaceView)[];
    state: DemoState;
    terminal?: TerminalBeatState;
    phone?: SurfaceBeatState;
    desktop?: SurfaceBeatState;
    voice?: VoiceBeatState;
    bridgePatch?: DemoBridgePatch;
    events?: readonly ScenarioEvent[];
    label?: string;
    at: number;
    duration: number;
    /**
     * Which screenshot or recording each device frame should display
     * during this beat. The frames cross-fade between consecutive beats'
     * media via MediaSurface.
     */
    media?: BeatMedia;
    /** Optional camera framing override; defaults to wide (zoom=1). */
    camera?: BeatCamera;
}>;

export type ScenarioDefinition = Readonly<{
    id: DemoScenarioId;
    title: string;
    durationMs: number;
    totalDuration: number;
    initialBridgeState: DemoBridgeState;
    beats: readonly ScenarioBeat[];
}>;

export type Scenario = ScenarioDefinition;
