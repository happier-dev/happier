import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit`
 * barrel. The barrel re-exports `fixtures/agentCatalogFixtures`, whose
 * production projection reaches `@/sync/runtime/orchestration/connectionManager`
 * and, through it, `@/sync/http/client` and the reachability fetch. Evaluating
 * that graph on this file's first import binds the real transports and freezes
 * the applied active Home to the built-in default *before*
 * `installHomeGovernanceBoundaries` can install either boundary, so every Home
 * request leaves the harness and the screen never settles. This is the same
 * rule the harness states for its own late imports.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { HomeAdministrationContext } from './homeAdministrationContext';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const homePolicyOperationBoundary = vi.hoisted(() => ({
    setAuthenticationPolicies: null as null | ((params: unknown) => Promise<unknown>),
}));

installSettingsViewCommonModuleMocks();
vi.mock('@/sync/ops/home/homeGovernanceOperations', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/home/homeGovernanceOperations')>();
    return {
        ...actual,
        setHomeAuthenticationPolicies: async (
            params: Parameters<typeof actual.setHomeAuthenticationPolicies>[0],
        ): ReturnType<typeof actual.setHomeAuthenticationPolicies> => {
            const override = homePolicyOperationBoundary.setAuthenticationPolicies;
            if (!override) return actual.setHomeAuthenticationPolicies(params);
            return await override(params) as Awaited<ReturnType<typeof actual.setHomeAuthenticationPolicies>>;
        },
    };
});
// The generated bundled-artifact inventory is an unrelated build product and
// is deliberately absent from remote source mirrors. Keep this policy suite on
// the real Action path while supplying the inventory boundary's valid empty
// projection; plugin artifact selection is covered by its owning suites.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
}));
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: vi.fn(async () => null),
    }),
}));
vi.mock('@/sync/domains/plugins/availability/reader', () => ({
    createPluginAccountAvailabilityReader: vi.fn(),
    createPluginAccountAvailabilityReaderStore: () => Object.freeze({
        replace: () => null,
        clear: () => null,
        subscribe: () => () => undefined,
        bind: vi.fn(),
    }),
    projectPluginAccountAvailabilityMaterializationIdentity: vi.fn(),
}));
// This suite owns the Home policy controller. Provider/App lists are sibling
// surfaces with their own integration suites; importing their full runtime here
// would replace a focused policy check with plugin-artifact setup.
vi.mock('../identity/ManagedIdentityProvidersSection', () => ({
    ManagedIdentityProvidersSection: () => null,
}));
vi.mock('../githubApps/ManagedGitHubAppsSection', () => ({
    ManagedGitHubAppsSection: () => null,
    homeManagedGitHubAppSurface: vi.fn(),
    homeManagedGitHubAppCreatePath: vi.fn(),
}));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
let testStorage: typeof import('@/sync/domains/state/storage')['storage'];

function renderedControlIsDisabled(control: { props: Record<string, unknown> } | null): boolean {
    const props = control?.props;
    const accessibilityState = props?.accessibilityState as { disabled?: boolean } | undefined;
    return props?.['aria-disabled'] === true || accessibilityState?.disabled === true;
}

function renderedControlIsChecked(control: { props: Record<string, unknown> } | null): boolean {
    const props = control?.props;
    const accessibilityState = props?.accessibilityState as { checked?: boolean } | undefined;
    // A switch states its value; a segment or a radio states its checked state.
    return props?.value === true || props?.['aria-checked'] === true || accessibilityState?.checked === true;
}
beforeEach(async () => {
    await harness.reset();
    homePolicyOperationBoundary.setAuthenticationPolicies = null;
    ({ storage: testStorage } = await import('@/sync/domains/state/storage'));
    testStorage.setState({ settingsScope: null, settings: {} as never });
});
afterEach(() => {
    homePolicyOperationBoundary.setAuthenticationPolicies = null;
    standardCleanup();
});

describe('HomeAuthenticationPolicySections', () => {
    it('edits Team provider kinds through the Home policy revision owner', async () => {
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        projection.policy = {
            ...projection.policy,
            revision: 5,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['oidc'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: ['https://github.company.example'],
                },
            },
        };
        harness.answer(serverId, '/v1/home/policy/set', { body: { ...projection.policy, revision: 6 } });
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);
        expect(screen.findByTestId('home-policy-team-provider:oidc')).toBeTruthy();
        expect(screen.findByTestId('home-policy-team-provider:workos_sso')).toBeTruthy();
        expect(screen.findByTestId('home-policy-team-provider:github_app_identity')).toBeTruthy();

        await screen.pressByTestIdAsync('home-policy-team-provider:workos_sso');
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1));
        expect(harness.requestsFor('/v1/home/policy/set')[0]).toMatchObject({
            serverId,
            input: {
                expectedRevision: 5,
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ['workos_sso', 'oidc'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: ['https://github.company.example'],
                },
            },
        });
    });

    it('lets a fresh Home save its first Team-provider narrowing seeded from the deployment ceiling', async () => {
        // An absent policy inherits the deployment ceiling (teams-lane-01/02 :230, :234),
        // so the editor starts from the kinds this deployment can run, not from the enum.
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture({
            identityServices: {
                workos: 'not_configured',
                privateIdentityNetworkAllowed: false,
                teamProviderKinds: ['oidc', 'github_app_identity'],
            },
        });
        projection.policy = { ...projection.policy, revision: 0, teamProviders: { status: 'inherited' } };
        harness.answer(serverId, '/v1/home/policy/set', { body: { ...projection.policy, revision: 1 } });
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);
        expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-provider:oidc-switch'))).toBe(true);
        expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-provider:github_app_identity-switch'))).toBe(true);
        const workos = screen.findByTestId('home-policy-team-provider:workos_sso');
        expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-provider:workos_sso-switch'))).toBe(false);
        expect(renderedControlIsDisabled(workos)).toBe(true);

        await screen.pressByTestIdAsync('home-policy-team-provider:oidc');
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1));
        expect(harness.requestsFor('/v1/home/policy/set')[0]).toMatchObject({
            serverId,
            input: {
                expectedRevision: 0,
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ['github_app_identity'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
    });

    it('restores the committed Team-provider selection after an immediate refusal and submits the next click once', async () => {
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        projection.policy = {
            ...projection.policy,
            revision: 5,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['oidc'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        };
        harness.answer(serverId, '/v1/home/policy/set', {
            status: 500,
            body: { error: 'home_policy_unavailable' },
        });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);
        await screen.pressByTestIdAsync('home-policy-team-provider:workos_sso');
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1));
        await waitForHomeGovernance(() => expect(
            renderedControlIsChecked(screen.findByTestId('home-policy-team-provider:workos_sso-switch')),
        ).toBe(false));

        harness.answer(serverId, '/v1/home/policy/set', {
            body: { ...projection.policy, revision: 6 },
        });
        await screen.pressByTestIdAsync('home-policy-team-provider:workos_sso');
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(2));
        expect(harness.requestsFor('/v1/home/policy/set')[1]?.input).toMatchObject({
            expectedRevision: 5,
            teamProviderPolicy: {
                allowedTeamProviderKinds: ['workos_sso', 'oidc'],
            },
        });
    });

    it('restores the committed JIT selection after an immediate refusal', async () => {
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        projection.policy = {
            ...projection.policy,
            revision: 6,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['oidc'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        };
        harness.answer(serverId, '/v1/home/policy/set', {
            status: 500,
            body: { error: 'home_policy_unavailable' },
        });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);
        await screen.pressByTestIdAsync('home-policy-team-jit');
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1));
        await waitForHomeGovernance(() => expect(
            renderedControlIsChecked(screen.findByTestId('home-policy-team-jit-switch')),
        ).toBe(false));
    });

    it('keeps an approval candidate only while pending and restores the committed Team-provider selection when it terminates', async () => {
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        homePolicyOperationBoundary.setAuthenticationPolicies = async () => ({
            kind: 'approval_pending',
            artifactId: 'approval-home-policy-1',
        });
        const projection = homeGovernanceProjectionFixture();
        projection.policy = {
            ...projection.policy,
            revision: 7,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['oidc'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        };
        const requestApproval = vi.fn();
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            requestApproval,
            refresh: vi.fn(),
        };
        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);

        await screen.pressByTestIdAsync('home-policy-team-provider:workos_sso');
        await waitForHomeGovernance(() => expect(requestApproval).toHaveBeenCalledTimes(1));
        expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-provider:workos_sso-switch'))).toBe(true);

        await screen.update(<HomeTeamSignInRulesSection context={{ ...context, approvalPending: true }} />);
        expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-provider:workos_sso-switch'))).toBe(true);

        await screen.update(<HomeTeamSignInRulesSection context={{ ...context, approvalPending: false }} />);
        await waitForHomeGovernance(() => expect(
            renderedControlIsChecked(screen.findByTestId('home-policy-team-provider:workos_sso-switch')),
        ).toBe(false));
    });

    it('adopts the refreshed authoritative Team-provider selection after approved execution', async () => {
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        homePolicyOperationBoundary.setAuthenticationPolicies = async () => ({
            kind: 'approval_pending',
            artifactId: 'approval-home-policy-2',
        });
        const projection = homeGovernanceProjectionFixture();
        projection.policy = {
            ...projection.policy,
            revision: 8,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['oidc'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        };
        const requestApproval = vi.fn();
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            requestApproval,
            refresh: vi.fn(),
        };
        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);
        await screen.pressByTestIdAsync('home-policy-team-provider:workos_sso');
        await waitForHomeGovernance(() => expect(requestApproval).toHaveBeenCalledTimes(1));
        await screen.update(<HomeTeamSignInRulesSection context={{ ...context, approvalPending: true }} />);

        const refreshedProjection = homeGovernanceProjectionFixture();
        refreshedProjection.policy = {
            ...refreshedProjection.policy,
            revision: 9,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['workos_sso', 'oidc'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        };
        await screen.update(
            <HomeTeamSignInRulesSection
                context={{ ...context, projection: refreshedProjection, approvalPending: false }}
            />,
        );
        await waitForHomeGovernance(() => expect(
            renderedControlIsChecked(screen.findByTestId('home-policy-team-provider:workos_sso-switch')),
        ).toBe(true));
    });

    it('saves canonical GitHub Enterprise origins through the existing Team-provider policy CAS', async () => {
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        projection.policy = {
            ...projection.policy,
            revision: 12,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['github_app_identity'],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: ['https://github.first.example'],
                },
            },
        };
        harness.answer(serverId, '/v1/home/policy/set', { body: { ...projection.policy, revision: 13 } });
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);
        screen.changeTextByTestId(
            'home-policy-team-provider-origins',
            'https://github.first.example\n\nhttps://github.second.example:8443\n',
        );
        await waitForHomeGovernance(() => expect(
            renderedControlIsDisabled(screen.findByTestId('home-policy-team-provider-origins-save')),
        ).toBe(false));
        await screen.pressByTestIdAsync('home-policy-team-provider-origins-save');

        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1));
        expect(harness.requestsFor('/v1/home/policy/set')[0]).toMatchObject({
            serverId,
            input: {
                expectedRevision: 12,
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ['github_app_identity'],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: [
                        'https://github.first.example',
                        'https://github.second.example:8443',
                    ],
                },
            },
        });
    });

    it('keeps an invalid or duplicate GitHub Enterprise origin inline and never sends it', async () => {
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        projection.policy = {
            ...projection.policy,
            revision: 14,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['github_app_identity'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        };
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);
        screen.changeTextByTestId(
            'home-policy-team-provider-origins',
            'https://github.company.example/path',
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('home-policy-team-provider-origins.error')).toBeTruthy());
        expect(renderedControlIsDisabled(screen.findByTestId('home-policy-team-provider-origins-save'))).toBe(true);
        expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(0);

        screen.changeTextByTestId(
            'home-policy-team-provider-origins',
            'https://github.company.example\nhttps://github.company.example',
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-policy-team-provider-origins.error')).toBeTruthy());
        expect(renderedControlIsDisabled(screen.findByTestId('home-policy-team-provider-origins-save'))).toBe(true);
        expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(0);
    });

    it('keeps a GitHub Enterprise origin draft across a CAS conflict and retries with the refreshed revision', async () => {
        const { HomeTeamSignInRulesSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        projection.policy = {
            ...projection.policy,
            revision: 20,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['github_app_identity'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: ['https://github.old.example'],
                },
            },
        };
        harness.answer(serverId, '/v1/home/policy/set', {
            status: 409,
            body: { error: 'home_policy_revision_conflict' },
        });
        const refresh = vi.fn();
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh,
        };

        const screen = await renderScreen(<HomeTeamSignInRulesSection context={context} />);
        screen.changeTextByTestId('home-policy-team-provider-origins', 'https://github.mine.example');
        await waitForHomeGovernance(() => expect(
            renderedControlIsDisabled(screen.findByTestId('home-policy-team-provider-origins-save')),
        ).toBe(false));
        await screen.pressByTestIdAsync('home-policy-team-provider-origins-save');
        await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalledTimes(1));

        const refreshedProjection = homeGovernanceProjectionFixture();
        refreshedProjection.policy = {
            ...refreshedProjection.policy,
            revision: 21,
            teamProviders: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    allowedTeamProviderKinds: ['oidc', 'github_app_identity'],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: ['https://github.theirs.example'],
                },
            },
        };
        await screen.update(
            <HomeTeamSignInRulesSection context={{ ...context, projection: refreshedProjection }} />,
        );
        expect(screen.findByTestId('home-policy-team-provider-origins')!.props.value).toBe('https://github.mine.example');

        harness.answer(serverId, '/v1/home/policy/set', {
            body: { ...refreshedProjection.policy, revision: 22 },
        });
        await screen.pressByTestIdAsync('home-policy-team-provider-origins-save');
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(2));
        expect(harness.requestsFor('/v1/home/policy/set')[1]).toMatchObject({
            serverId,
            input: {
                expectedRevision: 21,
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ['oidc', 'github_app_identity'],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: ['https://github.mine.example'],
                },
            },
        });
    });

    it('says why private endpoints are unavailable and names the deployment key that fixes them', async () => {
        const { HomePrivateEndpointsSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Cloud', serverUrl: 'https://cloud.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture({
            identityServices: { workos: 'partially_configured', privateIdentityNetworkAllowed: false, teamProviderKinds: [] },
        });
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Cloud',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<HomePrivateEndpointsSection context={context} ceilingFixed />);
        expect(screen.findAllByTestId('home-policy-identity-network-mode:private_allowlist')).toHaveLength(0);
        expect(screen.findByTestId('home-sign-in-private-endpoints-unavailable')).not.toBeNull();
        // Fixed: the shared deployment note, the key as a chip, never prose (DR-17).
        expect(screen.findByTestId('home-sign-in-private-endpoints-unavailable.fixed-key:0')?.children)
            .toEqual(['HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED']);
        // Off because the Home left it off: no key, and the row leads to where it is turned on.
        await screen.update(<HomePrivateEndpointsSection context={context} ceilingFixed={false} />);
        expect(screen.getTextContent()).toContain('homeGovernance.signInProviders.privateEndpointsOffHere');
        expect(screen.getTextContent()).not.toContain('HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED');
        expect(screen.findByTestId('home-sign-in-private-endpoints-unavailable')?.props.onPress).toBeDefined();
    });

    it('saves an exact private endpoint allowlist through the Home policy revision owner', async () => {
        const { HomePrivateEndpointsSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Self hosted', serverUrl: 'https://self.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture({
            identityServices: { workos: 'configured', privateIdentityNetworkAllowed: true, teamProviderKinds: [] },
        });
        projection.policy = { ...projection.policy, revision: 7 };
        harness.answer(serverId, '/v1/home/policy/set', { body: { ...projection.policy, revision: 8 } });
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Self hosted',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<HomePrivateEndpointsSection context={context} ceilingFixed={null} />);
        await screen.pressByTestIdAsync('home-policy-identity-network-mode:private_allowlist');
        screen.changeTextByTestId('home-policy-identity-network-hostnames', 'idp.corp.example\n');
        screen.changeTextByTestId('home-policy-identity-network-cidrs', '10.0.0.0/8');
        screen.changeTextByTestId('home-policy-identity-network-ports', '443\n8443');
        await screen.pressByTestIdAsync('home-policy-identity-network-save');

        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1));
        expect(harness.requestsFor('/v1/home/policy/set')[0]).toMatchObject({
            serverId,
            input: {
                expectedRevision: 7,
                identityNetworkPolicy: {
                    v: 1,
                    mode: 'private_allowlist',
                    hostnames: ['idp.corp.example'],
                    cidrs: ['10.0.0.0/8'],
                    ports: [443, 8443],
                },
            },
        });
    });

    it('keeps a dirty private-network draft across a revision refresh and retries against the new revision', async () => {
        const { HomePrivateEndpointsSection } = await import('../signInProviders/HomeSignInProviderPolicySections');
        const serverId = await harness.addHome({ name: 'Self hosted', serverUrl: 'https://self.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture({
            identityServices: { workos: 'configured', privateIdentityNetworkAllowed: true, teamProviderKinds: [] },
        });
        projection.policy = {
            ...projection.policy,
            revision: 7,
            identityNetwork: {
                status: 'narrowed',
                policy: { v: 1, mode: 'public_only' },
            },
        };
        harness.answer(serverId, '/v1/home/policy/set', {
            status: 409,
            body: { error: 'home_policy_revision_conflict' },
        });
        const refresh = vi.fn();
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Self hosted',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh,
        };

        const screen = await renderScreen(<HomePrivateEndpointsSection context={context} ceilingFixed={null} />);
        await screen.pressByTestIdAsync('home-policy-identity-network-mode:private_allowlist');
        screen.changeTextByTestId('home-policy-identity-network-hostnames', 'idp.corp.example');
        screen.changeTextByTestId('home-policy-identity-network-cidrs', '10.0.0.0/8');
        screen.changeTextByTestId('home-policy-identity-network-ports', '443\n8443');
        await screen.pressByTestIdAsync('home-policy-identity-network-save');
        await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalledTimes(1));

        const refreshedProjection = homeGovernanceProjectionFixture({
            identityServices: { workos: 'configured', privateIdentityNetworkAllowed: true, teamProviderKinds: [] },
        });
        refreshedProjection.policy = {
            ...refreshedProjection.policy,
            revision: 8,
            identityNetwork: {
                status: 'narrowed',
                policy: {
                    v: 1,
                    mode: 'private_allowlist',
                    hostnames: ['someone-elses-idp.example'],
                    cidrs: [],
                    ports: [9443],
                },
            },
        };
        await screen.update(
            <HomePrivateEndpointsSection ceilingFixed={null}
                context={{ ...context, projection: refreshedProjection }}
            />,
        );

        harness.answer(serverId, '/v1/home/policy/set', {
            body: { ...refreshedProjection.policy, revision: 9 },
        });
        await screen.pressByTestIdAsync('home-policy-identity-network-save');
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(2));
        expect(harness.requestsFor('/v1/home/policy/set')[1]).toMatchObject({
            serverId,
            input: {
                expectedRevision: 8,
                identityNetworkPolicy: {
                    v: 1,
                    mode: 'private_allowlist',
                    hostnames: ['idp.corp.example'],
                    cidrs: ['10.0.0.0/8'],
                    ports: [443, 8443],
                },
            },
        });
    });
});

describe('TeamsVisibilityPolicyEditor', () => {
    it('turns "Show Teams to members" off through the Home policy and keeps it until the Home confirms', async () => {
        const { TeamsVisibilityPolicyEditor } = await import('./HomeTeamsPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        harness.answer(serverId, '/v1/home/policy/set', {
            body: { ...projection.policy, revision: projection.policy.revision + 1, teamsVisibleToMembers: false },
        });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<TeamsVisibilityPolicyEditor context={context} />);
        expect(screen.findByTestId('home-policy-teams-visible-to-members-switch')?.props.value).toBe(true);

        await act(async () => {
            screen.findByTestId('home-policy-teams-visible-to-members-switch')?.props.onValueChange(false);
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1));
        expect(harness.requestsFor('/v1/home/policy/set')[0]?.input).toEqual({
            expectedRevision: projection.policy.revision,
            teamsVisibleToMembers: false,
        });
        expect(screen.findByTestId('home-policy-teams-visible-to-members-switch')?.props.value).toBe(false);
    });

    it('is not offered by a Home that predates the policy', async () => {
        const { TeamsVisibilityPolicyEditor } = await import('./HomeTeamsPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        const { teamsVisibleToMembers: _absent, ...olderPolicy } = projection.policy;
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection: { ...projection, policy: olderPolicy },
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<TeamsVisibilityPolicyEditor context={context} />);
        expect(screen.findByTestId('home-policy-teams-visible-to-members')).toBeNull();
    });
});

describe('TeamCreationPolicyEditor', () => {
    it('leaves "this Home is not answering" to the page banner instead of repeating it on the section', async () => {
        const { TeamCreationPolicyEditor } = await import('./HomeTeamsPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection: homeGovernanceProjectionFixture(),
            mutationsAvailable: false,
            approvalPending: false,
            refresh: vi.fn(),
        };
        const screen = await renderScreen(<TeamCreationPolicyEditor context={context} />);
        expect(screen.getTextContent()).not.toContain('homeGovernance.reasonHomeUnreachable');
        // The committed choice stays marked while it cannot be changed.
        const committed = screen.findHostByTestId('home-policy-team-creation:managed_only');
        expect(committed?.props['aria-checked'] ?? committed?.props.accessibilityState?.checked).toBe(true);
    });


    it('does not carry a retained draft into the same route on another Home', async () => {
        const { TeamCreationPolicyEditor } = await import('./HomeTeamsPolicySections');
        const serverA = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner-a' });
        const serverB = await harness.addHome({ name: 'Home B', serverUrl: 'https://home-b.example', accountId: 'owner-b' });
        const projectionA = homeGovernanceProjectionFixture();
        harness.answer(serverA, '/v1/home/policy/set', { status: 500, body: { error: 'home_policy_unavailable' } });
        const contextA: HomeAdministrationContext = {
            scope: { serverId: serverA, accountId: 'owner-a' },
            homeName: 'Home A',
            projection: projectionA,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };
        const projectionB = homeGovernanceProjectionFixture();
        projectionB.policy = { ...projectionB.policy, teamCreationPolicy: 'disabled' };
        const contextB: HomeAdministrationContext = {
            scope: { serverId: serverB, accountId: 'owner-b' },
            homeName: 'Home B',
            projection: projectionB,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<TeamCreationPolicyEditor context={contextA} />);
        await screen.pressByTestIdAsync('home-policy-team-creation:self_service');
        await waitForHomeGovernance(() => expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-creation:self_service'))).toBe(true));

        await act(async () => {
            screen.tree.update(<TeamCreationPolicyEditor context={contextB} />);
        });

        expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-creation:disabled'))).toBe(true);
        expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-creation:self_service'))).toBe(false);
    });

    it('closes the same-frame duplicate-submit window before the busy state renders', async () => {
        const { TeamCreationPolicyEditor } = await import('./HomeTeamsPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        let finishSave: (() => void) | null = null;
        const saveResponse = new Promise<void>((resolve) => { finishSave = resolve; });
        harness.answer(serverId, '/v1/home/policy/set', {
            body: { ...projection.policy, revision: projection.policy.revision + 1, teamCreationPolicy: 'self_service' },
            respondAfter: saveResponse,
        });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };
        const screen = await renderScreen(<TeamCreationPolicyEditor context={context} />);
        const activate = screen.findByTestId('home-policy-team-creation:self_service')?.props.onPress as (() => void) | undefined;

        act(() => {
            activate?.();
            activate?.();
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1));

        await act(async () => {
            finishSave?.();
            await saveResponse;
        });
    });

    it('keeps the requested policy and offers an inline retry after a failed save', async () => {
        const { TeamCreationPolicyEditor } = await import('./HomeTeamsPolicySections');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
        const projection = homeGovernanceProjectionFixture();
        harness.answer(serverId, '/v1/home/policy/set', {
            status: 500,
            body: { error: 'home_policy_unavailable' },
        });
        const context: HomeAdministrationContext = {
            scope: { serverId, accountId: 'owner' },
            homeName: 'Home A',
            projection,
            mutationsAvailable: true,
            approvalPending: false,
            refresh: vi.fn(),
        };

        const screen = await renderScreen(<TeamCreationPolicyEditor context={context} />);
        await screen.pressByTestIdAsync('home-policy-team-creation:self_service');
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-policy-team-creation-retry')).toBeTruthy());
        expect(renderedControlIsChecked(screen.findByTestId('home-policy-team-creation:self_service'))).toBe(true);

        harness.answer(serverId, '/v1/home/policy/set', {
            body: { ...projection.policy, revision: projection.policy.revision + 1, teamCreationPolicy: 'self_service' },
        });
        await screen.pressByTestIdAsync('home-policy-team-creation-retry');
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(2));
        expect(screen.findByTestId('home-policy-team-creation-retry')).toBeNull();
    });
});
