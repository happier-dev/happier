import { describe, expect, it } from 'vitest';

import { presentShareAudience } from './sharePrincipalPresentation';

const teamName = (id: string) => id === 'rows-od-176-r3-team' ? 'rows-od-176-r3-team' : null;

describe('presentShareAudience', () => {
    it('shows the owning Team without extra grants', () => {
        expect(presentShareAudience({
            owner: { kind: 'team', teamId: 'rows-od-176-r3-team' },
            grants: [],
            teamName,
        })).toBe('rows-od-176-r3-team · everyone');
    });

    it('counts the owning Team alongside additional recipients', () => {
        expect(presentShareAudience({
            owner: { kind: 'team', teamId: 'rows-od-176-r3-team' },
            grants: [{ principal: { kind: 'account', accountId: 'peer' } }],
            teamName,
        })).toBe('2 people and teams');
    });

    it('keeps the Team audience when its display name has not arrived', () => {
        expect(presentShareAudience({
            owner: { kind: 'team', teamId: 'unnamed-team' },
            grants: [],
            teamName,
        })).toBe('Team · everyone');
    });

    it('shows only me for a personal resource without extra grants', () => {
        expect(presentShareAudience({
            owner: { kind: 'account', accountId: 'me' },
            grants: [],
            teamName,
        })).toBe('Only me');
    });
});
