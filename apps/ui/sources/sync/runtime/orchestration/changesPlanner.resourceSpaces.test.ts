import { expect, it } from 'vitest';
import { SessionOrganizationChangeHintSchema } from '@happier-dev/protocol/changes';
import { homeAccountChangeAffectsResourceSpaceMembership, planSyncActionsFromChanges } from './changesPlanner';

it('routes personal resource membership changes to their spaces without refreshing Session organization', () => {
    const hint = SessionOrganizationChangeHintSchema.parse({ sessionOrganization: true,
        scope: 'resourceSpaceMemberships', spaceIds: ['source', 'destination'], resourceIds: ['review'] });
    const plan = planSyncActionsFromChanges([{ cursor: 1, kind: 'account', entityId: 'session-organization', changedAt: 1, hint }]);
    expect(plan).toMatchObject({ resourceSpaceMembershipSpaceIds: ['destination', 'source'],
        sessionOrganization: { mode: 'none' }, invalidate: { sessions: false, settings: false, artifacts: false } });
    const event = { serverId: 'home', resourceSpaceMembershipSpaceIds: plan.resourceSpaceMembershipSpaceIds };
    expect(homeAccountChangeAffectsResourceSpaceMembership(event, 'destination')).toBe(true);
    expect(homeAccountChangeAffectsResourceSpaceMembership(event, 'source')).toBe(true);
    expect(homeAccountChangeAffectsResourceSpaceMembership(event, 'other')).toBe(false);
    expect(homeAccountChangeAffectsResourceSpaceMembership(event, undefined)).toBe(false);
    const sessionPlan = planSyncActionsFromChanges([{ cursor: 2, kind: 'account', entityId: 'session-organization', changedAt: 2,
        hint: SessionOrganizationChangeHintSchema.parse({ sessionOrganization: true, scope: 'tags', tagIds: ['tag'] }) }]);
    expect(sessionPlan).toMatchObject({ resourceSpaceMembershipSpaceIds: [], sessionOrganization: { mode: 'snapshot', includeTags: true } });
});
