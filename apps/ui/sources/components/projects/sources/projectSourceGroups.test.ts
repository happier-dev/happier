import { describe, expect, it } from 'vitest';

import type { ProjectSourceDraft } from './projectSourcesController';
import { readSourceTeamId } from './projectSourceGroups';

describe('Source audience identity', () => {
    it('keeps an editable Source draft without an audience readable', () => {
        const draft: Pick<ProjectSourceDraft, 'audience'> = {};
        expect(readSourceTeamId(draft)).toBeNull();
    });

    it('retains a declared team identity rather than treating every draft as personal', () => {
        expect(readSourceTeamId({ audience: [{ principal: { kind: 'team', teamId: 'team' }, level: 'view' }] })).toBe('team');
    });
});
