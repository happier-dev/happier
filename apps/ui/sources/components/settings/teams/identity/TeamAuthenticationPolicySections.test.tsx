import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApprovalRequestV2Schema,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    buildApprovalRequestArtifactHeaderV1,
    decodePlainArtifactStoredContent,
    type AuthEntryProjectionV1,
} from '@happier-dev/protocol';

import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import {
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const approvalArtifactBinding = vi.hoisted(() => ({
    artifact: null as Readonly<Record<string, unknown>> | null,
    version: 0,
    listeners: new Set<() => void>(),
    publish(artifact: Readonly<Record<string, unknown>>) {
        this.artifact = artifact;
        this.version += 1;
        for (const listener of this.listeners) listener();
    },
}));

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
    storage: async () => {
        const ReactModule = await import('react');
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useArtifact: (artifactId: string) => {
                ReactModule.useSyncExternalStore(
                    (listener) => {
                        approvalArtifactBinding.listeners.add(listener);
                        return () => approvalArtifactBinding.listeners.delete(listener);
                    },
                    () => approvalArtifactBinding.version,
                );
                return approvalArtifactBinding.artifact?.id === artifactId
                    ? approvalArtifactBinding.artifact
                    : null;
            },
        });
    },
});

// App-bundled plugin bytes are an unrelated generated build boundary. The
// synchronized test target intentionally has no generated inventory, so keep
// that boundary inert while this suite exercises the real Team policy, identity
// projection, refresh and approval owners.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
}));
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: async () => null,
    }),
    createBundledPluginUiAppExactArtifactSourceFromInventory: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: async () => null,
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

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

// Load the real graph after the transport boundaries are installed, during
// collection rather than inside each test's reset deadline.
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { TeamAuthenticationSettingsScreen } = await import('./TeamAuthenticationSettingsScreen');

const TEAM_GET_PATH = '/v1/teams/get';
const TEAM_POLICY_PATH = '/v1/teams/policy/set';
const CONNECTIONS_LIST_PATH = '/v1/teams/identity/connections/list';
const HOME_AUTH_ENTRY_PATH = '/v1/auth/entry';
const ACCOUNT_SETTINGS_V2_PATH = '/v2/account/settings';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';

const HOME_AUTH_ENTRY = Object.freeze({
    v: 1,
    scope: { kind: 'home' },
    state: 'ready',
    autoRedirect: null,
    actions: [{
        kind: 'authenticate', methodId: 'email_password', action: 'login',
        mode: 'either', origin: 'home', presentation: { displayName: 'Email and password' },
    }, {
        kind: 'authenticate', methodId: 'signup_only', action: 'provision',
        mode: 'keyed', origin: 'home', presentation: { displayName: 'Sign-up only' },
    }],
} satisfies AuthEntryProjectionV1);

const CONNECTION = Object.freeze({
    v: 1 as const,
    id: 'connection-okta',
    teamId: 'team-1',
    provider: { id: 'provider-okta', kind: 'oidc' as const, displayName: 'Okta' },
    externalReference: { v: 1 as const, kind: 'oidc' as const },
    settings: {
        v: 1 as const,
        kind: 'oidc' as const,
        allowedUsers: [] as string[],
        allowedEmailDomains: [] as string[],
        groupsAny: [] as string[],
        groupsAll: [] as string[],
    },
    enabled: true,
    firstEnabledAt: 1,
    revision: 1,
    state: 'connected' as const,
    allowedActions: [] as string[],
    lastObservation: null,
    lastSuccessfulTest: null,
    createdAt: 1,
    updatedAt: 1,
});

const AVAILABLE_ADMISSION_MODES = Object.freeze({
    v: 1 as const,
    modes: {
        invite_only: { status: 'available' as const },
        provisioned: { status: 'available' as const },
        jit: { status: 'available' as const },
    },
});

/**
 * Every reason `resolveTeamAdmissionModeApplicabilityInTx` can return, paired so
 * that the two Home-policy reasons appear once on each mode. A UI that keyed its
 * explanation on the mode, or collapsed "the Home has not published this" into
 * "the Home forbids this", cannot satisfy both rounds.
 */
const UNAVAILABLE_ADMISSION_ROUNDS = Object.freeze([
    { provisioned: 'home_policy_unavailable', jit: 'home_policy_prohibited' },
    { provisioned: 'home_policy_prohibited', jit: 'home_policy_unavailable' },
    { provisioned: 'directory_source_required', jit: 'team_connection_required' },
    { provisioned: 'directory_projection_required', jit: 'team_connection_unavailable' },
] as const);

const RESTRICTED_TO_OKTA = Object.freeze({
    v: 1 as const,
    mode: 'restricted' as const,
    accepted: [{ kind: 'team_connection' as const, connectionId: 'connection-okta' }],
});

const RESTRICTED_TO_HOME_PASSKEY = Object.freeze({
    v: 1 as const,
    mode: 'restricted' as const,
    accepted: [{ kind: 'home_method' as const, methodId: 'passkey' }],
});

function artifactBody(id: string) {
    return {
        id,
        header: '',
        body: '',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
    };
}

async function renderAuthentication(serverId: string) {
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    getStorage().setState({ profileScope: { serverId, accountId: 'account-ada' } });
    return renderScreen(<TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />);
}

async function addHomeWithTeam(
    team: ReturnType<typeof teamSummaryFixture>,
    options: Readonly<{ requireUiApproval?: boolean }> = {},
): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, { body: team });
    harness.answer(serverId, HOME_AUTH_ENTRY_PATH, { body: HOME_AUTH_ENTRY });
    harness.answer(serverId, CONNECTIONS_LIST_PATH, {
        body: {
            items: [CONNECTION],
            eligibleProviders: [],
            admissionModeApplicability: AVAILABLE_ADMISSION_MODES,
            memberSignInUrl: null,
        },
    });
    if (options.requireUiApproval) {
        harness.answer(serverId, ACCOUNT_SETTINGS_V2_PATH, {
            body: {
                content: {
                    t: 'plain',
                    v: {
                        actionsSettingsV1: {
                            v: 1,
                            actions: { 'teams.policy.set': { approvalRequiredSurfaces: ['ui'] } },
                        },
                    },
                },
                version: 1,
            },
        });
    }
    return serverId;
}

/**
 * The explanation an admission mode is carrying. Admission is one segmented choice; each mode the
 * Home cannot enforce announces its own reason after its name (`"<mode>, <reason>"`), so one reason
 * can be compared across two modes without reading the row's combined line.
 */
function admissionReason(
    screen: Awaited<ReturnType<typeof renderAuthentication>>,
    mode: string,
): string | undefined {
    const label = screen.findAllByTestId(`team-admission-mode:${mode}`)
        .map((node) => node.props?.accessibilityLabel)
        .find((value): value is string => typeof value === 'string');
    if (label === undefined) return undefined;
    const separator = label.indexOf(', ');
    return separator < 0 ? undefined : label.slice(separator + 2);
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderAuthentication>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    }, { timeout: 10_000 });
}

/**
 * A control is only offerable once the projections it depends on are current.
 * Waiting for the choice to exist would press it while it is still explained as
 * unavailable, which is a different contract than the one under test.
 */
async function waitForPressable(
    screen: Awaited<ReturnType<typeof renderAuthentication>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        const node = screen.findByTestId(testID);
        expect(node).toBeTruthy();
        expect(node?.props.accessibilityState?.disabled ?? node?.props.disabled ?? false).toBe(false);
    }, { timeout: 10_000 });
}

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    approvalArtifactBinding.artifact = null;
    approvalArtifactBinding.version = 0;
    approvalArtifactBinding.listeners.clear();
}, 120_000);

afterEach(() => {
    standardCleanup();
});

describe('TeamAuthenticationPolicySections', () => {
    it('writes admission through the exact Team policy owner', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, {
            body: { ...team, policy: teamPolicyFixture({ admissionMode: 'invite_only' }) },
        });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-admission-mode:provisioned');
        expect(screen.findByTestId('team-admission-mode:jit')?.props.accessibilityState).toMatchObject({ disabled: false });
        await screen.pressByTestIdAsync('team-admission-mode:provisioned');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        const request = harness.requestsFor(TEAM_POLICY_PATH)[0];
        expect(request?.serverId).toBe(serverId);
        expect(request?.input).toMatchObject({ teamId: 'team-1', admissionMode: 'provisioned' });
        // A Team-policy edit never carries an authentication comparison basis it
        // was not asked for; that field belongs to the accepted-sign-in editor.
        expect(request?.input).not.toHaveProperty('previousAuthenticationPolicy');
    });

    it('explains every unavailable admission reason in its own words, dispatches none of them, and still lets the retained mode contract to an available one', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
            policy: teamPolicyFixture({ admissionMode: 'provisioned' }),
        });
        const serverId = await addHomeWithTeam(team);
        const answerApplicability = (round: (typeof UNAVAILABLE_ADMISSION_ROUNDS)[number]) => {
            harness.answer(serverId, CONNECTIONS_LIST_PATH, {
                body: {
                    items: [CONNECTION],
                    eligibleProviders: [],
                    admissionModeApplicability: {
                        v: 1,
                        modes: {
                            invite_only: { status: 'available' },
                            provisioned: { status: 'unavailable', reason: round.provisioned },
                            jit: { status: 'unavailable', reason: round.jit },
                        },
                    },
                    memberSignInUrl: null,
                },
            });
        };
        answerApplicability(UNAVAILABLE_ADMISSION_ROUNDS[0]);

        const screen = await renderAuthentication(serverId);
        const { act } = await import('react-test-renderer');
        const explanationByReason = new Map<string, string>();
        let previousProvisioned: unknown = undefined;

        for (let index = 0; index < UNAVAILABLE_ADMISSION_ROUNDS.length; index += 1) {
            const round = UNAVAILABLE_ADMISSION_ROUNDS[index];
            if (index > 0) {
                answerApplicability(round);
                act(() => publishHomeAccountChange(serverId));
            }
            // Settle on the Home's newest answer without asserting any wording:
            // every round changes both reasons, and edits are only offered once
            // the projection is current again.
            await vi.waitFor(() => {
                const provisioned = admissionReason(screen, 'provisioned');
                expect(typeof provisioned).toBe('string');
                expect(provisioned).not.toBe(previousProvisioned);
                expect(screen.findByTestId('team-admission-mode:invite_only')?.props.accessibilityState)
                    .toMatchObject({ disabled: false });
            }, { timeout: 10_000 });

            const provisionedRow = screen.findByTestId('team-admission-mode:provisioned');
            const jitRow = screen.findByTestId('team-admission-mode:jit');
            previousProvisioned = admissionReason(screen, 'provisioned');

            // The mode the Home currently holds stays visible and selected even
            // though it can no longer be enforced.
            expect(provisionedRow?.props.accessibilityState).toMatchObject({ checked: true, disabled: true });
            expect(jitRow?.props.accessibilityState).toMatchObject({ checked: false, disabled: true });
            // Neither is clickable into a refusal the Home has already predicted (disabled above).

            for (const [reason, rendered] of [
                [round.provisioned, admissionReason(screen, 'provisioned')],
                [round.jit, admissionReason(screen, 'jit')],
            ] as const) {
                expect(rendered).toBeTypeOf('string');
                const explanation = String(rendered);
                expect(explanation.length).toBeGreaterThan(0);
                // The explanation belongs to the reason, not to the row: the
                // second round swaps the two Home-policy reasons between modes.
                if (explanationByReason.has(reason)) {
                    expect(explanation).toBe(explanationByReason.get(reason));
                }
                explanationByReason.set(reason, explanation);
            }
        }

        // Every reason the producer can return says something different. A
        // collapsed branch would leave two reasons sharing one sentence.
        expect(explanationByReason.size).toBe(6);
        expect(new Set(explanationByReason.values()).size).toBe(6);
        // The section footer keeps explaining admission instead of repeating the
        // selected row's own explanation.
        expect(screen.getTextContent()).toContain('teams.authentication.policy.admissionHelp');
        // Nothing was sent while only unavailable modes were offered.
        expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(0);

        // The retained unavailable mode is not a trap: an available alternative
        // is still reachable and settles on the Home's own answer.
        harness.answer(serverId, TEAM_POLICY_PATH, {
            body: { ...team, policy: teamPolicyFixture({ admissionMode: 'invite_only' }) },
        });
        await screen.pressByTestIdAsync('team-admission-mode:invite_only');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(TEAM_POLICY_PATH)[0]?.input)
            .toMatchObject({ teamId: 'team-1', admissionMode: 'invite_only' });
        await vi.waitFor(() => {
            expect(screen.findByTestId('team-admission-mode:invite_only')?.props.accessibilityState)
                .toMatchObject({ checked: true });
        }, { timeout: 10_000 });
        // The busy state settled with the answer rather than latching.
        for (const mode of ['invite_only', 'provisioned', 'jit'] as const) {
            expect(screen.findByTestId(`team-admission-mode:${mode}`)?.props.loading).toBeFalsy();
        }
        expect(screen.findByTestId('team-admission-mode:provisioned')?.props.accessibilityState)
            .toMatchObject({ checked: false, disabled: true });
        expect(admissionReason(screen, 'provisioned')).toBeTypeOf('string');
    });

    it('disables admission edits while the last-known projection is stale', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
        });
        const serverId = await addHomeWithTeam(team);
        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-admission-mode:jit');

        harness.answer(serverId, CONNECTIONS_LIST_PATH, {
            status: 503,
            body: { error: 'identity_provider_unavailable' },
        });
        const { act } = await import('react-test-renderer');
        act(() => publishHomeAccountChange(serverId));
        await waitForTestId(screen, 'team-authentication-stale');
        expect(screen.findByTestId('team-admission-mode:invite_only')?.props.accessibilityState)
            .toMatchObject({ disabled: true, checked: true });
        expect(screen.findByTestId('team-admission-mode:jit')?.props.accessibilityState)
            .toMatchObject({ disabled: true, checked: false });
        expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(0);
    });

    it('reports the Home refusal for an admission mode it cannot enforce and keeps the stored mode selected', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
        });
        const serverId = await addHomeWithTeam(team);
        // Applicability can change between the list read and this write, so the
        // Home still owns the final validation and may refuse the stale intent.
        harness.answer(serverId, TEAM_POLICY_PATH, {
            status: 409,
            body: { error: 'team_authentication_policy_unavailable' },
        });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-admission-mode:jit');
        await screen.pressByTestIdAsync('team-admission-mode:jit');

        await waitForTestId(screen, 'team-admission-notice');
        expect(screen.getTextContent()).toContain('teams.authentication.policy.admissionUnavailable');
        // Nothing claims a change the Home did not make.
        expect(screen.findByTestId('team-admission-mode:invite_only')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        expect(screen.findByTestId('team-admission-mode:jit')?.props.accessibilityState)
            .toMatchObject({ checked: false });
    });

    it('sends the observed canonical policy as the compare-and-set basis', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
            policy: teamPolicyFixture({ authenticationPolicy: null, authenticationPolicyStatus: 'available' }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, {
            body: { ...team, policy: teamPolicyFixture({ authenticationPolicy: RESTRICTED_TO_OKTA }) },
        });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-authentication-policy-mode:restricted');
        await screen.pressByTestIdAsync('team-authentication-policy-mode:restricted');
        await waitForTestId(screen, 'team-authentication-policy-save');
        await screen.pressByTestIdAsync('team-authentication-policy-save');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(TEAM_POLICY_PATH)[0]?.input).toMatchObject({
            teamId: 'team-1',
            previousAuthenticationPolicy: null,
            authenticationPolicy: {
                v: 1,
                mode: 'restricted',
                accepted: [{ kind: 'team_connection', connectionId: 'connection-okta' }],
            },
        });
    });

    it('explains when the Home requires the selected provider connection to be tested', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
            policy: teamPolicyFixture({ authenticationPolicy: null, authenticationPolicyStatus: 'available' }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, {
            status: 409,
            body: {
                error: 'team_authentication_policy_unavailable',
                details: { reason: 'provider_test_required' },
            },
        });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-authentication-policy-mode:restricted');
        await screen.pressByTestIdAsync('team-authentication-policy-mode:restricted');
        await screen.pressByTestIdAsync('team-authentication-policy-save');

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('teams.authentication.policy.providerTestRequired');
        });
        expect(screen.getTextContent()).not.toContain('teams.authentication.policy.unavailable');
    });

    it('uses the repair basis for an unreadable stored policy rather than claiming inheritance', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
            policy: teamPolicyFixture({
                authenticationPolicy: null,
                authenticationPolicyStatus: 'repair_required',
            }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, {
            body: { ...team, policy: teamPolicyFixture({ authenticationPolicy: null }) },
        });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-authentication-policy-mode:inherit');
        await waitForTestId(screen, 'team-authentication-policy-repair');
        // Nothing is presented as the current policy while it cannot be read.
        expect(screen.findByTestId('team-authentication-policy-mode:inherit')?.props.accessibilityState)
            .toMatchObject({ checked: false });
        expect(screen.findByTestId('team-authentication-policy-mode:restricted')?.props.accessibilityState)
            .toMatchObject({ checked: false });

        await screen.pressByTestIdAsync('team-authentication-policy-mode:inherit');
        await waitForTestId(screen, 'team-authentication-policy-save');
        await screen.pressByTestIdAsync('team-authentication-policy-save');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(TEAM_POLICY_PATH)[0]?.input).toMatchObject({
            previousAuthenticationPolicy: { v: 1, status: 'repair_required' },
            authenticationPolicy: { v: 1, mode: 'inherit' },
        });
    });

    it('keeps the administrator intent after a stale-basis refusal and retries against the refreshed policy', async () => {
        let releaseConflict = (): void => {};
        const conflictResponse = new Promise<void>((resolve) => { releaseConflict = resolve; });
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, {
            status: 409,
            body: { error: 'team_authentication_policy_conflict' },
            respondAfter: conflictResponse,
        });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-authentication-policy-mode:restricted');
        await screen.pressByTestIdAsync('team-authentication-policy-mode:restricted');
        await screen.pressByTestIdAsync('team-authentication-policy-save');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        // Somebody else narrows the Team while this edit is in flight. Publish
        // that read answer before releasing the stale-basis refusal, so the
        // refresh cannot race the fixture update.
        harness.answer(serverId, TEAM_GET_PATH, {
            body: { ...team, policy: teamPolicyFixture({ authenticationPolicy: RESTRICTED_TO_HOME_PASSKEY }) },
        });
        const { act } = await import('react-test-renderer');
        await act(async () => releaseConflict());
        await waitForTestId(screen, 'team-authentication-policy-rebase');
        // The intent survives: the editor still holds the administrator's choice.
        expect(screen.findByTestId('team-authentication-policy-mode:restricted')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        expect(screen.findByTestId('team-authentication-policy-save')?.props.accessibilityState)
            .toMatchObject({ disabled: true });

        harness.answer(serverId, TEAM_POLICY_PATH, {
            body: { ...team, policy: teamPolicyFixture({ authenticationPolicy: RESTRICTED_TO_OKTA }) },
        });
        await screen.pressByTestIdAsync('team-authentication-policy-rebase:continue');
        await screen.pressByTestIdAsync('team-authentication-policy-save');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(2));
        // The retry carries the newly observed canonical value, not the stale one.
        expect(harness.requestsFor(TEAM_POLICY_PATH)[1]?.input).toMatchObject({
            previousAuthenticationPolicy: RESTRICTED_TO_HOME_PASSKEY,
        });
    });

    it('clears the pending approval notice when the shared approval settles terminally', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
        });
        const serverId = await addHomeWithTeam(team, { requireUiApproval: true });
        harness.answer(serverId, ARTIFACT_CREATE_PATH, { body: artifactBody('artifact-team-policy') });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-admission-mode:provisioned');
        await screen.pressByTestIdAsync('team-admission-mode:provisioned');

        await waitForTestId(screen, 'team-admission-approval-pending');
        expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(0);

        // The person rejected it in the Inbox. Nothing can execute this mutation
        // now, so the section must stop saying it is waiting.
        const approvalArtifactId = (harness.requestsFor(ARTIFACT_CREATE_PATH)[0]?.input as { id?: unknown } | undefined)?.id;
        expect(typeof approvalArtifactId).toBe('string');
        const artifactCreateInput = harness.requestsFor(ARTIFACT_CREATE_PATH)[0]?.input;
        if (!artifactCreateInput || typeof artifactCreateInput !== 'object' || Array.isArray(artifactCreateInput)) {
            throw new Error('Expected the approval Artifact create input');
        }
        const storedBody = Reflect.get(artifactCreateInput, 'body');
        const decodedBody = typeof storedBody === 'string'
            ? decodePlainArtifactStoredContent(storedBody)
            : null;
        if (!decodedBody || typeof decodedBody !== 'object' || Array.isArray(decodedBody)) {
            throw new Error('Expected the Plain approval Artifact body envelope');
        }
        const plaintextBody = Reflect.get(decodedBody, 'body');
        const openRequest = ApprovalRequestV2Schema.parse(
            typeof plaintextBody === 'string' ? JSON.parse(plaintextBody) : null,
        );
        const rejectedRequest = ApprovalRequestV2Schema.parse({
            ...openRequest,
            status: 'rejected',
            updatedAtMs: openRequest.updatedAtMs + 1,
            decision: { kind: 'reject', decidedAtMs: openRequest.updatedAtMs + 1 },
        });
        const { act } = await import('react-test-renderer');
        act(() => {
            approvalArtifactBinding.publish({
                id: approvalArtifactId,
                header: buildApprovalRequestArtifactHeaderV1(rejectedRequest),
                body: JSON.stringify(rejectedRequest),
                seq: 2,
                createdAt: 1,
                updatedAt: 2,
                isDecrypted: true,
            });
        });

        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON()))
                .not.toContain('team-admission-approval-pending');
        });
    });

    it('abandons an edited draft without telling the Home anything', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
        });
        const serverId = await addHomeWithTeam(team);

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-authentication-policy-mode:restricted');
        await screen.pressByTestIdAsync('team-authentication-policy-mode:restricted');
        await waitForTestId(screen, 'team-authentication-policy-cancel');
        await screen.pressByTestIdAsync('team-authentication-policy-cancel');

        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON()))
                .not.toContain('team-authentication-policy-cancel');
        });
        // The Home's own answer is the whole truth again, and it was never asked
        // to change anything.
        expect(screen.findByTestId('team-authentication-policy-mode:inherit')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(0);
    });

    it('authors the Home-method arm of the accepted-authentication OR, not only Team connections', async () => {
        // `TeamAuthenticationPolicyV1` is an OR over `home_method` and
        // `team_connection`. The Home methods come from the same capability
        // projection the Home already publishes on its own sign-in page, so a
        // Team administrator can compose "accept this SSO **or** the Home's own
        // sign-in" without a second Home-method owner or any new disclosure.
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
            policy: teamPolicyFixture({ authenticationPolicy: null, authenticationPolicyStatus: 'available' }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, { body: team });
        // The current contextual Home entry catalog above offers this method;
        // an independently acquired features snapshot does not. The mounted
        // picker must ask the current entry owner, not use a separate catalog.
        const features = createRootLayoutFeaturesResponse({
            capabilities: {
                auth: {
                    methods: [],
                },
            },
        });
        if (!tryWriteServerEnabledBitInPlace(features, 'teams', true)) {
            throw new Error('The teams feature bit could not be written by its own writer');
        }
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });

        // Focus another Home before opening this exact Team. A picker using
        // ambient sign-in discovery would ask the wrong Home.
        const otherServerId = await harness.addHome({
            name: 'Home B', serverUrl: 'https://home-b.example', accountId: 'account-bea', teamsEnabled: true,
        });
        await harness.selectHomes([serverId, otherServerId]);
        harness.answer(otherServerId, HOME_AUTH_ENTRY_PATH, {
            body: { ...HOME_AUTH_ENTRY, actions: [] },
        });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-authentication-policy-mode:restricted');
        await screen.pressByTestIdAsync('team-authentication-policy-mode:restricted');
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())
                .some((id) => id.startsWith('team-authentication-policy-home-method:'))).toBe(true);
        }, { timeout: 10_000 });
        expect(harness.requestsFor(HOME_AUTH_ENTRY_PATH)).toEqual([
            expect.objectContaining({
                serverId,
                input: { v: 1, scope: { kind: 'home' } },
                token: expect.any(String),
            }),
        ]);

        const homeMethodTestId = 'team-authentication-policy-home-method:email_password';
        const methodId = 'email_password';
        // A method the Home offers only for provisioning can never admit anybody,
        // so it is not offered as an accepted reference.
        expect(collectRenderedTestIds(screen.tree.toJSON()))
            .not.toContain('team-authentication-policy-home-method:signup_only');
        // `findByTestId` prefers the host node that painted, which never holds
        // `Item`'s own semantics, so the composite is selected explicitly.
        const row = screen.findAllByTestId(homeMethodTestId)
            .find((node) => typeof node.props?.accessibilityRole === 'string');
        // It is a real choice, not the read-only informational row the Team
        // surface used to render for a method it could not author.
        expect(row?.props.accessibilityRole).toBe('checkbox');
        expect(row?.props.accessibilityChecked).toBe(false);

        await screen.pressByTestIdAsync(homeMethodTestId);
        await waitForTestId(screen, 'team-authentication-policy-save');
        await screen.pressByTestIdAsync('team-authentication-policy-save');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        const written = harness.requestsFor(TEAM_POLICY_PATH)[0]?.input as {
            authenticationPolicy?: { accepted?: readonly Record<string, unknown>[] };
        };
        expect(written.authenticationPolicy?.accepted)
            .toContainEqual({ kind: 'home_method', methodId });
        // The Team's own connection stays in the same OR; adding the Home method
        // must not replace it.
        expect(written.authenticationPolicy?.accepted)
            .toContainEqual({ kind: 'team_connection', connectionId: 'connection-okta' });
    });

    it('retains a stale Home method disabled until its current entry projection recovers', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
            policy: teamPolicyFixture({ authenticationPolicy: RESTRICTED_TO_OKTA }),
        });
        const serverId = await addHomeWithTeam(team);
        const screen = await renderAuthentication(serverId);
        const methodTestId = 'team-authentication-policy-home-method:email_password';
        await waitForPressable(screen, methodTestId);

        harness.answer(serverId, HOME_AUTH_ENTRY_PATH, { status: 503 });
        publishHomeAccountChange(serverId);
        await waitForTestId(screen, 'team-authentication-home-methods-unavailable');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(methodTestId);
        expect(screen.findByTestId(methodTestId)?.props.onPress).toBeUndefined();

        harness.answer(serverId, HOME_AUTH_ENTRY_PATH, { body: HOME_AUTH_ENTRY });
        await screen.pressByTestIdAsync('team-authentication-home-methods-retry');
        await waitForPressable(screen, methodTestId);
        expect(collectRenderedTestIds(screen.tree.toJSON()))
            .not.toContain('team-authentication-home-methods-unavailable');
        expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(0);
    });

    it('lets an administrator remove a retained method the Home no longer offers', async () => {
        // A stored restricted policy may name a Home method the Home has since
        // stopped offering. The server refuses any restricted policy holding an
        // unavailable choice, so if the retained row is inert the administrator
        // can open the editor, change nothing that matters, and never save
        // again — the only escape being to abandon the policy for inheritance.
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
            policy: teamPolicyFixture({
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [
                        { kind: 'home_method', methodId: 'email_password' },
                        { kind: 'home_method', methodId: 'legacy_sso' },
                    ],
                },
                authenticationPolicyStatus: 'available',
            }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, { body: team });
        // Only auth entry still offers `email_password`; `legacy_sso` is gone.
        const features = createRootLayoutFeaturesResponse({
            capabilities: {
                auth: {
                    methods: [],
                },
            },
        });
        if (!tryWriteServerEnabledBitInPlace(features, 'teams', true)) {
            throw new Error('The teams feature bit could not be written by its own writer');
        }
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });

        const screen = await renderAuthentication(serverId);
        const retainedTestId = 'team-authentication-policy-home-method:legacy_sso';
        await waitForPressable(screen, retainedTestId);

        const retainedRow = screen.findAllByTestId(retainedTestId)
            .find((node) => typeof node.props?.accessibilityRole === 'string');
        expect(retainedRow?.props.accessibilityRole).toBe('checkbox');
        expect(retainedRow?.props.accessibilityChecked).toBe(true);

        await screen.pressByTestIdAsync(retainedTestId);
        await waitForTestId(screen, 'team-authentication-policy-save');
        await screen.pressByTestIdAsync('team-authentication-policy-save');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        const written = harness.requestsFor(TEAM_POLICY_PATH)[0]?.input as {
            authenticationPolicy?: { mode?: string; accepted?: readonly Record<string, unknown>[] };
        };
        // Still a restricted policy over the method that remains: removing an
        // unavailable choice is not a reset to Home inheritance.
        expect(written.authenticationPolicy?.mode).toBe('restricted');
        expect(written.authenticationPolicy?.accepted)
            .toEqual([{ kind: 'home_method', methodId: 'email_password' }]);
        // The Home does not offer it, so it cannot be selected again.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(retainedTestId);
    });

    it('names the exact connection when two share a provider display name', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
        });
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { body: team });
        harness.answer(serverId, CONNECTIONS_LIST_PATH, {
            body: {
                items: [
                    {
                        ...CONNECTION,
                        id: 'connection-acme',
                        provider: { id: 'provider-workos', kind: 'workos_sso', displayName: 'WorkOS' },
                        externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org-acme', connectionId: null },
                        settings: { v: 1, kind: 'workos_sso' },
                    },
                    {
                        ...CONNECTION,
                        id: 'connection-globex',
                        provider: { id: 'provider-workos', kind: 'workos_sso', displayName: 'WorkOS' },
                        externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org-globex', connectionId: null },
                        settings: { v: 1, kind: 'workos_sso' },
                    },
                ],
                eligibleProviders: [],
                admissionModeApplicability: AVAILABLE_ADMISSION_MODES,
                memberSignInUrl: null,
            },
        });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-authentication-policy-mode:restricted');
        await screen.pressByTestIdAsync('team-authentication-policy-mode:restricted');
        await waitForTestId(screen, 'team-authentication-policy-connection:connection-acme');

        // Two identically named connections must never be an ambiguous choice.
        const acme = screen.findByTestId('team-authentication-policy-connection:connection-acme');
        const globex = screen.findByTestId('team-authentication-policy-connection:connection-globex');
        const acmeRendered = `${acme?.props.subtitle ?? ''} ${acme?.props.accessibilityLabel ?? ''}`;
        const globexRendered = `${globex?.props.subtitle ?? ''} ${globex?.props.accessibilityLabel ?? ''}`;
        expect(acmeRendered).toContain('org-acme');
        expect(globexRendered).toContain('org-globex');
        expect(acmeRendered).not.toBe(globexRendered);
        expect(acme?.props.accessibilityLabel ?? acmeRendered).toContain('org-acme');
    });

    it('starts only one policy write when the same choice is pressed twice before React renders', async () => {
        let release = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { release = resolve; });
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, { body: team, respondAfter });

        const screen = await renderAuthentication(serverId);
        await waitForPressable(screen, 'team-admission-mode:provisioned');
        const { act } = await import('react-test-renderer');
        act(() => {
            screen.pressByTestId('team-admission-mode:provisioned');
            screen.pressByTestId('team-admission-mode:provisioned');
        });

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        await act(async () => release());
    });
});
