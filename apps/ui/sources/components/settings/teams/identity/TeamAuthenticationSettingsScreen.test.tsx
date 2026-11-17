import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { TeamDirectorySourcePageV1Schema, TeamIdentityConnectionListResultV1Schema, TeamIdentityConnectionCreateInputV1Schema } from '@happier-dev/protocol/teams';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { teamCapabilitiesFixture, teamSummaryFixture, teamIdentityConnectionFixture, teamDirectorySourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
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
let directoryPage: unknown;
let createResponseId = 'connection-1';
let githubApps = ManagedGitHubAppsListOutputV1Schema.parse({ registrations: [], installations: [] });

async function renderAuthentication() {
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({
        archivedAt: teamFixture.canMutate ? null : 1,
        capabilities: teamCapabilitiesFixture({ manageAuthentication: teamFixture.manageAuthentication }),
        ...(teamFixture.directoryMembership !== undefined ? { directoryMembership: teamFixture.directoryMembership } : {}),
    }) });
    harness.answer(serverId, connectionsPath, { body: TeamIdentityConnectionListResultV1Schema.parse({
        items: identityFixture.current.items, eligibleProviders: identityFixture.current.eligibleProviders,
        admissionModeApplicability: identityFixture.current.admissionModeApplicability, memberSignInUrl: null,
    }) });
    harness.answer(serverId, sourcesPath, { body: TeamDirectorySourcePageV1Schema.parse(directoryPage) });
    harness.answer(serverId, '/v1/identity/github-apps/list', { body: githubApps });
    harness.answer(serverId, '/v1/auth/entry', { body: AuthEntryProjectionV1Schema.parse({ v: 1, scope: { kind: 'home' }, state: 'ready', actions: [], autoRedirect: null }) });
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
    it('keeps every connection and eligible provider mounted beyond 100 rows', async () => {
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

    it('names the Team\'s directory and where its sync stands, and opens that source', async () => {
        directoryPage = {
                items: [teamDirectorySourceFixture({ id: 'source-acme', displayName: 'Acme directory' })],
                nextCursor: null,
        };
        const screen = await renderAuthentication();

        await vi.waitFor(() => {
            expect(screen.findByTestId('team-authentication-directory-source:source-acme')).toBeTruthy();
        });
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('team-authentication-directory-source:source-acme')!, 'Text', 'Acme directory')).toBeDefined();
        await screen.pressByTestIdAsync('team-authentication-directory-source:source-acme');
        expect(routerPushMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/directory/source-acme`);
    });

    it('says a Team without a directory in one quiet line and offers "Add source" as the section action', async () => {
        teamFixture.canMutate = true;
        const screen = await renderAuthentication();

        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('teams.authentication.directory.empty'));
        await screen.pressByTestIdAsync('team-authentication-directory-add');
        expect(routerPushMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/directory`);
    });
});
