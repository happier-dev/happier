import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { expectHomePageReadCosts } from '@/dev/testkit/harness/expectHomePageReadCosts';
import { TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_DEFAULT_V1, TeamDirectorySourcePageV1Schema, TeamIdentityConnectionListResultV1Schema, TeamIdentityConnectionCreateInputV1Schema } from '@happier-dev/protocol/teams';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { teamCapabilitiesFixture, teamSummaryFixture, teamIdentityConnectionFixture, teamDirectorySourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import type { HomeAuthEntryRefusal } from '@/auth/entry/authEntryClient';
import { ManagedGitHubAppsListOutputV1Schema } from '@happier-dev/protocol/identity/githubApps';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

const routerPushMock = vi.hoisted(() => vi.fn());
const teamFixture = {
    canMutate: false,
    manageAuthentication: true,
    directoryMembership: undefined as undefined | null | Readonly<{
        providerDisplayName: string; state: 'syncing' | 'healthy' | 'needs_attention';
    }>,
};
const identityFixture = {
    current: {
        kind: 'ready' as const,
        refreshing: false,
        stale: false,
        failure: null,
        items: [] as Array<Record<string, unknown>>,
        memberSignInUrl: null as string | null,
        admissionModeApplicability: {
            v: 1 as const,
            modes: {
                invite_only: { status: 'available' as const },
                provisioned: { status: 'unavailable' as const, reason: 'directory_source_required' as const },
                jit: { status: 'unavailable' as const, reason: 'team_connection_required' as const },
            },
        },
        eligibleProviders: [{
            v: 1 as const, providerId: 'provider-1', providerKind: 'oidc' as const, owner: 'home' as const, displayName: 'OIDC',
            availability: {
                status: 'available' as const,
                setupChoice: {
                    kind: 'use_existing' as const, providerInstanceId: 'provider-1',
                    connectionDraft: {
                        externalReference: { v: 1 as const, kind: 'oidc' as const },
                        settings: { v: 1 as const, kind: 'oidc' as const, allowedUsers: [] as string[], allowedEmailDomains: [] as string[], groupsAny: [] as string[], groupsAll: [] as string[] },
                    },
                },
            },
        }] as Array<Record<string, unknown>>,
    },
};

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushMock } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [], BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [],
}));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
let serverId: string;
const connectionsPath = '/v1/teams/identity/connections/list';
const createPath = '/v1/teams/identity/connections/create';
const sourcesPath = '/v1/teams/team-1/directory-sources';
const githubAppsPath = '/v1/identity/github-apps/list';
const entryPath = '/v1/auth/entry';
let directoryPage: unknown;
let createResponseId = 'connection-1';
let githubApps = ManagedGitHubAppsListOutputV1Schema.parse({ registrations: [], installations: [] });

function answerConnections(items = identityFixture.current.items) {
    harness.answer(serverId, connectionsPath, { body: TeamIdentityConnectionListResultV1Schema.parse({
        items, eligibleProviders: identityFixture.current.eligibleProviders,
        admissionModeApplicability: identityFixture.current.admissionModeApplicability, memberSignInUrl: null,
    }) });
}

async function renderAuthentication(entryResponse: Parameters<typeof harness.answer>[2] = {
    body: AuthEntryProjectionV1Schema.parse({ v: 1, scope: { kind: 'home' }, state: 'ready', actions: [], autoRedirect: null }),
}) {
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({
        archivedAt: teamFixture.canMutate ? null : 1,
        capabilities: teamCapabilitiesFixture({ manageAuthentication: teamFixture.manageAuthentication }),
        ...(teamFixture.directoryMembership !== undefined ? { directoryMembership: teamFixture.directoryMembership } : {}),
    }) });
    answerConnections();
    harness.answer(serverId, sourcesPath, { body: TeamDirectorySourcePageV1Schema.parse(directoryPage) });
    harness.answer(serverId, githubAppsPath, { body: githubApps });
    harness.answer(serverId, entryPath, entryResponse);
    harness.answer(serverId, createPath, { select: input => {
        const request = TeamIdentityConnectionCreateInputV1Schema.parse(input);
        return { body: { connection: teamIdentityConnectionFixture({
            v: 1, id: createResponseId, teamId: 'team-1',
            provider: { id: request.providerInstanceId, kind: request.externalReference.kind, displayName: 'Corporate sign-in' },
            externalReference: request.externalReference, settings: request.settings,
            enabled: false, firstEnabledAt: null, revision: 1, state: 'disabled', allowedActions: [],
            lastObservation: null, lastSuccessfulTest: null, createdAt: 1, updatedAt: 1,
        }) } };
    } });
    const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-authentication-fact-directory')
        ?? screen.findByTestId('team-authentication-add-menu')).not.toBeNull());
    if (teamFixture.manageAuthentication) await waitForHomeGovernance(() => expect(addMenu(screen).items.length).toBeGreaterThan(0));
    return screen;
}

const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { TeamAuthenticationSettingsScreen } = await import('./TeamAuthenticationSettingsScreen');

type AddMenu = Readonly<{
    open: boolean;
    items: ReadonlyArray<Readonly<{ id: string; testID?: string; title: string; disabled?: boolean }>>;
    onSelect: (id: string) => void;
}>;

/**
 * "Add connection" is the section's "+" menu. It is driven through its props (as the Members "+" test
 * does): opening the real Popover needs a DOM window this native renderer does not have.
 */
function addMenu(screen: Awaited<ReturnType<typeof renderScreen>>): AddMenu {
    const node = screen.findAllByType(DropdownMenu as never)
        .find((candidate) => candidate.props?.testID === 'team-authentication-add-menu');
    expect(node).toBeTruthy();
    return node!.props as unknown as AddMenu;
}

function menuChoice(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return addMenu(screen).items.find((item) => item.testID === testID);
}

function mountedRows(screen: Awaited<ReturnType<typeof renderScreen>>, prefix: string) {
    return new Map(screen.findAllByType(Item)
        .filter(node => node.props.testID?.startsWith(prefix))
        .map(node => [node.props.testID, node.props] as const));
}

async function choose(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    const choice = menuChoice(screen, testID);
    expect(choice).toBeTruthy();
    await React.act(async () => { addMenu(screen).onSelect(choice!.id); });
}

beforeEach(async () => {
    standardCleanup();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-home.example', accountId: 'account-1', teamsEnabled: true });
    await harness.selectHomes([serverId]);
    directoryPage = { items: [], nextCursor: null };
    createResponseId = 'connection-1';
    githubApps = ManagedGitHubAppsListOutputV1Schema.parse({ registrations: [], installations: [] });
    routerPushMock.mockReset();
    identityFixture.current.refreshing = false;
    identityFixture.current.stale = false;
    identityFixture.current.items = [];
    identityFixture.current.eligibleProviders = [{
        v: 1,
        providerId: 'provider-1',
        providerKind: 'oidc',
        owner: 'home',
        displayName: 'OIDC',
        availability: {
            status: 'available',
            setupChoice: {
                kind: 'use_existing',
                providerInstanceId: 'provider-1',
                connectionDraft: {
                    externalReference: { v: 1, kind: 'oidc' },
                    settings: {
                        v: 1,
                        kind: 'oidc',
                        allowedUsers: [],
                        allowedEmailDomains: [],
                        groupsAny: [],
                        groupsAll: [],
                    },
                },
            },
        },
    }];
    teamFixture.canMutate = false;
    teamFixture.manageAuthentication = true;
    teamFixture.directoryMembership = undefined;
});

describe('TeamAuthenticationSettingsScreen', () => {
    const homeEntryRefusals = {
        entry_not_available: { state: 'denied', message: 'welcome.homeSignInRefusedTitle', asksAdmin: true },
        authentication_policy_unavailable: { state: 'unavailable', message: 'welcome.homeSignInPolicyUnavailableTitle', asksAdmin: true },
        client_update_required: { state: 'update_required', message: 'welcome.homeSignInClientUpdateTitle', asksAdmin: false },
        not_account_service: { state: 'denied', message: 'welcome.signInServiceUnsupportedTitle', asksAdmin: false },
    } satisfies Record<HomeAuthEntryRefusal['reason'], Readonly<{ state: HomeAuthEntryRefusal['state']; message: string; asksAdmin: boolean }>>;
    it.each(Object.entries(homeEntryRefusals))('shows the exact Home sign-in catalog refusal %s', async (reason, { state, message, asksAdmin }) => {
        const screen = await renderAuthentication({ body: AuthEntryProjectionV1Schema.parse({
            v: 1, scope: { kind: 'home' }, state, reason, autoRedirect: null,
        }) });
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(message));
        expect(screen.getTextContent().includes('identityAdministration.providerContactAdmin')).toBe(asksAdmin);
        expect(screen.findByTestId('team-authentication-home-methods-retry')).toBeNull();
        expect(harness.requestsFor(entryPath)).toHaveLength(1);
    });

    it.each([
        ['HTTP 503', { status: 503, body: { error: 'unavailable' } }],
        ['transport loss', { dispatchThenFail: true }],
    ] as const)('allows Retry when fetching the Home sign-in catalog fails with %s', async (_cause, response) => {
        const screen = await renderAuthentication(response);
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-authentication-home-methods-retry')).not.toBeNull());
        harness.answer(serverId, entryPath, { body: AuthEntryProjectionV1Schema.parse({ v: 1, scope: { kind: 'home' }, state: 'ready', actions: [], autoRedirect: null }) });
        await screen.pressByTestIdAsync('team-authentication-home-methods-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-authentication-home-methods-unavailable')).toBeNull());
        expect(harness.requestsFor(entryPath)).toHaveLength(2);
    });

    it('settles a denied Home sign-in catalog request without Retry', async () => {
        const screen = await renderAuthentication({ status: 403, body: { error: 'forbidden' } });
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-authentication-home-methods-unavailable')).not.toBeNull());
        expect(screen.findByTestId('team-authentication-home-methods-retry')).toBeNull();
    });

    it('reads each Authentication section once on cold open and return', async () => {
        const page = <TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />;
        const reads = { '/v1/teams/get': 1, [connectionsPath]: 1, [sourcesPath]: 1, [githubAppsPath]: 1, [entryPath]: 1 };
        await expectHomePageReadCosts({
            home: harness, mount: renderAuthentication, leave: <></>, returnTo: page,
            settled: screen => expect(menuChoice(screen, 'team-eligible-provider:provider-1')).toBeDefined(),
            cold: reads, returning: reads,
        });
    });

    it.each([
        ['syncing', 'syncing'],
        ['healthy', 'active'],
        ['needs_attention', 'needsAttention'],
    ] as const)('renders the safe Directory fact (%s) for a read-only member without requesting source administration', async (state, label) => {
        teamFixture.manageAuthentication = false;
        teamFixture.directoryMembership = { providerDisplayName: 'Okta via WorkOS', state };
        const screen = await renderAuthentication();
        const fact = screen.findAllByTestId('team-authentication-fact-directory')[0];
        expect(fact?.props).toMatchObject({
            title: 'Okta via WorkOS', subtitle: `teams.authentication.directory.state.${label}`,
            mode: 'info', showChevron: false,
        });
        expect(fact?.props.onPress).toBeUndefined();
        expect(harness.requestsFor(sourcesPath)).toHaveLength(0);
        expect(screen.findAllByTestId('team-authentication-add-menu')).toHaveLength(0);
    });

    it.each([
        [null, 'teams.authentication.directory.empty'],
        [undefined, 'teams.authentication.directory.unknown'],
    ] as const)('distinguishes absent Directory from an omitted older-server fact (%s)', async (fact, title) => {
        teamFixture.manageAuthentication = false;
        teamFixture.directoryMembership = fact;
        const screen = await renderAuthentication();
        const row = screen.findAllByTestId('team-authentication-fact-directory')[0];
        expect(row?.props).toMatchObject({ title, mode: 'info', showChevron: false });
        expect(row?.props.onPress).toBeUndefined();
        expect(harness.requestsFor(sourcesPath)).toHaveLength(0);
    });

    it('tells a read-only member what each fact means, as the same sections do for the managers', async () => {
        teamFixture.manageAuthentication = false;
        teamFixture.directoryMembership = null;
        const screen = await renderAuthentication();
        const text = screen.getTextContent();
        expect(text).toContain('teams.authentication.policy.admissionHelp');
        expect(text).toContain('teams.authentication.policy.acceptedHelp');
        expect(text).toContain('teams.authentication.directory.overviewSubtitle');
        expect(screen.findAllByTestId('team-authentication-fact-accepted')[0]?.props.subtitle)
            .toBe('teams.authentication.policy.acceptedInheritConsequence');
    });

    it('uses the translated canonical provider-kind label when the catalog has no display name', async () => {
        identityFixture.current.eligibleProviders[0]!.displayName = null;
        const screen = await renderAuthentication();
        expect(menuChoice(screen, 'team-eligible-provider:provider-1')?.title)
            .toBe('identityAdministration.providerOidc');
    });
    it('keeps every connection and eligible provider beyond 100 rows and updates only the edited connection', async () => {
        identityFixture.current.items = Array.from({ length: 101 }, (_, index) => ({
            v: 1,
            id: `connection-${index}`,
            teamId: 'team-1',
            provider: {
                id: `provider-${index}`,
                kind: 'oidc',
                displayName: `Provider ${index}`,
            },
            externalReference: { v: 1, kind: 'oidc' },
            settings: {
                v: 1,
                kind: 'oidc',
                allowedUsers: [],
                allowedEmailDomains: [],
                groupsAny: [],
                groupsAll: [],
            },
            enabled: true,
            firstEnabledAt: 1,
            revision: 1,
            state: 'connected',
            allowedActions: [],
            lastObservation: { v: 1, kind: 'oidc' },
            lastSuccessfulTest: null,
            createdAt: index,
            updatedAt: index,
        }));
        identityFixture.current.eligibleProviders = Array.from({ length: 101 }, (_, index) => ({
            v: 1,
            providerId: `eligible-provider-${index}`,
            providerKind: 'oidc',
            owner: 'home',
            displayName: `Eligible provider ${index}`,
            availability: {
                status: 'available',
                setupChoice: {
                    kind: 'use_existing',
                    providerInstanceId: `eligible-provider-${index}`,
                    connectionDraft: {
                        externalReference: { v: 1, kind: 'oidc' },
                        settings: {
                            v: 1,
                            kind: 'oidc',
                            allowedUsers: [],
                            allowedEmailDomains: [],
                            groupsAny: [],
                            groupsAll: [],
                        },
                    },
                },
            },
        }));

        const screen = await renderAuthentication();

        expect(screen.findByTestId('team-authentication-connection-connection-100')).toBeTruthy();
        // The ways to add another are the section's own "+" menu, closed until asked for.
        expect(addMenu(screen).open).toBe(false);
        expect(menuChoice(screen, 'team-eligible-provider:eligible-provider-100')).toBeTruthy();

        const rows = () => mountedRows(screen, 'team-authentication-connection-');
        const baseline = rows();
        expect(baseline.size).toBe(101);
        const changedId = 'team-authentication-connection-connection-0';
        const next = identityFixture.current.items.map((row, index) => index === 0 ? {
            ...row, state: 'disabled', enabled: false, revision: 2,
        } : row);
        answerConnections(next);
        await React.act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForHomeGovernance(() => expect(rows().get(changedId)?.subtitle).not.toBe(baseline.get(changedId)?.subtitle));
        const updated = rows();
        expect(updated.size).toBe(baseline.size);
        expect([...updated].filter(([id, props]) => props !== baseline.get(id)).map(([id]) => id)).toEqual([changedId]);
        expect(harness.requestsFor(connectionsPath)).toHaveLength(2);
    });

    it('keeps provider setup visible but disables it for a read-only Team', async () => {
        const screen = await renderAuthentication();

        expect(menuChoice(screen, 'team-eligible-provider:provider-1')?.disabled).toBe(true);
        await choose(screen, 'team-eligible-provider:provider-1');
        expect(harness.requestsFor(createPath)).toHaveLength(0);
    });

    it('blocks setup from a stale allowed-action projection while refreshing', async () => {
        teamFixture.canMutate = true;
        const screen = await renderAuthentication();
        const held = createDeferred<void>();
        harness.answer(serverId, connectionsPath, { body: TeamIdentityConnectionListResultV1Schema.parse({
            items: [], eligibleProviders: identityFixture.current.eligibleProviders,
            admissionModeApplicability: identityFixture.current.admissionModeApplicability, memberSignInUrl: null,
        }), respondAfter: held.promise });
        await React.act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForHomeGovernance(() => expect(menuChoice(screen, 'team-eligible-provider:provider-1')?.disabled).toBe(true));
        await choose(screen, 'team-eligible-provider:provider-1');
        expect(harness.requestsFor(createPath)).toHaveLength(0);
        await React.act(async () => held.resolve());
    });

    it('binds an eligible GitHub installation through the shared Team connection action', async () => {
        teamFixture.canMutate = true;
        identityFixture.current.eligibleProviders = [{
            v: 1,
            providerId: 'github-provider-1',
            providerKind: 'github_app_identity',
            owner: 'team',
            displayName: 'Acme GitHub',
            availability: {
                status: 'available',
                setupChoice: {
                    kind: 'use_existing',
                    providerInstanceId: 'github-provider-1',
                    connectionDraft: {
                        externalReference: {
                            v: 1,
                            kind: 'github_app_identity',
                            installationId: 'installation-1',
                        },
                        settings: {
                            v: 1,
                            kind: 'github_app_identity',
                            organizationLogin: 'Acme',
                        },
                    },
                },
            },
        }];
        const screen = await renderAuthentication();

        await choose(screen, 'team-eligible-provider:github-provider-1');

        expect(harness.requestsFor(createPath)).toHaveLength(1);
        expect(harness.requestsFor(createPath)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            providerInstanceId: 'github-provider-1',
            externalReference: {
                v: 1,
                kind: 'github_app_identity',
                installationId: 'installation-1',
            },
            settings: {
                v: 1,
                kind: 'github_app_identity',
                organizationLogin: 'Acme',
            },
        });
        await waitForHomeGovernance(() => expect(routerPushMock).toHaveBeenCalledWith(
            `/settings/teams/${serverId}/team-1/authentication/connection-1`,
        ));
    });

    it('navigates to the created connection after the real Ask confirmation succeeds', async () => {
        teamFixture.canMutate = true;
        createResponseId = 'connection-approved';
        await harness.requireUiApproval(serverId, 'teams.identity.connections.create');
        const screen = await renderAuthentication();
        await choose(screen, 'team-eligible-provider:provider-1');
        const { Modal } = await import('@/modal');
        expect(Modal.confirm).toHaveBeenCalled();
        expect(harness.requestsFor(createPath)).toHaveLength(1);
        await waitForHomeGovernance(() => expect(routerPushMock).toHaveBeenCalledWith(
            `/settings/teams/${serverId}/team-1/authentication/connection-approved`,
        ));
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it('keeps retained GitHub App registrations reachable when Home policy disables new setup', async () => {
        teamFixture.canMutate = true;
        identityFixture.current.eligibleProviders = [{
            v: 1,
            providerId: null,
            providerKind: 'github_app_identity',
            owner: 'team',
            displayName: null,
            availability: {
                status: 'unavailable',
                code: 'home_policy_prohibited',
            },
        }];

        githubApps = ManagedGitHubAppsListOutputV1Schema.parse({ registrations: [{
            id: 'registration-retained', owner: { kind: 'team', teamId: 'team-1' }, githubHost: 'https://github.com',
            githubAppId: '12', githubClientId: 'Iv1.client', githubAppSlug: 'retained-app',
            githubOwnerId: '22', githubOwnerLogin: 'happier-dev', revision: 2, securityRevision: 1,
            state: 'disabled', secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: true },
            lastVerifiedAt: null, createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
        }], installations: [] });
        const screen = await renderAuthentication();
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-github-app-add')).not.toBeNull());
        expect(screen.findByTestId('home-github-app-add')?.props.disabled).toBe(true);
        expect(screen.findByTestId('home-github-app:registration-retained')).not.toBeNull();
        await screen.pressByTestIdAsync('home-github-app:registration-retained');
        expect(routerPushMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/github-apps/registration-retained`);
    });

    it('disables generic GitHub setup and Add App for provider_setup_unavailable', async () => {
        teamFixture.canMutate = true;
        identityFixture.current.eligibleProviders = [{
            v: 1,
            providerId: null,
            providerKind: 'github_app_identity',
            owner: 'team',
            displayName: null,
            availability: {
                status: 'unavailable',
                code: 'provider_setup_unavailable',
            },
        }];

        const screen = await renderAuthentication();

        expect(menuChoice(screen, 'team-eligible-provider:github_app_identity')?.disabled).toBe(true);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-github-app-add')).not.toBeNull());
        expect(screen.findByTestId('home-github-app-add')?.props.disabled).toBe(true);
    });

    it('enables generic GitHub setup and Add App only for an available create-managed catalog row', async () => {
        teamFixture.canMutate = true;
        identityFixture.current.eligibleProviders = [{
            v: 1,
            providerId: null,
            providerKind: 'github_app_identity',
            owner: 'team',
            displayName: null,
            availability: {
                status: 'available',
                setupChoice: { kind: 'create_managed', actionId: 'identity.githubApps.manifestSetup.start' },
            },
        }];

        const screen = await renderAuthentication();

        expect(menuChoice(screen, 'team-eligible-provider:github_app_identity')?.disabled).toBe(false);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-github-app-add')).not.toBeNull());
        expect(screen.findByTestId('home-github-app-add')?.props.disabled).toBe(false);
    });

    it('opens the exact directory source and updates only its row on a Team change', async () => {
        const items = Array.from({ length: TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_DEFAULT_V1 }, (_, index) =>
            teamDirectorySourceFixture({ id: `source-${index}`, displayName: `Directory ${String(index).padStart(2, '0')}` }));
        directoryPage = { items, nextCursor: null };
        const screen = await renderAuthentication();
        const rows = () => mountedRows(screen, 'team-authentication-directory-source:');
        const changedId = 'team-authentication-directory-source:source-0';
        await waitForHomeGovernance(() => expect(rows().size).toBe(items.length));
        const baseline = rows();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId(changedId)!, 'Text', 'Directory 00')).toBeDefined();
        await screen.pressByTestIdAsync(changedId);
        expect(routerPushMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/directory/source-0`);

        const next = items.map((row, index) => index === 0 ? { ...row, displayName: 'Directory 00 renamed' } : row);
        harness.answer(serverId, sourcesPath, { body: TeamDirectorySourcePageV1Schema.parse({ items: next, nextCursor: null }) });
        await React.act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForHomeGovernance(() => expect(rows().get(changedId)?.title).toBe('Directory 00 renamed'));
        const updated = rows();
        expect(updated.size).toBe(baseline.size);
        expect([...updated].filter(([id, props]) => props !== baseline.get(id)).map(([id]) => id)).toEqual([changedId]);
        expect(harness.requestsFor(sourcesPath)).toHaveLength(2);
    });

    it('says a Team without a directory in one quiet line and offers "Add source" as the section action', async () => {
        teamFixture.canMutate = true;
        const screen = await renderAuthentication();

        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('teams.authentication.directory.empty'));
        await screen.pressByTestIdAsync('team-authentication-directory-add');
        expect(routerPushMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/directory`);
    });

    it('says the New members row\'s chosen consequence alone, and each blocked mode\'s prerequisite where it is added', async () => {
        const screen = await renderAuthentication();
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-authentication-directory')).not.toBeNull());
        // One row, one decision, one description: the chosen mode's consequence, never "Directory: …".
        const admission = screen.findAllByType(Item).find((node) => node.props.testID === 'team-admission-mode');
        expect(admission?.props.subtitle).toBe('teams.authentication.policy.admissionInviteOnlyDescription');
        // Each blocked mode still announces its own reason after its name.
        expect(screen.findByTestId('team-admission-mode:provisioned')?.props.accessibilityLabel)
            .toContain('teams.authentication.policy.admissionUnavailableReason.directorySourceRequired');
        // The prerequisite is said where it is added: its section's line, beside that section's "+".
        expect(stateLine(screen, 'team-authentication-empty')?.reason)
            .toBe('teams.authentication.policy.admissionNeeds.connection');
        expect(stateLine(screen, 'team-authentication-directory')?.reason)
            .toBe('teams.authentication.policy.admissionNeeds.directory');
    });
});

const { Item } = await import('@/components/ui/lists/Item');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
function stateLine(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === testID)?.props as
        | Readonly<{ title?: string; reason?: string }> | undefined;
}
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
const { ItemLoadStateRows } = await import('@/components/ui/lists/ItemLoadStateRows');

describe('the Authentication page while its Team is read', () => {
    async function applyDirectoryRow(directoryRow: Partial<Parameters<typeof teamSummaryFixture>[0]>) {
        const { applyTeamsDirectoryPage } = await import('@/sync/store/teams/teamsSnapshots');
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { teamDirectoryQueryKeyV1 } = await import('@happier-dev/protocol/teams');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        applyTeamsDirectoryPage({
            scope: createServerAccountScope(resolveServerProfileScopeIdForIdentifier(serverId), 'account-1')!,
            queryKey: teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' }),
            items: [teamSummaryFixture({
                capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
                ...directoryRow,
            })],
            observedAt: 1,
        });
    }
    async function heldAuthentication(options: Readonly<{ directoryRow: Partial<Parameters<typeof teamSummaryFixture>[0]> | null }>) {
        if (options.directoryRow) await applyDirectoryRow(options.directoryRow);
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture(), respondAfter: new Promise<void>(() => {}) });
        // The page's own reads start beside the Team's read and are still running.
        harness.answer(serverId, connectionsPath, { body: {}, respondAfter: new Promise<void>(() => {}) });
        harness.answer(serverId, sourcesPath, { body: {}, respondAfter: new Promise<void>(() => {}) });
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />);
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/teams/get').length).toBeGreaterThan(0));
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('team-page-header')).not.toBeNull());
        return screen;
    }
    const sections = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(ItemGroup)
        .filter((node) => typeof node.props.title === 'string')
        .map((node) => [node.props.title, node.props.description]);
    const PAGE_SECTIONS = [
        ['teams.authentication.policy.admissionSection', 'teams.authentication.policy.admissionHelp'],
        ['teams.authentication.policy.acceptedSection', 'teams.authentication.policy.acceptedHelp'],
        ['teams.authentication.connectionsSection', 'teams.authentication.connectionsDescription'],
        ['teams.authentication.directory.section', 'teams.authentication.directory.overviewSubtitle'],
    ];

    it('waits on one quiet line, with no section, while the viewer\'s role is not known', async () => {
        const screen = await heldAuthentication({ directoryRow: null });
        // Each role's page is shaped differently (a manager's Sign-in connections, a member's read-only notice), so
        // no section scaffold stands that the arriving role would rearrange.
        expect(sections(screen)).toEqual([]);
        expect(screen.findAllByType(SurfaceStateCard).filter((node) => node.props.kind === 'loading')).toHaveLength(1);
        expect(screen.findByTestId('team-admission-mode')).toBeNull();
        expect(screen.findByTestId('team-authentication-add-connection')).toBeNull();
        expect(screen.findByTestId('team-authentication-directory-add')).toBeNull();
    });

    it.each([['a manager', true], ['a member', false]] as const)(
        'draws %s\'s own page once the Teams row names the role',
        async (_viewer, manager) => {
            const screen = await heldAuthentication({ directoryRow: null });
            await React.act(async () => {
                await applyDirectoryRow({
                    directoryMembership: null, capabilities: teamCapabilitiesFixture({ manageAuthentication: manager }),
                });
            });
            await waitForHomeGovernance(() => expect(sections(screen).length).toBeGreaterThan(0));
            if (manager) {
                expect(sections(screen)).toEqual(PAGE_SECTIONS);
                expect(screen.findByTestId('team-authentication-add-connection')).not.toBeNull();
            } else {
                expect(screen.findByTestId('team-authentication-forbidden')).not.toBeNull();
                expect(sections(screen).map(([title]) => title)).not.toContain('teams.authentication.connectionsSection');
                expect(screen.findByTestId('team-authentication-add-connection')).toBeNull();
                expect(screen.findByTestId('team-authentication-directory-add')).toBeNull();
            }
        },
    );

    it('reserves a known member\'s read-only page from the Teams row, never the managers\' affordances', async () => {
        const screen = await heldAuthentication({ directoryRow: {
            directoryMembership: null, capabilities: teamCapabilitiesFixture({ manageAuthentication: false }),
        } });
        expect(screen.findByTestId('team-authentication-forbidden')).not.toBeNull();
        expect(sections(screen).map(([title]) => title)).not.toContain('teams.authentication.connectionsSection');
        expect(screen.findByTestId('team-authentication-add-connection')).toBeNull();
        expect(screen.findByTestId('team-authentication-directory-add')).toBeNull();
        expect(screen.findHostByTestId('team-authentication-fact-admission')).not.toBeNull();
    });

    it('keeps one mounted policy row and the known directory line from the reserve through the live page', async () => {
        const { applyTeamsDirectoryPage } = await import('@/sync/store/teams/teamsSnapshots');
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { teamDirectoryQueryKeyV1 } = await import('@happier-dev/protocol/teams');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const team = teamSummaryFixture({ directoryMembership: null, capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) });
        applyTeamsDirectoryPage({
            scope: createServerAccountScope(resolveServerProfileScopeIdForIdentifier(serverId), 'account-1')!,
            queryKey: teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' }),
            items: [team], observedAt: 1,
        });
        const teamRead = createDeferred<void>();
        const connectionsRead = createDeferred<void>();
        const sourcesRead = createDeferred<void>();
        harness.answer(serverId, '/v1/teams/get', { body: team, respondAfter: teamRead.promise });
        harness.answer(serverId, connectionsPath, { body: TeamIdentityConnectionListResultV1Schema.parse({
            items: [], eligibleProviders: identityFixture.current.eligibleProviders,
            admissionModeApplicability: identityFixture.current.admissionModeApplicability, memberSignInUrl: null,
        }), respondAfter: connectionsRead.promise });
        harness.answer(serverId, sourcesPath, { body: TeamDirectorySourcePageV1Schema.parse({ items: [], nextCursor: null }), respondAfter: sourcesRead.promise });
        harness.answer(serverId, '/v1/identity/github-apps/list', { body: githubApps });
        harness.answer(serverId, '/v1/auth/entry', { body: AuthEntryProjectionV1Schema.parse({ v: 1, scope: { kind: 'home' }, state: 'ready', actions: [], autoRedirect: null }) });
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />);
        const policyRow = () => screen.findHostByTestId('team-admission-mode');
        const directoryShowsItsLine = () => {
            expect(stateLine(screen, 'team-authentication-directory')?.title).toBe('teams.authentication.directory.empty');
            expect(screen.findAllByType(ItemLoadStateRows).filter((node) => node.props.testID === 'team-authentication-directory-loading')).toHaveLength(0);
        };
        await waitForHomeGovernance(() => expect(policyRow()).not.toBeNull());
        const reserved = policyRow()!.instance;
        directoryShowsItsLine();

        // The Team answers: the page is live while its connection and directory reads run.
        await React.act(async () => { teamRead.resolve(); });
        await waitForHomeGovernance(() => expect(harness.requestsFor(sourcesPath).length).toBeGreaterThan(0));
        expect(policyRow()!.instance).toBe(reserved);
        directoryShowsItsLine();

        // The connections answer: still the same row.
        await React.act(async () => { connectionsRead.resolve(); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-authentication-add-menu')).not.toBeNull());
        expect(policyRow()!.instance).toBe(reserved);
        directoryShowsItsLine();

        await React.act(async () => { sourcesRead.resolve(); });
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('team-authentication-directory-add')?.props.disabled).not.toBe(true));
        expect(policyRow()!.instance).toBe(reserved);
        directoryShowsItsLine();
        // The page's reads start once and are not asked again when the Team answers.
        expect(harness.requestsFor(connectionsPath)).toHaveLength(1);
        expect(harness.requestsFor(sourcesPath)).toHaveLength(1);
    });

    it('draws the policy rows the Team summary already holds and reserves only what it does not know', async () => {
        const screen = await heldAuthentication({ directoryRow: { directoryMembership: null } });
        expect(sections(screen)).toEqual(PAGE_SECTIONS);
        // The summary carries the policy, so its rows stand as they will (disabled until the Team answers).
        const admission = screen.findAllByType(Item).find((node) => node.props.testID === 'team-admission-mode');
        expect(admission?.props.subtitle).toBe('teams.authentication.policy.admissionInviteOnlyDescription');
        // No directory in the summary: its one line, not a reserved row. Connections are unknown: one row.
        expect(stateLine(screen, 'team-authentication-directory')?.title).toBe('teams.authentication.directory.empty');
        // No connection is proven: one quiet line waits in the empty line's own shape, beside the held "+".
        expect(screen.findAllByType(ItemLoadStateRows)).toHaveLength(0);
        expect(stateLine(screen, 'team-authentication-loading')).toBeDefined();
        expect(screen.findByTestId('team-authentication-add-connection')).not.toBeNull();
        expect(screen.findByTestId('team-authentication-directory-add')).not.toBeNull();
    });
});
