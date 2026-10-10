import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const executeMock = vi.hoisted(() => vi.fn());
const executeDirectoryMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());
const teamGitHubAppsSectionMock = vi.hoisted(() => vi.fn((_props: Readonly<{
    createAvailable: boolean;
}>) => null));
const teamContextMock = vi.hoisted(() => ({ canMutate: false }));
const identityStateMock = vi.hoisted(() => ({
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
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushMock }),
    useLocalSearchParams: () => ({}),
}));
// Rows render their right-hand control, as the real row does; page fields are text inputs.
vi.mock('@/components/ui/lists/Item', async () => {
    const React = await import('react');
    return { Item: (props: { rightElement?: unknown }) => React.createElement('Item', props, props.rightElement as never) };
});
vi.mock('@/components/ui/forms/FieldTextInput', () => ({ FieldTextInput: 'TextInput' }));
// A section renders its trailing action ("Add connection") as the real group does.
vi.mock('@/components/ui/lists/ItemGroup', async () => {
    const React = await import('react');
    return {
        ItemGroup: (props: { action?: unknown; children?: unknown }) =>
            React.createElement('ItemGroup', props, props.action as never, props.children as never),
    };
});
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./TeamGitHubAppScreens', () => ({ TeamGitHubAppsSection: teamGitHubAppsSectionMock }));
vi.mock('./TeamMemberSignInLinkSection', () => ({ TeamMemberSignInLinkSection: () => null }));
vi.mock('./TeamAuthenticationPolicySections', () => ({ TeamAuthenticationPolicySections: () => null }));
// The identity transport is the boundary: the real directory reader runs on top of it.
vi.mock('./identityAdministrationClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('./identityAdministrationClient')>(),
    createIdentityAdministrationClient: () => ({ execute: executeMock, executeDirectory: executeDirectoryMock }),
}));
vi.mock('./useIdentityAdministration', () => ({
    useIdentityAdministration: () => ({
        refresh: vi.fn(),
        state: identityStateMock.current,
    }),
}));
vi.mock('../TeamSection', async () => {
    const { teamPolicyFixture } = await import('@/dev/testkit/fixtures/teamFixtures');
    return {
        TeamSection: (props: Readonly<{ children: (context: unknown) => React.ReactNode }>) => props.children({
            // The Team policy is part of every Team projection this screen reads;
            // the authentication policy editor renders from it.
            team: { capabilities: { manageAuthentication: true }, policy: teamPolicyFixture() },
            scope: { serverId: 'home-1', accountId: 'account-1' },
            address: { serverId: 'home-1', teamId: 'team-1' },
            canMutate: teamContextMock.canMutate,
            approvalPending: false,
            requestApproval: vi.fn(),
            refresh: vi.fn(),
        }),
    };
});

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { TeamAuthenticationSettingsScreen } from './TeamAuthenticationSettingsScreen';

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

beforeEach(() => {
    standardCleanup();
    executeMock.mockReset();
    executeDirectoryMock.mockReset();
    executeDirectoryMock.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } });
    routerPushMock.mockReset();
    teamGitHubAppsSectionMock.mockClear();
    identityStateMock.current.refreshing = false;
    identityStateMock.current.stale = false;
    identityStateMock.current.items = [];
    identityStateMock.current.eligibleProviders = [{
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
    teamContextMock.canMutate = false;
});

describe('TeamAuthenticationSettingsScreen', () => {
    it('uses the translated canonical provider-kind label when the catalog has no display name', async () => {
        identityStateMock.current.eligibleProviders[0]!.displayName = null;
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);
        expect(menuChoice(screen, 'team-eligible-provider:provider-1')?.title)
            .toBe('identityAdministration.providerOidc');
    });
    it('keeps every connection and eligible provider mounted beyond 100 rows', async () => {
        identityStateMock.current.items = Array.from({ length: 101 }, (_, index) => ({
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
        identityStateMock.current.eligibleProviders = Array.from({ length: 101 }, (_, index) => ({
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

        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(screen.findByTestId('team-authentication-connection-connection-100')).toBeTruthy();
        // The ways to add another are the section's own "+" menu, closed until asked for.
        expect(addMenu(screen).open).toBe(false);
        expect(menuChoice(screen, 'team-eligible-provider:eligible-provider-100')).toBeTruthy();
    });

    it('keeps provider setup visible but disables it for a read-only Team', async () => {
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(menuChoice(screen, 'team-eligible-provider:provider-1')?.disabled).toBe(true);
        await choose(screen, 'team-eligible-provider:provider-1');
        expect(executeMock).not.toHaveBeenCalled();
    });

    it('blocks setup from a stale allowed-action projection while refreshing', async () => {
        identityStateMock.current.refreshing = true;
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(menuChoice(screen, 'team-eligible-provider:provider-1')?.disabled).toBe(true);
        await choose(screen, 'team-eligible-provider:provider-1');
        expect(executeMock).not.toHaveBeenCalled();
    });

    it('binds an eligible GitHub installation through the shared Team connection action', async () => {
        teamContextMock.canMutate = true;
        identityStateMock.current.eligibleProviders = [{
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
        executeMock.mockResolvedValueOnce({
            ok: true,
            value: { connection: { id: 'connection-1' } },
        });
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        await choose(screen, 'team-eligible-provider:github-provider-1');

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(executeMock).toHaveBeenCalledWith('teams.identity.connections.create', {
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
        }, expect.any(Object));
    });

    it('navigates to the created connection when a use-existing Action finishes after approval', async () => {
        teamContextMock.canMutate = true;
        let complete: ((value: Readonly<{ connection: Readonly<{ id: string }> }>) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalSucceeded?: typeof complete }>,
        ) => {
            complete = options?.onApprovalSucceeded;
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-create-1',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        await choose(screen, 'team-eligible-provider:provider-1');
        expect(routerPushMock).not.toHaveBeenCalled();
        expect(complete).toBeTypeOf('function');

        await complete?.({ connection: { id: 'connection-approved' } });
        expect(routerPushMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/connection-approved',
        );
    });

    it('keeps retained GitHub App registrations reachable when Home policy disables new setup', async () => {
        teamContextMock.canMutate = true;
        identityStateMock.current.eligibleProviders = [{
            v: 1,
            providerId: null,
            providerKind: 'github_app_identity',
            owner: 'team',
            displayName: null,
            availability: {
                status: 'unavailable',
                code: 'home_policy_prohibited',
                setupChoice: { kind: 'create_managed', actionId: 'identity.githubApps.manifestSetup.start' },
            },
        }];

        await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(teamGitHubAppsSectionMock).toHaveBeenCalled();
        expect(teamGitHubAppsSectionMock.mock.lastCall?.[0]).toEqual(expect.objectContaining({
            createAvailable: false,
        }));
    });

    it('disables generic GitHub setup and Add App for provider_setup_unavailable', async () => {
        teamContextMock.canMutate = true;
        identityStateMock.current.eligibleProviders = [{
            v: 1,
            providerId: null,
            providerKind: 'github_app_identity',
            owner: 'team',
            displayName: null,
            availability: {
                status: 'unavailable',
                code: 'provider_setup_unavailable',
                setupChoice: { kind: 'create_managed', actionId: 'identity.githubApps.manifestSetup.start' },
            },
        }];

        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(menuChoice(screen, 'team-eligible-provider:github_app_identity')?.disabled).toBe(true);
        expect(teamGitHubAppsSectionMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            createAvailable: false,
        }));
    });

    it('enables generic GitHub setup and Add App only for an available create-managed catalog row', async () => {
        teamContextMock.canMutate = true;
        identityStateMock.current.eligibleProviders = [{
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

        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        expect(menuChoice(screen, 'team-eligible-provider:github_app_identity')?.disabled).toBe(false);
        expect(teamGitHubAppsSectionMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            createAvailable: true,
        }));
    });

    it('names the Team\'s directory and where its sync stands, and opens that source', async () => {
        executeDirectoryMock.mockResolvedValue({
            ok: true,
            value: {
                items: [{
                    v: 1,
                    id: 'source-acme',
                    teamId: 'team-1',
                    kind: 'workos_directory',
                    displayName: 'Acme directory',
                    state: 'active',
                    allowedActions: [],
                    error: null,
                    sync: {
                        mode: 'events_and_full',
                        attempt: 'succeeded',
                        freshness: 'fresh',
                        lastAttemptAt: 1,
                        lastSuccessAt: 1,
                        lastFullReconcileAt: 1,
                        nextScheduledAt: null,
                    },
                }],
                nextCursor: null,
            },
        });
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        await vi.waitFor(() => {
            expect(screen.findByTestId('team-authentication-directory-source:source-acme')).toBeTruthy();
        });
        expect(screen.findByTestId('team-authentication-directory-source:source-acme')?.props.title).toBe('Acme directory');
        await screen.pressByTestIdAsync('team-authentication-directory-source:source-acme');
        expect(routerPushMock).toHaveBeenCalledWith('/settings/teams/home-1/team-1/authentication/directory/source-acme');
    });

    it('offers to connect a directory when the Team has none', async () => {
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId="home-1" teamId="team-1" />);

        await vi.waitFor(() => {
            expect(screen.findByTestId('team-authentication-directory')?.props.title)
                .toBe('teams.authentication.directory.empty');
        });
        await screen.pressByTestIdAsync('team-authentication-directory');
        expect(routerPushMock).toHaveBeenCalledWith('/settings/teams/home-1/team-1/authentication/directory');
    });
});
