import { describe, expect, it } from 'vitest';

import { stageFrameById } from '../stage/stageFrames';
import {
    JOURNEY_SURFACES,
    JOURNEY_SKIP_TO_SETUP_TARGET,
    JOURNEY_STORY_SURFACE,
    getJourneyBeatsForSurface,
    journeyBeats,
    resolveNearestVisibleBeatId,
} from './journeyBeats';

const expectedBeatIds = [
    'A1',
    'A2',
    'A3',
    'A4',
    'A5',
    'A6',
    'A7',
    'A8',
    'A9',
    'A10',
    'A11',
    'A12',
    'A13',
    'A14',
    'S1',
    'S2',
    'S3',
    'S4',
    'S5',
] as const;

// Curation is keyed by the PRESENTATION the journey resolved, not by the
// platform it happens to run on: the wide (split) cut runs the whole 19-beat
// script, and the phone story cut — native, and every window at or below the
// mobile breakpoint, including a narrow browser — shows the curated dream
// subset whose seeded surface reads well at phone size plus every setup beat.
const expectedWideCutBeatIds = expectedBeatIds;

const expectedStoryCutBeatIds = [
    'A1',
    'A2',
    'A4',
    'A6',
    'A7',
    'A12',
    'A14',
    'S1',
    'S2',
    'S3',
    'S4',
    'S5',
] as const;

const expectedHiddenInStoryCutBeatIds = ['A3', 'A5', 'A8', 'A9', 'A10', 'A11', 'A13'] as const;

const expectedRealFrameIdsByBeat = new Map<string, string>([
    ['A1', 'session-view.hero'],
    ['A2', 'sessions-list.hero'],
    ['A3', 'session-view.detail'],
    ['A4', 'session-view.phone'],
    ['A5', 'subagents.hero'],
    ['A6', 'session-view.spotlight'],
    ['A7', 'sessions-list.spotlight'],
    ['A8', 'review.detail'],
    ['A9', 'source-control.hero'],
    ['A10', 'voice.hero'],
    ['A11', 'mcp-servers.hero'],
    ['A12', 'connected-services.hero'],
    ['A13', 'theme-profiles.hero'],
    ['A14', 'sessions-list.hero'],
    ['S1', 'relay-settings.spotlight'],
    ['S2', 'relay-settings.hero'],
    ['S3', 'machines-settings.spotlight'],
    ['S4', 'session-view.spotlight'],
    ['S5', 'sessions-list.hero'],
]);

const expectedPlanetHeroBeatIds = ['A1', 'S1', 'S2', 'S5'] as const;

describe('journeyBeats', () => {
    it('captures the two-act script in the architecture order', () => {
        expect(journeyBeats.map((beat) => beat.id)).toEqual(expectedBeatIds);
        expect(journeyBeats.filter((beat) => beat.act === 'dream').map((beat) => beat.id)).toEqual(expectedBeatIds.slice(0, 14));
        expect(journeyBeats.filter((beat) => beat.act === 'setup').map((beat) => beat.id)).toEqual(expectedBeatIds.slice(14));
    });

    it('assigns a stage accent hue to every beat for horizon transitions', () => {
        for (const beat of journeyBeats) {
            expect(beat.accentHue).toMatch(/^#[0-9A-F]{6}$/);
        }
    });

    it('binds every beat to a registered real stage frame (no pending stubs remain)', () => {
        for (const beat of journeyBeats) {
            expect(beat.frameId).toBe(expectedRealFrameIdsByBeat.get(beat.id));
            expect(stageFrameById.has(beat.frameId)).toBe(true);
        }
        expect(journeyBeats.every((beat) => !beat.frameId.startsWith('pending.'))).toBe(true);
    });

    it('marks the hero, relay/auth setup beats, and finale as non-live planet stage moments', () => {
        expect(journeyBeats
            .filter((beat) => beat.stageTreatment === 'planet-hero')
            .map((beat) => beat.id)).toEqual(expectedPlanetHeroBeatIds);
    });

    it('runs the full script in the wide cut and a curated dream subset in the phone story cut', () => {
        // The story cut is a named surface key so the presentation owner
        // (`resolveJourneyLayoutMode`) can map its decision onto curation instead
        // of a second, platform-keyed detector deciding it again.
        expect(JOURNEY_SURFACES).toContain(JOURNEY_STORY_SURFACE);
        expect(getJourneyBeatsForSurface(JOURNEY_STORY_SURFACE).map((beat) => beat.id)).toEqual(expectedStoryCutBeatIds);
        expect(getJourneyBeatsForSurface('desktop').map((beat) => beat.id)).toEqual(expectedWideCutBeatIds);
        expect(getJourneyBeatsForSurface('web').map((beat) => beat.id)).toEqual(expectedWideCutBeatIds);

        for (const beat of journeyBeats) {
            expect(beat.surfaces.desktop).toBe(true);
            expect(beat.surfaces.web).toBe(true);
        }

        const hiddenInStoryCut = journeyBeats
            .filter((beat) => !beat.surfaces[JOURNEY_STORY_SURFACE])
            .map((beat) => beat.id);
        expect(hiddenInStoryCut).toEqual([...expectedHiddenInStoryCutBeatIds]);
    });

    it('lands a beat the target cut drops on the nearest beat that cut kept', () => {
        // The cut a journey plays can change mid-journey (a window crossing the
        // mobile breakpoint, a phone rotating), so "this beat is not in the new
        // cut" must not read as "start over".
        const storyCut = getJourneyBeatsForSurface(JOURNEY_STORY_SURFACE);
        expect(resolveNearestVisibleBeatId(storyCut, 'A2')).toBe('A2');
        expect(resolveNearestVisibleBeatId(storyCut, 'A5')).toBe('A4');
        expect(resolveNearestVisibleBeatId(storyCut, 'A11')).toBe('A7');
        expect(resolveNearestVisibleBeatId(storyCut, 'A13')).toBe('A12');

        // Only a beat the cut keeps nothing before lands forward.
        const withoutOpening = storyCut.filter((beat) => beat.id !== 'A1');
        expect(resolveNearestVisibleBeatId(withoutOpening, 'A1')).toBe('A2');
        expect(resolveNearestVisibleBeatId([], 'A1')).toBeNull();
    });

    it('keeps skip-to-setup and config ownership on the beat data', () => {
        expect(JOURNEY_SKIP_TO_SETUP_TARGET).toBe('S1');
        for (const beat of journeyBeats.filter((item) => item.act === 'dream')) {
            expect(beat.skipTarget).toBe('S1');
        }
        for (const beat of journeyBeats.filter((item) => item.act === 'setup')) {
            expect(beat.skipTarget).toBeUndefined();
        }

        expect(Object.fromEntries(journeyBeats.map((beat) => [beat.id, beat.configStepId ?? null]))).toMatchObject({
            A7: 'attention_micro_choice',
            S1: 'relay_select',
            S2: 'auth',
            S3: 'setup_this_computer',
            S4: 'providers_optional',
            S5: null,
        });
    });

    it('uses the journey i18n namespace for every narration slot', () => {
        for (const beat of journeyBeats) {
            const keyPrefix = `journey.beats.${beat.id.toLowerCase()}.`;
            expect(beat.narrationKeys).toEqual({
                eyebrow: `${keyPrefix}eyebrow`,
                title: `${keyPrefix}title`,
                body: `${keyPrefix}body`,
            });
        }
    });
});
