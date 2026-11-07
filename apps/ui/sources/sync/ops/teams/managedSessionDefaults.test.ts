import { afterEach, describe, expect, it } from 'vitest';
import { teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import { applyTeamProjection, resetTeamsSnapshotsForTests, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';
import { readManagedSessionDefaults } from './managedSessionDefaults';

const agentTargetKey = 'agent:example.agent/example';
const input = { serverId: 'home-a', teamId: 'team-1', memberAccountId: 'member-a', agentTargetKey };
const scope = createServerAccountScope(input.serverId, input.memberAccountId)!;
const address = createTeamAddress(input.serverId, input.teamId)!;
const publish = (mode: 'read-only' | 'yolo') => applyTeamProjection({
    scope, address, observedAt: 1,
    team: teamSummaryFixture({
        managedDefaultsGroupIds: ['reviewers'],
        policy: teamPolicyFixture({ managedDefaultsStatus: 'available', managedDefaults: {
            team: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'safe-yolo' } },
            groups: { reviewers: { permissionModeByAgentTargetKey: { [agentTargetKey]: mode } } },
        } }),
    }),
});

afterEach(resetTeamsSnapshotsForTests);

describe('decision-time managed Session defaults reader', () => {
    it('uses the selected member projection and receives changes through existing Team push', () => {
        publish('read-only');
        expect(readManagedSessionDefaults(input)).toMatchObject({ status: 'ready', defaults: { permissionMode: { value: 'read-only', source: 'group' } } });
        const pushed: unknown[] = [];
        const release = subscribeTeamsSnapshots(() => pushed.push(readManagedSessionDefaults(input)));
        try {
            publish('yolo');
            expect(pushed).toEqual([expect.objectContaining({ status: 'ready', defaults: expect.objectContaining({ permissionMode: expect.objectContaining({ value: 'yolo' }) }) })]);
        } finally { release(); }
        expect(readManagedSessionDefaults({ ...input, memberAccountId: 'member-b' })).toMatchObject({ status: 'unavailable', reason: 'unobserved' });
        expect(readManagedSessionDefaults({ ...input, serverId: 'home-b' })).toMatchObject({ status: 'unavailable', reason: 'unobserved' });
    });

    it('preserves explicit choices and reports malformed stored defaults without inventing a default', () => {
        publish('read-only');
        expect(readManagedSessionDefaults({ ...input, explicitChoices: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'yolo' } } }))
            .toMatchObject({ status: 'ready', defaults: { permissionMode: { value: 'yolo', source: 'explicit' } } });
        applyTeamProjection({ scope, address, observedAt: 2, team: teamSummaryFixture({
            policy: teamPolicyFixture({ managedDefaults: null, managedDefaultsStatus: 'repair_required' }),
        }) });
        expect(readManagedSessionDefaults(input)).toMatchObject({ status: 'ready', repairRequired: true, defaults: { permissionMode: { value: undefined } } });
    });
});
