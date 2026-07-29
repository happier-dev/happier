import { describe, expect, it } from 'vitest';

import { stageFrameById } from '../stage/stageFrames';
import {
    JOURNEY_SURFACES,
    JOURNEY_SKIP_TO_SETUP_TARGET,
    getJourneyBeatsForSurface,
    journeyBeats,
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

// Desktop/web run the whole 19-beat script; native shows the curated dream
// subset whose seeded surface reads well at phone size plus every setup beat.
const expectedDesktopBeatIds = expectedBeatIds;

const expectedNativeBeatIds = [
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

const expectedHiddenOnNativeBeatIds = ['A3', 'A5', 'A8', 'A9', 'A10', 'A11', 'A13'] as const;

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

    it('runs the full script on desktop/web and a curated dream subset on native', () => {
        expect(getJourneyBeatsForSurface('desktop').map((beat) => beat.id)).toEqual(expectedDesktopBeatIds);
        expect(getJourneyBeatsForSurface('web').map((beat) => beat.id)).toEqual(expectedDesktopBeatIds);
        expect(getJourneyBeatsForSurface('native').map((beat) => beat.id)).toEqual(expectedNativeBeatIds);

        for (const beat of journeyBeats) {
            expect(beat.surfaces.desktop).toBe(true);
            expect(beat.surfaces.web).toBe(true);
        }

        const hiddenOnNative = journeyBeats.filter((beat) => !beat.surfaces.native).map((beat) => beat.id);
        expect(hiddenOnNative).toEqual([...expectedHiddenOnNativeBeatIds]);
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
