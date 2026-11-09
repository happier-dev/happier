import { describe, expect, it } from 'vitest';
import { profileRailContext, profileRailStatus } from './profileColumnAdapter';

describe('Profile rail row', () => {
    it('keeps a healthy profile quiet and says a turned-off or review-waiting one in the status slot', () => {
        expect(profileRailStatus({ enabled: true, migration: null })).toBeNull();
        expect(profileRailStatus({ enabled: true, migration: 'retained' })).toBeNull();
        expect(profileRailStatus({ enabled: false, migration: null })?.status).toBe('off');
        expect(profileRailStatus({ enabled: true, migration: 'review' })?.status).toBe('review');
        expect(profileRailStatus({ enabled: true, migration: 'conflict' })?.status).toBe('review');
        // A review that waits for the person outranks "turned off".
        expect(profileRailStatus({ enabled: false, migration: 'conflict' })?.status).toBe('review');
    });

    it('names the state in words for the tooltip and accessible name, never on the context line', () => {
        const status = profileRailStatus({ enabled: false, migration: 'review' });
        expect(status?.label).toBeTruthy();
        expect(profileRailContext('Reviews UI changes', 'Any agent')).toBe('Reviews UI changes');
    });

    it('drops the line that every profile shares and keeps what tells profiles apart', () => {
        expect(profileRailContext('Any agent', 'Any agent')).toBeUndefined();
        expect(profileRailContext('Claude · 2 variables', 'Any agent')).toBe('Claude · 2 variables');
        expect(profileRailContext('Any agent · 1 variable', 'Any agent')).toBe('Any agent · 1 variable');
    });
});
