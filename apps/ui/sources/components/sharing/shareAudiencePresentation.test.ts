import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { presentShareAudience } from './sharePrincipalPresentation';

const owner = { kind: 'team', teamId: 'source-team' } as const;
const ownerName = 'Payments';

describe('presentShareAudience', () => {
    it.each([
        { description: 'no grants', grants: [], teamName: ownerName },
        { description: 'a grant to the owning Team', grants: [{ principal: owner }], teamName: ownerName },
        { description: 'a Team name that has not loaded', grants: [], teamName: null },
    ])('shows the owning Team once with $description', ({ grants, teamName }) => {
        const name = teamName ?? t('shareSheet.team');
        const summary = presentShareAudience({ owner, grants, teamName: () => teamName });

        expect(summary).toBe(t('projects.sources.teamEveryone', { team: name }));
        expect(summary.split(name)).toHaveLength(2);
    });

    it('counts the owner and the additional recipient without counting a grant to the owner twice', () => {
        const summary = presentShareAudience({
            owner,
            grants: [{ principal: owner }, { principal: { kind: 'account', accountId: 'peer' } }],
            teamName: () => ownerName,
        });

        expect(summary).toBe(t('projects.sources.audienceCount', { count: 2 }));
    });

    it('shows only me for a personal resource without extra grants', () => {
        const summary = presentShareAudience({
            owner: { kind: 'account', accountId: 'me' },
            grants: [],
            teamName: () => null,
        });

        expect(summary).toBe(t('projects.sources.onlyMe'));
    });
});
