import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialResourceFixture, teamCredentialViewerFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const modalSpies = vi.hoisted(() => ({
    show: vi.fn((_config: unknown) => 'credential-filter-modal'),
    hide: vi.fn(),
}));

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: modalSpies }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');

const TEAM_GET_PATH = '/v1/teams/get';
const CREDENTIALS_LIST_PATH = '/v1/teams/credential-resources/list';

async function renderCredentials(serverId: string) {
    const { TeamCredentialsScreen } = await import('./TeamCredentialsScreen');
    return renderScreen(<TeamCredentialsScreen serverId={serverId} teamId="team-1" />);
}

async function addHome(options?: Readonly<{ credentialResourcesEnabled?: boolean }>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
        credentialResourcesEnabled: options?.credentialResourcesEnabled ?? true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderCredentials>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
    modalSpies.show.mockClear();
    modalSpies.hide.mockClear();
});

afterEach(() => {
    standardCleanup();
});

describe('TeamCredentialsScreen', () => {
    it('renders each resource from the one list answer and opens it by its exact address', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({ allMembersAllowedRoutes: ['brokered'] })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-row:resource-1');

        const calls = harness.requestsFor(CREDENTIALS_LIST_PATH);
        expect(calls.every((call) => call.serverId === serverId)).toBe(true);
        // The row summary is presentation-ready: nothing here opens a second
        // request per row for an audience, a source or a status.
        expect(calls).toHaveLength(1);

        screen.pressByTestId('team-credentials-row:resource-1');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${serverId}/team-1/credentials/resource-1`,
        );
    });

    it('explains a viewer the Home denies rather than showing an empty administration list', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: { resources: [], viewer: teamCredentialViewerFixture({}) },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-forbidden');

        // An empty list would say "there is nothing here"; the Home said "this
        // is not yours to administer", which is a different answer.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credentials-empty');
    });

    it('offers the one way into sharing a source to whoever the Home says may offer one', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: { resources: [], viewer: teamCredentialViewerFixture({ offerOwnCredential: true }) },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-empty-share');

        // Offering your own source is a separate decision from administering
        // the Team's resources, so someone who may only offer still reaches the
        // editor instead of being told the page is not theirs.
        screen.pressByTestId('team-credentials-empty-share');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${serverId}/team-1/credentials/new`,
        );
    });

    it('puts the share action at the page header end beside the list, as Groups and Invitations do', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({ allMembersAllowedRoutes: ['brokered'] })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true, offerOwnCredential: true }),
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-row:resource-1');
        await waitForTestId(screen, 'team-credentials-share');

        const header = screen.tree.root.findByProps({ testID: 'team-page-header' });
        expect(header.findAll((node) => node.props.testID === 'team-credentials-share').length).toBeGreaterThan(0);
        screen.pressByTestId('team-credentials-share');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${serverId}/team-1/credentials/new`,
        );
    });

    it('hides the share entry from a viewer the Home does not let offer a source', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({ allMembersAllowedRoutes: ['brokered'] })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-row:resource-1');

        // Managing this Team's resources does not by itself make you able to
        // offer one of your own, and a control that would only be refused is
        // absent rather than disabled.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credentials-share');
    });

    it('reads nothing when the Home has not enabled shared credentials', async () => {
        const serverId = await addHome({ credentialResourcesEnabled: false });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-unavailable');

        expect(harness.requestsFor(CREDENTIALS_LIST_PATH)).toHaveLength(0);
    });

    it('keeps rows already read on screen and offers a retry when a refresh fails', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({ allMembersAllowedRoutes: ['brokered'] })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-row:resource-1');

        harness.answer(serverId, CREDENTIALS_LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        const { refreshTeamCredentialResources } = await import('@/sync/engine/teams/teamsDirectoryEngine');
        await refreshTeamCredentialResources(
            { serverId, accountId: 'account-ada' },
            { serverId, teamId: 'team-1' },
        );

        await waitForTestId(screen, 'team-credentials-retry');
        // Continuity: an unreachable Home does not blank a list it already answered.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credentials-row:resource-1');
    });

    it('keeps earlier resource pages visible and retries the exact failed continuation', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({ id: 'resource-1', displayName: 'Alpha' })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: 'resource-page-2',
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-load-more');

        harness.answer(serverId, CREDENTIALS_LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        await screen.pressByTestIdAsync('team-credentials-load-more');

        await waitForTestId(screen, 'team-credentials-retry');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credentials-row:resource-1');
        expect(harness.requestsFor(CREDENTIALS_LIST_PATH).at(-1)?.input).toMatchObject({
            cursor: 'resource-page-2',
        });

        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [
                    // A page boundary may repeat its last row while the Home is
                    // changing; the retained sequence owns id-based dedupe.
                    teamCredentialResourceFixture({ id: 'resource-1', displayName: 'Alpha' }),
                    teamCredentialResourceFixture({ id: 'resource-2', displayName: 'Alpha' }),
                ],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: null,
            },
        });
        await screen.pressByTestIdAsync('team-credentials-retry');

        await waitForTestId(screen, 'team-credentials-row:resource-2');
        const renderedIds = collectRenderedTestIds(screen.tree.toJSON());
        expect(renderedIds.filter((id) => id === 'team-credentials-row:resource-1')).toHaveLength(1);
        expect(renderedIds.indexOf('team-credentials-row:resource-1'))
            .toBeLessThan(renderedIds.indexOf('team-credentials-row:resource-2'));
        expect(harness.requestsFor(CREDENTIALS_LIST_PATH).at(-1)?.input).toMatchObject({
            cursor: 'resource-page-2',
        });
    });

    it('offers no filter while the list is short enough to read at a glance', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({ displayName: 'Needs review' })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: null,
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-row:resource-1');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credentials-filter');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credentials-search');
    });

    it('exposes the Home-owned list filters through one SelectionList and sends the chosen filter', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: Array.from({ length: 10 }, (_, index) => teamCredentialResourceFixture({
                    id: `resource-${index}`,
                    displayName: `Shared account ${index}`,
                })),
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: null,
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-filter');
        screen.pressByTestId('team-credentials-filter');

        const config = modalSpies.show.mock.calls.at(-1)?.[0] as undefined | Readonly<{
            component: React.ComponentType<Readonly<{
                onSelect(optionId: string): void;
            }>>;
            props: Readonly<{ onSelect(optionId: string): void }>;
        }>;
        expect(config?.component).toBeTypeOf('function');

        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({ id: 'attention', displayName: 'Needs attention' })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: null,
            },
        });
        config?.props.onSelect('needs_attention');

        await waitForTestId(screen, 'team-credentials-row:attention');
        expect(harness.requestsFor(CREDENTIALS_LIST_PATH).at(-1)?.input).toMatchObject({
            filter: 'needs_attention',
        });
    });

    it('ignores a response from a superseded search and keeps the current query visible', async () => {
        const serverId = await addHome();
        const initialRows = Array.from({ length: 10 }, (_, index) => teamCredentialResourceFixture({
            id: `initial-${index}`,
            displayName: `Initial ${index}`,
        }));
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: initialRows,
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: null,
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-search');

        let releaseOldSearch!: () => void;
        const oldSearchHeld = new Promise<void>((resolve) => { releaseOldSearch = resolve; });
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            respondAfter: oldSearchHeld,
            body: {
                resources: [teamCredentialResourceFixture({ id: 'old-search', displayName: 'Old result' })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: null,
            },
        });
        screen.changeTextByTestId('team-credentials-search:input', 'old');
        await vi.waitFor(() => {
            expect(harness.requestsFor(CREDENTIALS_LIST_PATH).at(-1)?.input).toMatchObject({ search: 'old' });
        });

        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({ id: 'new-search', displayName: 'New result' })],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: null,
            },
        });
        screen.changeTextByTestId('team-credentials-search:input', 'new');
        await waitForTestId(screen, 'team-credentials-row:new-search');

        releaseOldSearch();
        await Promise.resolve();
        await Promise.resolve();
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credentials-row:new-search');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credentials-row:old-search');
    });

    it('renders the two-line row the Home projected, without manager-private facts or raw source identity', async () => {
        const serverId = await addHome();
        const privateSource = {
            v: 1 as const,
            kind: 'connected_pool' as const,
            target: {
                kind: 'group' as const,
                service: { pluginId: 'private.plugin-id', localId: 'private-service-id' },
                groupId: 'private-source-group-id',
            },
            poolIncarnation: 'private-pool-incarnation',
        };
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [
                    // A manager's own row: the Home disclosed its audience.
                    teamCredentialResourceFixture({
                        id: 'resource-1',
                        displayName: 'Managed credential',
                        sourceOwnerDisplayName: 'Ada Lovelace',
                        sessionUsePolicy: 'team_context_required',
                        activeUsageLimitCount: 2,
                        allMembersAllowedRoutes: ['brokered'],
                        usageCapabilities: {
                            inferenceRequests: 'available',
                            totalTokens: 'available',
                            costUsd: 'unavailable',
                            limitCoverage: 'brokered_only',
                        },
                        source: privateSource,
                    }),
                    // A source custodian who is not a manager: the Home masked
                    // the audience and every manager-private default.
                    teamCredentialResourceFixture({
                        id: 'resource-2',
                        displayName: 'Offered credential',
                        sourceOwnerDisplayName: 'Ada Lovelace',
                        allMembersAllowedRoutes: ['direct'],
                        capabilities: {
                            manageAudience: false,
                            managePolicy: false,
                            manageLimits: false,
                            updateBrokerPlacement: true,
                            narrowDisclosure: true, widenDisclosure: false,
                            refreshDirectMaterial: true,
                            disable: true,
                            enable: true,
                            delete: true,
                        },
                        source: privateSource,
                    }),
                ],
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
                nextCursor: null,
            },
        });

        const screen = await renderCredentials(serverId);
        await waitForTestId(screen, 'team-credentials-row:resource-1');
        // The declared row carries the projection; the painted host only carries its text.
        const managed = screen.findAllByTestId('team-credentials-row:resource-1')[0];
        const offered = screen.findAllByTestId('team-credentials-row:resource-2')[0];
        // Source family and disclosed delivery on one line, the Home's state on the other.
        expect(managed?.props.subtitle).toBe(
            // A healthy resource says nothing about its state (craft: healthy is quiet).
            'teams.credentials.source.pool · teams.credentials.delivery.brokered',
        );
        // A masked audience is not "direct" and masked policy defaults are not facts.
        expect(offered?.props.subtitle).toBe('teams.credentials.source.pool');
        const text = screen.getTextContent();
        for (const privateFact of [
            'teams.credentials.usePolicy.teamContextRequired',
            'teams.credentials.usePolicy.personalAllowed',
            'teams.credentials.requestPolicy.summaryNone',
            'teams.credentials.limits.empty',
            'teams.credentials.limits.metric.requests',
            'teams.credentials.usage.title',
            'private.plugin-id',
            'private-service-id',
            'private-source-group-id',
            'private-pool-incarnation',
        ]) expect(text).not.toContain(privateFact);
    });
});
