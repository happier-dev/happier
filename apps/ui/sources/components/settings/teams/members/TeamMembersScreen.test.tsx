import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    accountDisplayProfileFixture,
    collectRenderedTestIds,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamCapabilitiesFixture,
    teamMembershipFixture,
    teamSummaryFixture,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const languageMock = vi.hoisted(() => ({ current: 'en' }));
const virtualizedBoundary = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null,
    mountLimit: Number.POSITIVE_INFINITY,
}));
const navigationState = vi.hoisted(() => ({
    focusEffects: [] as Array<() => void | (() => void)>,
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, unknown>) => {
        virtualizedBoundary.props = props;
        const data = ((props.data as readonly unknown[] | undefined) ?? []).slice(0, virtualizedBoundary.mountLimit);
        const renderItem = props.renderItem as (info: { item: unknown; index: number }) => React.ReactNode;
        return React.createElement(
            'VirtualizedList',
            props,
            props.ListHeaderComponent as React.ReactNode,
            ...data.map((item, index) => renderItem({ item, index })),
        );
    },
}));

vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useFocusEffect: (effect: () => void | (() => void)) => {
            ReactModule.useEffect(() => {
                navigationState.focusEffects.push(effect);
                const cleanup = effect();
                return () => {
                    navigationState.focusEffects = navigationState.focusEffects.filter(
                        (registered) => registered !== effect,
                    );
                    if (typeof cleanup === 'function') cleanup();
                };
            }, [effect]);
        },
    };
});

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ getPreferredLanguage: () => languageMock.current });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: routerPush } }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const MEMBERS_LIST_PATH = '/v1/teams/members/list';

async function renderMembers(serverId: string) {
    const { TeamMembersScreen } = await import('./TeamMembersScreen');
    return renderScreen(<TeamMembersScreen serverId={serverId} teamId="team-1" />);
}

async function addHome(team: ReturnType<typeof teamSummaryFixture>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, { body: team });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderMembers>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
    languageMock.current = 'en';
    navigationState.focusEffects = [];
    virtualizedBoundary.props = null;
    virtualizedBoundary.mountLimit = Number.POSITIVE_INFINITY;
});

afterEach(() => {
    standardCleanup();
});

describe('TeamMembersScreen', () => {
    it('formats the joined date in the selected app language', async () => {
        languageMock.current = 'de';
        const joinedAt = Date.parse('2025-02-03T12:00:00Z');
        const serverId = await addHome(teamSummaryFixture({ viewerRole: 'member' }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture({ joinedAt })], nextCursor: null },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-row:membership-1');
        expect(screen.findByTestId('team-members-row:membership-1')?.props.subtitle)
            .toContain(new Intl.DateTimeFormat('de', { dateStyle: 'medium' }).format(joinedAt));
    });
    it('renders a large roster as stable chunks in the canonical virtualized list', async () => {
        // Search box, filter group, then the member chunks.
        virtualizedBoundary.mountLimit = 3;
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({}),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: {
                items: Array.from({ length: 25 }, (_, index) => teamMembershipFixture({
                    id: `membership-${index}`,
                    accountId: `account-${index}`,
                })),
                nextCursor: null,
            },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-row:membership-0');

        expect(virtualizedBoundary.props?.testID).toBe('team-members-virtualized-list');
        expect(virtualizedBoundary.props?.maintainVisibleContentPosition).toBe(true);
        const data = virtualizedBoundary.props?.data as readonly unknown[];
        expect(data.length).toBeLessThan(25);
        const keyExtractor = virtualizedBoundary.props?.keyExtractor as (item: unknown) => string;
        expect(data.map(keyExtractor)).toEqual(expect.arrayContaining([
            'members:membership-0',
            'members:membership-12',
            'members:membership-24',
        ]));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-members-row:membership-24');
    });

    it('reads the roster for a plain viewer and offers no add control', async () => {
        // Exactly what the Home projects for an ordinary member: it authorizes
        // the roster read on `viewTeam` and withholds every mutation.
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({}),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture()], nextCursor: null },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-row:membership-1');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-members-forbidden');
        expect(ids).not.toContain('team-members-add');
        expect(harness.requestsFor(MEMBERS_LIST_PATH).length).toBeGreaterThan(0);
    });

    it('offers the add control to a manager', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture()], nextCursor: null },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-add');

        screen.pressByTestId('team-members-add');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/members/add`,
        );
    });

    it('asks the Home for the searched person instead of filtering the pages it holds', async () => {
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({}),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture()], nextCursor: 'cursor-2' },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-row:membership-1');

        // Grace is on a page this roster has not read, so no narrowing of the
        // rows it holds could ever find her. The Home answers the search.
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({
                    id: 'membership-grace',
                    accountId: 'account-grace',
                    account: accountDisplayProfileFixture('Grace'),
                })],
                nextCursor: null,
            },
        });
        screen.changeTextByTestId('team-members-search', 'gra');

        await waitForTestId(screen, 'team-members-row:membership-grace');
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-members-row:membership-1');
        // The Home answered the whole searched sequence, so nothing implies
        // another page of matches.
        expect(ids).not.toContain('team-members-load-more');
        expect(harness.requestsFor(MEMBERS_LIST_PATH).at(-1)?.input).toMatchObject({
            teamId: 'team-1',
            filter: 'all',
            query: 'gra',
        });

        harness.answer(serverId, MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        screen.changeTextByTestId('team-members-search', 'nobody-here');
        await waitForTestId(screen, 'team-members-empty');
        expect(harness.requestsFor(MEMBERS_LIST_PATH).at(-1)?.input).toMatchObject({ query: 'nobody-here' });
    });

    it('narrows the roster through one labelled select that asks the Home for the chosen filter', async () => {
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({}),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture()], nextCursor: null },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-row:membership-1');

        // One choice among five role/status filters: a field select showing the current choice.
        const findMenu = () => screen.tree.root.findAll((node) => node.props?.testID === 'team-members-filter'
            && Array.isArray(node.props?.items))[0];
        const menu = findMenu() as unknown as {
            props: {
                selectedId: string;
                items: ReadonlyArray<{ id: string }>;
                itemTrigger: { title: string };
                onSelect: (id: string) => void;
            };
        };
        expect(menu.props.selectedId).toBe('all');
        expect(menu.props.itemTrigger.title).toBe('teams.members.filterLabel');
        expect(menu.props.items.map((item) => item.id)).toEqual(['all', 'owners_admins', 'members', 'guests', 'suspended']);

        harness.answer(serverId, MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        await React.act(async () => {
            menu.props.onSelect('suspended');
        });
        await waitForTestId(screen, 'team-members-empty');
        expect(harness.requestsFor(MEMBERS_LIST_PATH).at(-1)?.input).toMatchObject({ filter: 'suspended' });
        expect((findMenu() as unknown as { props: { selectedId: string } }).props.selectedId)
            .toBe('suspended');
    });

    it('refreshes the canonical roster when returning from Add member', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture()], nextCursor: null },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-row:membership-1');
        expect(navigationState.focusEffects).toHaveLength(1);

        // The add route returns the canonical membership, but this retained
        // roster must re-read its own canonical page before it is shown again;
        // it cannot depend on the asynchronous AccountChange catch-up winning
        // a navigation race.
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: {
                items: [
                    teamMembershipFixture(),
                    teamMembershipFixture({
                        id: 'membership-new',
                        accountId: 'account-grace',
                        account: accountDisplayProfileFixture('Grace'),
                    }),
                ],
                nextCursor: null,
            },
        });
        navigationState.focusEffects[0]?.();

        await waitForTestId(screen, 'team-members-row:membership-new');
        expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(2);
    });

    it('explains a viewer the Home would not answer, and reads no roster', async () => {
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: null,
            capabilities: teamCapabilitiesFixture({ viewTeam: false }),
        }));

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-forbidden');

        expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(0);
    });

    it('does not offer retry after the Home authoritatively refuses the Members read', async () => {
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({}),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, { status: 403, body: { error: 'forbidden' } });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-unavailable');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-members-retry');
        expect(screen.getTextContent()).toContain('teams.errors.forbidden');
    });

    it('shows the owner-required notice from the Team condition, not from a local owner count', async () => {
        const serverId = await addHome(teamSummaryFixture({
            recovery: { kind: 'owner_required', canAppointOwner: true },
            viewerRole: null,
            // The Home administrator's projection: readable, no Team management.
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({
                    id: 'membership-grace',
                    accountId: 'account-grace',
                    account: accountDisplayProfileFixture('Grace'),
                    // The one capability the recovery path projects.
                    capabilities: {
                        setRole: true,
                        assignableRoles: ['owner'],
                        suspend: false,
                        reactivate: false,
                        remove: false,
                        setManagement: false,
                    },
                })],
                nextCursor: null,
            },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-owner-required');

        // A candidate exists, so the notice must not claim there is none.
        expect(screen.getTextContent()).not.toContain('teams.members.ownerRequiredNoCandidate');
    });

    it('withholds owner appointment from viewers without Home recovery authority', async () => {
        const serverId = await addHome(teamSummaryFixture({
            recovery: { kind: 'owner_required', canAppointOwner: false },
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({ viewTeam: true }),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture()], nextCursor: null },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-owner-required');

        expect(screen.findByTestId('team-owner-required-choose')).toBeNull();
        expect(screen.getTextContent()).not.toContain('teams.members.ownerRequiredNoCandidate');
    });

    it('claims there is no eligible candidate only once the whole roster has been read', async () => {
        const serverId = await addHome(teamSummaryFixture({
            recovery: { kind: 'owner_required', canAppointOwner: true },
            viewerRole: null,
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        }));
        // A first page with no promotable row and more pages to come.
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture()], nextCursor: 'cursor-2' },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-load-more');
        expect(screen.getTextContent()).not.toContain('teams.members.ownerRequiredNoCandidate');

        harness.answer(serverId, MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        await screen.pressByTestIdAsync('team-members-load-more');

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('teams.members.ownerRequiredNoCandidate');
        });
    });

    it('does not render the notice for a Team that has an owner', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        }));
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture()], nextCursor: null },
        });

        const screen = await renderMembers(serverId);
        await waitForTestId(screen, 'team-members-row:membership-1');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-owner-required');
    });
});
