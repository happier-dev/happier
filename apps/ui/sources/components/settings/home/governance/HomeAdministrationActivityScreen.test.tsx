import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit` barrel, for the reason
 * `HomeAdministrationTeamsScreen.test.tsx` gives: the barrel binds the real transports before the
 * Home boundaries are installed.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    accountDisplayProfileFixture,
    homeAdministrationEventFixture,
    homeGovernanceProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';
const AUDIT_PATH = '/v1/home/audit/list';

type RenderedNode = Readonly<{ children: ReadonlyArray<RenderedNode | string> }>;

/** Every string rendered under the node carrying `testID`: what the person actually reads. */
function textUnder(node: RenderedNode | null): string {
    if (!node) return '';
    return node.children.map((child) => (typeof child === 'string' ? child : textUnder(child))).join('|');
}

async function addHome(): Promise<string> {
    const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
    harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
    return home;
}

async function renderActivity(serverId: string) {
    const { HomeAdministrationActivityScreen } = await import('./HomeAdministrationActivityScreen');
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    return renderScreen(<HomeAdministrationActivityScreen serverId={serverId} />);
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('HomeAdministrationActivityScreen', () => {
    it('says who did what, and shows a secret change only as set or not set', async () => {
        const home = await addHome();
        harness.answer(home, AUDIT_PATH, {
            body: {
                items: [
                    homeAdministrationEventFixture({
                        id: 'evt-password',
                        action: 'home.settings.set',
                        target: { kind: 'setting', id: 'HAPPIER_AUTH_EMAIL_SMTP_PASSWORD', profile: null },
                        summary: { secret: true, key: 'HAPPIER_AUTH_EMAIL_SMTP_PASSWORD', from: 'unset', to: 'set' },
                    }),
                    homeAdministrationEventFixture({
                        id: 'evt-role',
                        action: 'account.role.set',
                        target: { kind: 'account', id: 'account-ben', profile: accountDisplayProfileFixture('Ben') },
                        summary: { from: 'member', to: 'admin' },
                    }),
                    homeAdministrationEventFixture({
                        id: 'evt-claim',
                        action: 'home.owner.claim',
                        actor: { kind: 'deployment_command', accountId: null, profile: null },
                        target: { kind: 'account', id: 'account-ada', profile: accountDisplayProfileFixture('Ada') },
                        summary: {},
                    }),
                    homeAdministrationEventFixture({
                        id: 'evt-left',
                        action: 'teams.members.remove',
                        target: { kind: 'account', id: 'account-ada', profile: accountDisplayProfileFixture('Ada') },
                        summary: { teamId: 'team-internal', membershipId: 'membership-internal', teamName: 'Acme' },
                    }),
                    homeAdministrationEventFixture({
                        id: 'evt-removed',
                        action: 'teams.members.remove',
                        target: { kind: 'account', id: 'account-ben', profile: accountDisplayProfileFixture('Ben') },
                        summary: { teamId: 'team-internal', membershipId: 'membership-internal', teamName: 'Acme' },
                    }),
                ],
                nextCursor: null,
            },
        });

        const screen = await renderActivity(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-activity-row:evt-claim');
        });

        const password = textUnder(screen.findByTestId('home-activity-row:evt-password'));
        expect(password).toContain('Ada homeGovernance.activity.changedEmailSetting');
        expect(password).toContain('homeGovernance.activity.areaEmail');
        expect(password).toContain('homeGovernance.email.password  homeGovernance.activity.secretUnset → homeGovernance.activity.secretSet');
        expect(textUnder(screen.findByTestId('home-activity-row:evt-role')))
            .toContain('Ada homeGovernance.activity.changedRole(target=Ben)');
        expect(textUnder(screen.findByTestId('home-activity-row:evt-left')))
            .toContain('teams.leave.auditLeft(team=Acme)');
        expect(textUnder(screen.findByTestId('home-activity-row:evt-removed')))
            .toContain('teams.leave.auditRemoved(team=Acme,target=Ben)');
        expect(textUnder(screen.findByTestId('home-activity-row:evt-left'))).not.toContain('membership-internal');
        expect(textUnder(screen.findByTestId('home-activity-row:evt-claim')))
            .toContain('homeGovernance.activity.deploymentCommand homeGovernance.activity.madeOwner(target=Ada)');
        // Everything shown is on the page: no further page was offered.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-activity-show-older');
    });

    it('reads a sign-in policy change as the fields it changed, with the Home’s own names', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, {
            body: homeGovernanceProjectionFixture({
                authenticationOptions: {
                    methods: [{ id: 'key_challenge', displayName: 'Device key', actions: [] }],
                    permittedAccountModes: ['e2ee'],
                    recommendedProvisioningMode: 'e2ee',
                    signInService: { deploymentMode: null, canDisable: false },
                },
            }),
        });
        harness.answer(home, AUDIT_PATH, {
            body: {
                items: [
                    homeAdministrationEventFixture({
                        id: 'evt-widen',
                        action: 'home.policy.set',
                        summary: {
                            revision: 4,
                            widening: true,
                            changes: [{
                                field: 'authenticationPolicy',
                                from: { v: 1, admission: 'invitation_only', signInService: null },
                                to: { v: 1, admission: 'self_service', signInService: null },
                            }],
                        },
                    }),
                    homeAdministrationEventFixture({
                        id: 'evt-first',
                        action: 'home.policy.set',
                        summary: {
                            revision: 3,
                            changes: [{
                                field: 'authenticationPolicy',
                                from: null,
                                to: { v: 1, enabledMethodIds: ['key_challenge'], storagePolicy: 'required_e2ee', signInService: null },
                            }],
                        },
                    }),
                ],
                nextCursor: null,
            },
        });

        const screen = await renderActivity(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-activity-row:evt-first');
        });

        const widen = textUnder(screen.findByTestId('home-activity-row:evt-widen'));
        expect(widen).toContain('homeGovernance.signInPolicy.newAccounts  homeGovernance.admissionInvitationOnly → homeGovernance.admissionSelfService');
        // Only what changed: the document's untouched fields are not listed.
        expect(widen).not.toContain('homeGovernance.signInMethods');
        expect(widen).not.toContain('homeGovernance.activity.valueChanged');
        const first = textUnder(screen.findByTestId('home-activity-row:evt-first'));
        // Fields the document now decides read against what the deployment decided before.
        expect(first).toContain('homeGovernance.signInMethods  homeGovernance.signInPolicy.recommendedInherited → Device key');
        expect(first).toContain('homeGovernance.signInPolicy.storagePolicy  homeGovernance.signInPolicy.recommendedInherited → homeGovernance.signInPolicy.storageRequired');
        expect(first).not.toContain('homeGovernance.signInPolicy.newAccounts');
    });

    it('pages older events with the Home cursor and keeps the ones already read', async () => {
        const home = await addHome();
        const first = homeAdministrationEventFixture({ id: 'evt-new', action: 'home.owner.claim', summary: {} });
        const older = homeAdministrationEventFixture({ id: 'evt-old', action: 'home.owner.claim', summary: {} });
        harness.answer(home, AUDIT_PATH, {
            select: (input) => ((input as { cursor?: string }).cursor === 'cur-2'
                ? { body: { items: [older], nextCursor: null } }
                : { body: { items: [first], nextCursor: 'cur-2' } }),
        });

        const screen = await renderActivity(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-activity-show-older');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('home-activity-show-older');
        });

        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-activity-row:evt-old');
        });
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('home-activity-row:evt-new');
        expect(ids).not.toContain('home-activity-show-older');
        expect(harness.requestsFor(AUDIT_PATH).map((request) => request.input)).toEqual([{}, { cursor: 'cur-2' }]);
    });

    it('shows the empty state when the Home has recorded nothing yet', async () => {
        const home = await addHome();
        harness.answer(home, AUDIT_PATH, { body: { items: [], nextCursor: null } });

        const screen = await renderActivity(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-activity-empty');
        });
    });
});
