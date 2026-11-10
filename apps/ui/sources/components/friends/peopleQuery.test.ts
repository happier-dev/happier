import { describe, expect, it } from 'vitest';

import { matchesPeopleQuery } from './peopleQuery';

describe('matchesPeopleQuery', () => {
    it('keeps everyone while the query is blank', () => {
        expect(matchesPeopleQuery('  ', 'Ada Lovelace')).toBe(true);
    });

    it('matches any of a person’s names, ignoring case and surrounding space', () => {
        expect(matchesPeopleQuery(' LOVE ', 'Ada Lovelace', 'ada')).toBe(true);
        expect(matchesPeopleQuery('ada', null, 'ada_l')).toBe(true);
        expect(matchesPeopleQuery('grace', 'Ada Lovelace', undefined, 'ada')).toBe(false);
    });
});
