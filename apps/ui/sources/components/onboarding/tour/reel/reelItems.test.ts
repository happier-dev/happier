import { describe, expect, it } from 'vitest';

import { journeyBeatById } from '../state/journeyBeats';

import { journeyReelItemKeys, journeyReelItems } from './reelItems';

describe('journeyReelItems', () => {
    it('uses the approved A14 grid feature order and excludes already-promoted or rejected features', () => {
        expect(journeyBeatById.get('A14')?.featureId).toBe('grid');
        expect(journeyReelItems.map((item) => item.id)).toEqual([
            'goals',
            'memorySearch',
            'editor',
            'interSession',
            'agentActions',
            'multiSelect',
            'folders',
            'prompts',
            'sharing',
            'automations',
            'handoff',
            'notifications',
            'crossPlatform',
        ]);
        expect(new Set(journeyReelItems.map((item) => item.id)).size).toBe(journeyReelItems.length);
        expect(journeyReelItems.map((item) => item.id)).not.toContain('imageGen');
        expect(journeyReelItems.map((item) => item.id)).not.toContain('pets');
        expect(journeyReelItems.map((item) => item.id)).not.toContain('git');
        expect(journeyReelItems.map((item) => item.id)).not.toContain('themes');
    });

    it('points every reel item at the journey reel translation namespace', () => {
        for (const item of journeyReelItems) {
            expect(item.titleKey).toBe(`journey.reel.features.${item.id}.title`);
            expect(item.bodyKey).toBe(`journey.reel.features.${item.id}.body`);
        }
    });

    it('builds reel translation keys through the typed reel key helper', () => {
        expect(journeyReelItemKeys('goals')).toEqual({
            titleKey: 'journey.reel.features.goals.title',
            bodyKey: 'journey.reel.features.goals.body',
        });
    });
});
