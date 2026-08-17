import type { TranslationKey } from '@/text';

import type { WizardStepId } from '../../state/wizardTypes';

export const JOURNEY_SKIP_TO_SETUP_TARGET = 'S1';

export const JOURNEY_SURFACES = ['desktop', 'web', 'native'] as const;

export type JourneySurface = typeof JOURNEY_SURFACES[number];

/**
 * The surface key of the phone story cut. Curation and presentation are ONE
 * decision: `resolveJourneyLayoutMode` (OnboardingJourneyHost) owns whether the
 * journey plays as the phone story pager or the desktop split, and the host maps
 * that decision onto this key. Keyed here rather than re-derived from the running
 * platform, so a browser window narrow enough to get the story pager also gets the
 * curated phone script instead of the wide 19-beat cut.
 */
export const JOURNEY_STORY_SURFACE = 'native' satisfies JourneySurface;
export type JourneyAct = 'dream' | 'setup';
export type JourneyBeatId =
    | 'A1'
    | 'A2'
    | 'A3'
    | 'A4'
    | 'A5'
    | 'A6'
    | 'A7'
    | 'A8'
    | 'A9'
    | 'A10'
    | 'A11'
    | 'A12'
    | 'A13'
    | 'A14'
    | 'S1'
    | 'S2'
    | 'S3'
    | 'S4'
    | 'S5';

export type JourneyFeatureId =
    | 'anywhere'
    | 'existingSessions'
    | 'terminalTuis'
    | 'cockpit'
    | 'subagents'
    | 'queue'
    | 'attention'
    | 'review'
    | 'git'
    | 'voice'
    | 'mcp'
    | 'subscriptions+accounts'
    | 'customization'
    | 'grid'
    | 'relay'
    | 'privacy'
    | 'machine'
    | 'providers'
    | 'alive';

export type JourneyConfigStepId = WizardStepId | 'attention_micro_choice';

export type JourneyNarrationKeys = Readonly<{
    eyebrow: TranslationKey;
    title: TranslationKey;
    body: TranslationKey;
}>;

export type JourneySurfaceFlags = Readonly<Record<JourneySurface, boolean>>;

export type JourneyBeat = Readonly<{
    id: JourneyBeatId;
    act: JourneyAct;
    featureId: JourneyFeatureId;
    narrationKeys: JourneyNarrationKeys;
    frameId: string;
    surfaces: JourneySurfaceFlags;
    configStepId?: JourneyConfigStepId;
    stageTreatment?: 'planet-hero';
    accentHue?: string;
    skipTarget?: typeof JOURNEY_SKIP_TO_SETUP_TARGET;
}>;

const allSurfaces = {
    desktop: true,
    web: true,
    native: true,
} as const satisfies JourneySurfaceFlags;

const desktopAndWeb = {
    desktop: true,
    web: true,
    native: false,
} as const satisfies JourneySurfaceFlags;

// The dream beats whose real seeded surface reads well at phone size also play
// in the phone story cut (`JOURNEY_STORY_SURFACE`); the desktop-forward feature
// screens (settings-dense lists, the voice surface, diff review) stay in the wide
// cut to avoid cramped phone frames. This is the explicit per-beat curation the
// journey spec asks for, and it applies to every phone-width presentation — a
// narrow browser window included — not just to the native app.
const dreamNativeShowcase = allSurfaces;
const dreamDesktopFeature = desktopAndWeb;

function narrationKeys(id: Lowercase<JourneyBeatId>): JourneyNarrationKeys {
    return {
        eyebrow: `journey.beats.${id}.eyebrow`,
        title: `journey.beats.${id}.title`,
        body: `journey.beats.${id}.body`,
    };
}

export const journeyBeats: readonly JourneyBeat[] = [
    {
        id: 'A1',
        act: 'dream',
        featureId: 'anywhere',
        narrationKeys: narrationKeys('a1'),
        frameId: 'session-view.hero',
        surfaces: allSurfaces,
        stageTreatment: 'planet-hero',
        accentHue: '#FFB14A',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A2',
        act: 'dream',
        featureId: 'existingSessions',
        narrationKeys: narrationKeys('a2'),
        frameId: 'sessions-list.hero',
        surfaces: allSurfaces,
        accentHue: '#68A7FF',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A3',
        act: 'dream',
        featureId: 'terminalTuis',
        narrationKeys: narrationKeys('a3'),
        // The live PTY terminal cannot be demo-seeded inside the firewall, so A3
        // shows the real session cockpit the terminal work moves into, punched in
        // on the transcript (spec §3 real-screen bar; rule 1 designed alternative).
        frameId: 'session-view.detail',
        surfaces: dreamDesktopFeature,
        accentHue: '#7FE7C4',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A4',
        act: 'dream',
        featureId: 'cockpit',
        narrationKeys: narrationKeys('a4'),
        frameId: 'session-view.phone',
        surfaces: allSurfaces,
        accentHue: '#8DE1FF',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A5',
        act: 'dream',
        featureId: 'subagents',
        narrationKeys: narrationKeys('a5'),
        frameId: 'subagents.hero',
        surfaces: dreamDesktopFeature,
        accentHue: '#8DE1FF',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A6',
        act: 'dream',
        featureId: 'queue',
        narrationKeys: narrationKeys('a6'),
        frameId: 'session-view.spotlight',
        surfaces: allSurfaces,
        accentHue: '#9DFFB0',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A7',
        act: 'dream',
        featureId: 'attention',
        narrationKeys: narrationKeys('a7'),
        frameId: 'sessions-list.spotlight',
        surfaces: allSurfaces,
        configStepId: 'attention_micro_choice',
        accentHue: '#FF6B9A',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A8',
        act: 'dream',
        featureId: 'review',
        narrationKeys: narrationKeys('a8'),
        frameId: 'review.detail',
        surfaces: dreamDesktopFeature,
        accentHue: '#A0C4FF',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A9',
        act: 'dream',
        featureId: 'git',
        narrationKeys: narrationKeys('a9'),
        frameId: 'source-control.hero',
        surfaces: dreamDesktopFeature,
        accentHue: '#B8B0FF',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A10',
        act: 'dream',
        featureId: 'voice',
        narrationKeys: narrationKeys('a10'),
        frameId: 'voice.hero',
        surfaces: dreamDesktopFeature,
        accentHue: '#FF9F7A',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A11',
        act: 'dream',
        featureId: 'mcp',
        narrationKeys: narrationKeys('a11'),
        frameId: 'mcp-servers.hero',
        surfaces: dreamDesktopFeature,
        accentHue: '#67D4A6',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A12',
        act: 'dream',
        featureId: 'subscriptions+accounts',
        narrationKeys: narrationKeys('a12'),
        frameId: 'connected-services.hero',
        surfaces: dreamNativeShowcase,
        accentHue: '#FFC24A',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A13',
        act: 'dream',
        featureId: 'customization',
        narrationKeys: narrationKeys('a13'),
        frameId: 'theme-profiles.hero',
        surfaces: dreamDesktopFeature,
        accentHue: '#FF8DC7',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'A14',
        act: 'dream',
        featureId: 'grid',
        narrationKeys: narrationKeys('a14'),
        // The finale montage plays the real feature reel in the narration column;
        // the stage shows the whole populated app as the "and more" backdrop.
        frameId: 'sessions-list.hero',
        surfaces: dreamNativeShowcase,
        accentHue: '#FFD98A',
        skipTarget: JOURNEY_SKIP_TO_SETUP_TARGET,
    },
    {
        id: 'S1',
        act: 'setup',
        featureId: 'relay',
        narrationKeys: narrationKeys('s1'),
        frameId: 'relay-settings.spotlight',
        surfaces: allSurfaces,
        configStepId: 'relay_select',
        stageTreatment: 'planet-hero',
        accentHue: '#FFB14A',
    },
    {
        id: 'S2',
        act: 'setup',
        featureId: 'privacy',
        narrationKeys: narrationKeys('s2'),
        frameId: 'relay-settings.hero',
        surfaces: allSurfaces,
        configStepId: 'auth',
        stageTreatment: 'planet-hero',
        accentHue: '#5D6DFF',
    },
    {
        id: 'S3',
        act: 'setup',
        featureId: 'machine',
        narrationKeys: narrationKeys('s3'),
        frameId: 'machines-settings.spotlight',
        surfaces: allSurfaces,
        configStepId: 'setup_this_computer',
        accentHue: '#70E0C2',
    },
    {
        id: 'S4',
        act: 'setup',
        featureId: 'providers',
        narrationKeys: narrationKeys('s4'),
        frameId: 'session-view.spotlight',
        surfaces: allSurfaces,
        configStepId: 'providers_optional',
        accentHue: '#C99BFF',
    },
    {
        id: 'S5',
        act: 'setup',
        featureId: 'alive',
        narrationKeys: narrationKeys('s5'),
        frameId: 'sessions-list.hero',
        surfaces: allSurfaces,
        stageTreatment: 'planet-hero',
        accentHue: '#FFB14A',
    },
] as const;

export const journeyBeatById = new Map<JourneyBeatId, JourneyBeat>(
    journeyBeats.map((beat) => [beat.id, beat]),
);

export function isJourneyBeatVisibleOnSurface(beat: JourneyBeat, surface: JourneySurface): boolean {
    return beat.surfaces[surface];
}

export function getJourneyBeatsForSurface(surface: JourneySurface): readonly JourneyBeat[] {
    return journeyBeats.filter((beat) => isJourneyBeatVisibleOnSurface(beat, surface));
}

/**
 * The beat a journey should land on when `beatId` itself does not play in
 * `visibleBeats`.
 *
 * The cut a journey plays is a PRESENTATION decision (`resolveJourneyLayoutMode`)
 * that can change while the user is mid-journey — a browser window crossing the
 * mobile breakpoint, a phone rotating — so "this beat is not in the new cut" must
 * never read as "start the journey over". The canonical script order above is the
 * single source of adjacency: the nearest beat BEFORE the missing one wins,
 * because a curated cut drops beats from BETWEEN the ones it keeps, and landing
 * backwards re-shows a beat the user already reached instead of skipping content
 * they have not seen. Only a beat with no kept predecessor lands forward.
 */
export function resolveNearestVisibleBeatId(
    visibleBeats: readonly JourneyBeat[],
    beatId: JourneyBeatId,
): JourneyBeatId | null {
    const visibleBeatIds = new Set(visibleBeats.map((beat) => beat.id));
    if (visibleBeatIds.has(beatId)) return beatId;

    const scriptIndex = journeyBeats.findIndex((beat) => beat.id === beatId);
    if (scriptIndex < 0) return null;

    for (let index = scriptIndex - 1; index >= 0; index -= 1) {
        const candidate = journeyBeats[index];
        if (candidate && visibleBeatIds.has(candidate.id)) return candidate.id;
    }
    for (let index = scriptIndex + 1; index < journeyBeats.length; index += 1) {
        const candidate = journeyBeats[index];
        if (candidate && visibleBeatIds.has(candidate.id)) return candidate.id;
    }
    return null;
}
