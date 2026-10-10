import { describe, expect, it } from 'vitest';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';

import { resolveTeamOverviewDestinationIds } from './teamOverviewDestinations';

describe('resolveTeamOverviewDestinationIds', () => {
    it('shows Authentication only from the server-projected authentication capability', () => {
        expect(resolveTeamOverviewDestinationIds({
            ...NO_TEAM_CAPABILITIES_V1,
            viewTeam: true,
            manageAuthentication: true,
        })).toContain('authentication');

        expect(resolveTeamOverviewDestinationIds({
            ...NO_TEAM_CAPABILITIES_V1,
            viewTeam: true,
            manageSettings: true,
        })).not.toContain('authentication');
    });

    it('offers the two rosters to a plain viewer, because the Home authorizes those reads on viewRoster', () => {
        // The exact capability set a plain member or a guest receives.
        const destinations = resolveTeamOverviewDestinationIds({
            ...NO_TEAM_CAPABILITIES_V1,
            viewTeam: true,
            viewRoster: true,
        });

        expect(destinations).toContain('members');
        expect(destinations).toContain('groups');
        // Their owners refuse a non-manager outright, so they stay withheld.
        expect(destinations).not.toContain('invitations');
        expect(destinations).not.toContain('settings');
    });

    it('offers a non-member Home administrator only what they can open (DR-20)', () => {
        // Home authority shows the Team and its settings, but the roster and Group reads refuse it.
        const destinations = resolveTeamOverviewDestinationIds({
            ...NO_TEAM_CAPABILITIES_V1,
            viewTeam: true,
            viewRoster: false,
            manageSettings: true,
            archiveTeam: true,
        });
        expect(destinations).not.toContain('members');
        expect(destinations).not.toContain('groups');
        expect(destinations).toContain('settings');
    });

    it('withholds every destination from a viewer the Home would not answer at all', () => {
        expect(resolveTeamOverviewDestinationIds(NO_TEAM_CAPABILITIES_V1)).toEqual([]);
    });
});
