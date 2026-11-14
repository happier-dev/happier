import { describe, expect, it } from 'vitest';

import { presentTeamGroups } from './teamGroupPresentation';

describe('presentTeamGroups', () => {
    it('sorts loaded Group labels locally and searches them case-insensitively', () => {
        const groups = [{ id: 'group-a' }, { id: 'group-z' }];
        const names = new Map([
            ['group-a', 'Zulu'],
            ['group-z', 'Alpha'],
        ]);

        expect(presentTeamGroups(groups, names, '').map((row) => row.group.id)).toEqual(['group-z', 'group-a']);
        expect(presentTeamGroups(groups, names, 'zUlU').map((row) => row.group.id)).toEqual(['group-a']);
    });

    it('keeps an unavailable loaded Group structurally present outside a text search', () => {
        const groups = [{ id: 'group-b' }, { id: 'group-a' }];
        const names = new Map<string, string | null>([['group-a', 'Alpha']]);

        expect(presentTeamGroups(groups, names, '').map((row) => [row.group.id, row.name])).toEqual([
            ['group-a', 'Alpha'],
            ['group-b', null],
        ]);
        expect(presentTeamGroups(groups, names, 'alpha').map((row) => row.group.id)).toEqual(['group-a']);
    });
});
