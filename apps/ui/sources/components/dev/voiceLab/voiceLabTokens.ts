import { useUnistyles } from 'react-native-unistyles';

/**
 * Art-directed light palette for the Voice design lab.
 *
 * This is a **design-exploration surface only** (`/dev/voice-lab`). It is not a
 * competing app-wide design system and no production surface consumes it.
 *
 * The palette is not invented: it is the same atmospheric light Happier already
 * ships in its signature onboarding composition — the "planet" rising against a
 * near-neutral canvas. Those values live in
 * `components/onboarding/tour/stage/stageVisualTokens.ts` under
 * `horizon.{atmosphereColor,bloomColor}`:
 *
 *   atmosphere  rgba(109,148,255,.28)   → cool  #6D94FF
 *   bloom       rgba(255,177,74,.18)    → warm  #FFB14A
 *
 * Voice is designed as a *small body of that same light*: warm above, cool
 * below, with a soft terminator between. That is what makes it recognisably
 * Happier rather than a generic assistant orb.
 *
 * Colour never carries state alone. Every concept also encodes state through
 * **direction of motion** (inward = the user is heard, outward = Happier is
 * speaking, still-and-deep = delegated work is running) and through text.
 */

/**
 * The Happier planet, **sampled pixel-by-pixel** from
 * `assets/onboarding/planet-{dark,light}.jpg` along rays from the disc centre.
 *
 * The measured structure is not the obvious one. It is *not* a sphere lit from
 * the upper right with a hot spot inside it. It is:
 *
 *  - a **cool core** — `#1343A7` on dark, `#A6C7FD` on light;
 *  - a **warm crescent on the top rim**, brightest at ~0.85–1.0 of the radius;
 *  - colour **rotating around the disc** from that crescent: gold at the top,
 *    salmon upper-left, pink at the left, violet lower-left, cornflower at the
 *    bottom and right;
 *  - a rim that **darkens to near-black on dark** (bottom half) and **lightens
 *    to white on light** (everywhere).
 *
 * That last point is why one gradient cannot serve both themes: the dark planet
 * ends in a terminator, the light planet dissolves into the paper. Rendering
 * them the same way is what made the earlier orb read as a pale blob.
 *
 * Reproduced as stacked off-centre radial gradients — which is almost certainly
 * how the original mesh gradient was authored.
 */
export const PLANET_DARK = {
    /** Deep blue core. */
    core: '#1343A7',
    /** The crescent at the very top rim. */
    gold: '#FFA135',
    amber: '#FEBA3F',
    /** Upper-left, where the crescent turns red. */
    ember: '#DF5145',
    /** The shadowed left flank. */
    plum: '#31186B',
    /** Right flank, still lit. */
    azure: '#2A5BC4',
    /** The bottom, falling out of the light entirely. */
    abyss: '#01041E',
} as const;

export const PLANET_LIGHT = {
    core: '#A6C7FD',
    gold: '#FEC460',
    amber: '#FFD8A0',
    /** Upper-left salmon. */
    ember: '#FEBF9E',
    /** The left flank reads pink rather than shadowed. */
    plum: '#F4B5E2',
    violet: '#C8BBFF',
    azure: '#79A0FD',
    /** The light planet dissolves into paper instead of into shadow. */
    veil: '#FFFFFF',
} as const;

/** The five stops of the Happier light ramp, warm → cool. */
export const VOICE_LIGHT = {
    /** Amber. Top light. Assistant speech, attention. */
    warm: '#FFB14A',
    /** Blush. The warm→violet transition on the planet's terminator. */
    blush: '#F58BA8',
    /** Violet. Considering, and the user's own voice returning. */
    violet: '#A98CF5',
    /** Cornflower. The resting atmosphere. Ready, listening. */
    cool: '#6D94FF',
    /** Deep indigo. Delegated work: dense, slow, far away. */
    deep: '#4A5CC7',
} as const;

export type VoiceLightStop = keyof typeof VOICE_LIGHT;

/**
 * Film grain lifted from the same horizon token module (2% opacity, 16px tile).
 * Grain is what stops a soft gradient from reading as a cheap CSS blob — it
 * gives the light a material.
 */
export const VOICE_GRAIN = {
    opacity: 0.02,
    tileSize: 16,
} as const;

/**
 * The signature idle breath, matched to the onboarding horizon so the Voice
 * presence and the brand composition breathe at the same rate.
 */
export const VOICE_BREATH = {
    durationMs: 20_000,
    scalePeak: 1.012,
    bloomOpacityDelta: 0.1,
} as const;

/**
 * Motion tokens for the lab. Durations are deliberately short for repeated
 * actions and longer only for the one signature transition (collapse ⇄ expand).
 * Easings are expressed as cubic-bezier control points so both the Reanimated
 * `Easing.bezier(...)` and the web CSS forms stay in lockstep.
 */
export const VOICE_MOTION = {
    /** Press feedback and other level-1 state feedback. */
    feedback: { durationMs: 120, bezier: [0.2, 0, 0, 1] },
    /** Local continuity: status swaps, control appear/disappear. */
    local: { durationMs: 220, bezier: [0.2, 0, 0, 1] },
    /** Spatial transition: the collapse ⇄ expand of the presence itself. */
    spatial: { durationMs: 420, bezier: [0.22, 1, 0.36, 1] },
    /** Exits are quieter and faster than entrances. */
    exit: { durationMs: 180, bezier: [0.4, 0, 1, 1] },
    /** Stagger between semantic chunks in a staged reveal. */
    staggerMs: 46,
} as const;

export type VoiceLabTokens = Readonly<{
    /** True when the app theme is dark. */
    dark: boolean;
    /** The canvas the presence sits on (matches the host surface). */
    canvas: string;
    /** The atmospheric field behind the light, at rest. */
    field: string;
    /**
     * The host surface the presence sits on (`theme.colors.surface.base`), and
     * its fully transparent twin.
     *
     * These are **baked literals, not derived at runtime**. Unistyles compiles
     * theme tokens to CSS variables on web, so `${theme.colors.surface.base}00`
     * would produce `var(--x)00` — a silently invalid colour. Any fade that
     * needs a transparent version of a token must carry it as its own literal.
     */
    hostSurface: string;
    hostSurfaceTransparent: string;
    /** Hairline that defines a boundary without becoming a card border. */
    rule: string;
    /** Primary type on the presence. */
    ink: string;
    /** Secondary type: status, provenance. */
    inkMuted: string;
    /** Tertiary type: timestamps, counts. */
    inkFaint: string;
    /** Ink that reads over the brightest part of the light. */
    inkOnLight: string;
    /** Multiplier applied to every glow alpha — light needs more presence on dark. */
    glowGain: number;
    /** Blend mode for additive light layers where the platform supports it. */
    lightBlend: 'screen' | 'plus-lighter' | undefined;
}>;

const DARK: VoiceLabTokens = {
    dark: true,
    canvas: '#131111',
    field: 'rgba(109,148,255,0.05)',
    hostSurface: '#191717',
    hostSurfaceTransparent: 'rgba(25,23,23,0)',
    rule: 'rgba(255,255,255,0.07)',
    ink: '#EFEFEF',
    inkMuted: '#8A817C',
    inkFaint: '#6C625D',
    inkOnLight: '#0B0A12',
    glowGain: 1,
    lightBlend: 'screen',
};

const LIGHT: VoiceLabTokens = {
    dark: false,
    canvas: '#FBFAF9',
    field: 'rgba(109,148,255,0.06)',
    hostSurface: '#ffffff',
    hostSurfaceTransparent: 'rgba(255,255,255,0)',
    rule: 'rgba(0,0,0,0.06)',
    ink: '#0A0A0A',
    inkMuted: '#6c6c70',
    inkFaint: '#99999d',
    inkOnLight: '#1A1020',
    // Light canvases swallow additive glow, so the same alpha reads weaker.
    glowGain: 0.72,
    lightBlend: undefined,
};

export function useVoiceLabTokens(): VoiceLabTokens {
    const { theme } = useUnistyles();
    return theme.dark ? DARK : LIGHT;
}

/**
 * Ink for marks drawn ON the planet's body (the meter inside the orb).
 *
 * White works on the dark planet and disappears on the light one, whose crown is
 * pale gold — so this flips rather than being a constant.
 */
export function onPlanetInk(_tokens: VoiceLabTokens): string {
    // White in both themes. The meter sits ON the body, not on the canvas, and
    // the body is saturated enough at every stop that a dark ink reads as dirt.
    return 'rgba(255,253,250,0.96)';
}

/** `rgba()` string for a light stop at a given alpha, pre-multiplied by the theme's glow gain. */
export function light(stop: VoiceLightStop, alpha: number, tokens: VoiceLabTokens): string {
    const hex = VOICE_LIGHT[stop];
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    const a = Math.max(0, Math.min(1, alpha * tokens.glowGain));
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}
