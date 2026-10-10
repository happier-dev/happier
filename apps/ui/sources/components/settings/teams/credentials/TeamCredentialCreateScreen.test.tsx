import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProviderConnectionIdSchema, ProviderConnectionSecurityFingerprintV1Schema } from '@happier-dev/protocol';

import {
    collectRenderedTestIds,
    createMachineAdministrationTargetSelectionMock,
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    installMachineAdministrationTargetSelectionBoundary,
    installProviderSettingsRpcBoundary,
    renderScreen,
    standardCleanup,
    teamCapabilitiesFixture,
    teamCredentialResourceFixture,
    teamCredentialSourceCandidateFixture,
    teamCredentialViewerFixture,
    teamSummaryFixture,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplace = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const confirmPolicyInvalidation = vi.hoisted(() => vi.fn(async () => true));
/**
 * Every modal this screen opens, captured as the screen configured it.
 *
 * The picker is a portaled `SelectionList`, so driving it through its own
 * `onSelect` is what actually exercises the wiring the person uses: the row id
 * the screen published, resolved back to the candidate whose pinned binding is
 * sent to the Home.
 */
const shownModals = vi.hoisted(() => [] as { chrome?: { testID?: string }; props?: Record<string, unknown> }[]);
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const administrationTarget = createMachineAdministrationTargetSelectionMock();
installMachineAdministrationTargetSelectionBoundary(administrationTarget);

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: routerBack, replace: routerReplace }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                confirm: confirmPolicyInvalidation,
                show: (config) => {
                    shownModals.push(config as (typeof shownModals)[number]);
                    return 'modal-id';
                },
            },
        }).module;
    },
    storage: 'real',
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const LIST_PATH = '/v1/teams/credential-resources/list';
const SOURCES_PATH = '/v1/teams/credential-resources/sources/list';
const REQUEST_POLICY_SUPPORT_PATH = '/v1/teams/credential-resources/request-policy-support/get';
const CREATE_PATH = '/v1/teams/credential-resources/create';

async function addHome(options?: Readonly<{ machinePoolsEnabled?: boolean }>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
        credentialResourcesEnabled: true,
        ...(options?.machinePoolsEnabled === true ? { machinePoolsEnabled: true } : {}),
    });
    administrationTarget.controller.setMachines([
        { machineId: 'machine-a', displayName: 'Provider host', serverId },
        { machineId: 'machine-broker', displayName: 'Office Mac', serverId },
    ]);
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
    });
    harness.answer(serverId, CREATE_PATH, {
        body: teamCredentialResourceFixture({ id: 'resource-created' }),
    });
    return serverId;
}

function answerViewer(serverId: string, offerOwnCredential: boolean): void {
    harness.answer(serverId, LIST_PATH, {
        body: {
            resources: [],
            viewer: teamCredentialViewerFixture({ offerOwnCredential, manageCredentials: offerOwnCredential }),
        },
    });
}

function answerSourceOnlyViewer(serverId: string): void {
    harness.answer(serverId, LIST_PATH, {
        body: {
            resources: [],
            viewer: teamCredentialViewerFixture({ offerOwnCredential: true, manageCredentials: false }),
        },
    });
}

function providerOffer(connectionId: string, label: string, fingerprint = `connection-security:v1:${connectionId}`) {
    return {
        connectionId: ProviderConnectionIdSchema.parse(connectionId),
        connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse(fingerprint),
        credentialSlotId: 'apiKey',
        label,
    } as const;
}

function answerProviderConnections(...offers: readonly ReturnType<typeof providerOffer>[]): void {
    providerHarness.setResponse(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, createProviderConnectionsDescribeFixture({
        connections: offers.map((offer) => createProviderConnectionViewFixture({
            connectionId: offer.connectionId,
            teamCredentialSourceOffer: offer,
        })),
    }));
}

function emptyBrokerPresentation() {
    return { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] } as const;
}

function answerRequestPolicySupport(serverId: string, modelId: string): void {
    harness.answer(serverId, REQUEST_POLICY_SUPPORT_PATH, {
        body: {
            status: 'available',
            models: [{
                descriptor: { id: modelId, name: modelId },
                application: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'happier.provider.test', localId: 'test' },
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                },
                sourceRevision: `source-revision:${modelId}`,
                allowedProtocolKinds: ['openai_responses'],
                reasoningEffort: { allowedValues: ['low', 'high'], defaultValue: 'low' },
            }],
        },
    });
}

async function renderCreate(
    serverId: string,
    sourceHint?: Readonly<
        | { kind: 'connected_account'; pluginId: string; localId: string; accountId: string }
        | { kind: 'connected_pool'; pluginId: string; localId: string; groupId: string }
        | { kind: 'provider_connection'; machineId: string; connectionId: string; credentialSlotId: string; connectionSecurityFingerprint: string }
    >,
) {
    const { TeamCredentialCreateScreen } = await import('./TeamCredentialCreateScreen');
    return renderScreen(<TeamCredentialCreateScreen serverId={serverId} teamId="team-1" sourceHint={sourceHint} />);
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderCreate>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

function selectBrokerMachine(screen: Awaited<ReturnType<typeof renderCreate>>, machineId: string): void {
    const selector = screen.findByType('MachineAdministrationTargetSelector');
    const selection = selector.props.selection as {
        pickerRows: readonly { candidate: { target: { serverIdentityId: string; machineId: string } } }[];
        selectTarget: (target: { serverIdentityId: string; machineId: string }) => void;
    };
    const target = selection.pickerRows.find((row) => row.candidate.target.machineId === machineId)?.candidate.target;
    if (!target) throw new Error(`broker_machine_not_rendered:${machineId}`);
    act(() => selection.selectTarget(target));
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerReplace.mockReset();
    routerBack.mockReset();
    confirmPolicyInvalidation.mockClear();
    shownModals.length = 0;
    providerHarness.reset();
    administrationTarget.controller.reset();
});

afterEach(standardCleanup);

describe('TeamCredentialCreateScreen', () => {
    it('offers Machine Pools as accessible radio choices with the Home\u2019s availability, and lets a Pool be cleared', async () => {
        const serverId = await addHome({ machinePoolsEnabled: true });
        answerViewer(serverId, true);
        const poolId = '00000000-0000-4000-8000-000000000001';
        const candidate = teamCredentialSourceCandidateFixture();
        harness.answer(serverId, SOURCES_PATH, {
            body: {
                candidates: [candidate],
                supportedKinds: ['connected_account'],
                brokerPresentation: {
                    selectedTarget: null,
                    eligibleTargets: [{ machineId: 'machine-broker', displayName: 'Office Mac', availability: 'available' }],
                    selectedPool: null,
                    eligiblePools: [{ poolId, displayName: 'Development', availability: 'unavailable', availableMachineCount: 0 }],
                },
            },
        });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({
            profileScope: { serverId, accountId: 'account-ada' },
            settingsScope: { serverId, accountId: 'account-ada' },
            machineListByServerId: { [serverId]: [] },
            machineListStatusByServerId: { [serverId]: 'idle' },
            machinePoolListByServerId: { [serverId]: [{
                pool: {
                    id: poolId, name: 'Development', description: null, revision: 1, createdAt: 1, updatedAt: 1,
                    members: [{ machineId: 'machine-broker', priorityTier: 0, enabled: true, state: 'connected' }],
                },
                availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
            }] },
            machinePoolListStatusByServerId: { [serverId]: 'idle' },
            machinePoolAccountIdByServerId: { [serverId]: 'account-ada' },
        });

        const screen = await renderCreate(serverId);
        const rowTestId = `team-credential-create-broker:machine_pool:${poolId}`;
        await waitForTestId(screen, rowTestId);
        // The declared row carries the projection; the painted host only carries its text.
        const declared = (testID: string) => screen.findAllByTestId(testID)[0];
        const row = declared(rowTestId);
        expect(row?.props.accessibilityRole).toBe('radio');
        expect(row?.props.detail).toBe('machinePools.brokerUnavailable');
        expect(row?.props.selected).toBe(false);
        const group = screen.findAllByProps({ accessibilityRole: 'radiogroup' })
            .find((node) => node.props.accessibilityLabel === 'machinePools.myTitle');
        expect(group).toBeTruthy();

        await screen.pressByTestIdAsync(rowTestId);
        expect(declared(rowTestId)?.props.selected).toBe(true);
        expect(declared('team-credential-create-review-broker')?.props.detail).toBe('Development');

        // A Pool placement is not a one-way door: it clears back to no placement.
        await screen.pressByTestIdAsync('team-credential-create-broker:clear');
        expect(declared(rowTestId)?.props.selected).toBe(false);
        expect(declared('team-credential-create-review-broker')?.props.detail).toBe('teams.credentials.detail.brokerNone');
    });

    it('settles a failed first credential read instead of spinning forever', async () => {
        const serverId = await addHome();
        harness.answer(serverId, LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['connected_account'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId);

        // The viewer projection is null for both "loading" and "failed", and the
        // source/provider retries live behind the loading return, so a first
        // failure used to render as permanent loading with no way out.
        await waitForTestId(screen, 'team-credential-create-retry');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credential-create-loading');

        answerViewer(serverId, true);
        await screen.pressByTestIdAsync('team-credential-create-retry');

        await waitForTestId(screen, 'team-credential-create-source');
    });

    it('lets a source-only member offer a bare resource without manager controls', async () => {
        const serverId = await addHome();
        answerSourceOnlyViewer(serverId);
        const candidate = teamCredentialSourceCandidateFixture({
            source: {
                v: 1,
                kind: 'connected_account',
                target: {
                    kind: 'account',
                    account: {
                        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                        accountId: 'work',
                    },
                },
                credentialIncarnation: 'credential-life-1',
            },
            candidateId: 'candidate-account-1',
            label: 'Work account',
            memberCount: null,
        });
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [candidate], supportedKinds: ['connected_account'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => {
            const item = screen.findByTestId('team-credential-create-source');
            expect(item?.props.disabled, String(item?.props.accessibilityLabel)).not.toBe(true);
        });
        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-source-picker:modal');
        const step = picker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        await act(async () => {
            (picker?.props?.onSelect as (id: string) => void)(step.sections[0]!.options[0]!.id);
        });

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-credential-create-name');
        expect(ids).not.toContain('team-credential-create-audience-everyone');
        expect(ids).not.toContain('team-credential-create-broker:none');
        expect(ids).not.toContain('team-credential-create-use-policy:personal_allowed');
        expect(ids).not.toContain('team-credential-create-policy-protocol:openai_responses');
        expect(ids).not.toContain('team-credential-create-limit-maximum');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-submit')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-create-submit');

        await vi.waitFor(() => expect(harness.requestsFor(CREATE_PATH)).toHaveLength(1));
        const sent = harness.requestsFor(CREATE_PATH)[0]!.input as Record<string, unknown>;
        expect(sent).toMatchObject({
            source: candidate.source,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            brokerPlacement: null,
            requestPolicy: null,
            allMembersDeliveryMode: null,
            groupGrants: [],
            memberGrants: [],
            usageLimits: [],
        });
    });

    it('discovers Provider offers without a route hint and authors policy from the selected source catalog', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        const offer = providerOffer('pc_work', 'Work Provider');
        answerProviderConnections(offer);
        harness.answer(serverId, SOURCES_PATH, { body: {
            candidates: [],
            supportedKinds: ['provider_connection'],
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [{ machineId: 'machine-broker', displayName: 'Office Mac', availability: 'available' }],
                selectedPool: null,
                eligiblePools: [],
            },
        } });
        harness.answer(serverId, REQUEST_POLICY_SUPPORT_PATH, { body: {
            status: 'available',
            models: [{
                descriptor: { id: 'model-work', name: 'Work Model', description: 'Canonical model' },
                application: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'happier.provider.test', localId: 'test' },
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                },
                sourceRevision: 'provider-source-revision-1',
                allowedProtocolKinds: ['openai_responses'],
                reasoningEffort: { allowedValues: ['low', 'high'], defaultValue: 'low' },
            }],
        } });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-source')?.props.disabled).not.toBe(true));
        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-source-picker:modal');
        const step = picker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        await act(async () => {
            (picker?.props?.onSelect as (id: string) => void)(step.sections[0]!.options[0]!.id);
        });
        await waitForTestId(screen, 'team-credential-create-policy-model:model-work');

        await screen.pressByTestIdAsync('team-credential-create-policy-model:model-work');
        expect(screen.findByTestId('team-credential-create-policy-protocol:openai_responses')).not.toBeNull();
        expect(screen.findByTestId('team-credential-create-policy-protocol:anthropic_messages')).toBeNull();
        expect(screen.findByTestId('team-credential-create-policy-max-output')).toBeNull();
        selectBrokerMachine(screen, 'machine-broker');
        await screen.pressByTestIdAsync('team-credential-create-audience-everyone');
        await screen.pressByTestIdAsync('team-credential-audience-mode:everyone:brokered');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-submit')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-create-submit');

        await vi.waitFor(() => expect(harness.requestsFor(CREATE_PATH)).toHaveLength(1));
        const sent = harness.requestsFor(CREATE_PATH)[0]!.input as {
            source: unknown;
            requestPolicy: { allowedModelIds: unknown };
        };
        expect(sent.source).toMatchObject({ kind: 'provider_connection', connectionId: 'pc_work' });
        expect(sent.requestPolicy.allowedModelIds).toEqual(['model-work']);
        expect(harness.requestsFor(REQUEST_POLICY_SUPPORT_PATH).at(-1)?.input).toEqual({
            scope: 'source_draft',
            teamId: 'team-1',
            source: sent.source,
            brokerPlacement: { kind: 'machine', machineId: 'machine-broker' },
        });
    });

    it('reloads models from the selected Provider offer and refuses a rotated offer at submit', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        const work = providerOffer('pc_work', 'Work Provider');
        const personal = providerOffer('pc_personal', 'Personal Provider');
        answerProviderConnections(work, personal);
        harness.answer(serverId, SOURCES_PATH, { body: {
            candidates: [], supportedKinds: ['provider_connection'],
            brokerPresentation: { selectedTarget: null, eligibleTargets: [{ machineId: 'machine-broker', displayName: null, availability: 'available' }], selectedPool: null, eligiblePools: [] },
        } });
        answerRequestPolicySupport(serverId, 'model-work');

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-source')?.props.disabled).not.toBe(true));
        await screen.pressByTestIdAsync('team-credential-create-source');
        let picker = shownModals.at(-1);
        let step = picker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        await act(async () => { (picker?.props?.onSelect as (id: string) => void)(step.sections[0]!.options[0]!.id); });
        await waitForTestId(screen, 'team-credential-create-policy-model:model-work');
        await screen.pressByTestIdAsync('team-credential-create-policy-model:model-work');

        await screen.pressByTestIdAsync('team-credential-create-source');
        picker = shownModals.at(-1);
        step = picker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        answerRequestPolicySupport(serverId, 'model-personal');
        await act(async () => { (picker?.props?.onSelect as (id: string) => void)(step.sections[0]!.options[1]!.id); });
        await waitForTestId(screen, 'team-credential-create-policy-model:model-personal');
        await vi.waitFor(() => expect(confirmPolicyInvalidation).toHaveBeenCalledWith(
            'teams.credentials.requestPolicy.title',
            expect.stringContaining('model-work'),
            expect.objectContaining({ destructive: true }),
        ));
        expect(JSON.stringify(screen.tree.toJSON())).toContain('teams.credentials.requestPolicy.modelsAny');

        selectBrokerMachine(screen, 'machine-broker');
        await screen.pressByTestIdAsync('team-credential-create-audience-everyone');
        await screen.pressByTestIdAsync('team-credential-audience-mode:everyone:brokered');
        answerProviderConnections(work, providerOffer('pc_personal', 'Personal Provider', 'connection-security:v1:rotated'));
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-submit')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-create-submit');

        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-submit')?.props.loading).not.toBe(true));
        expect(harness.requestsFor(CREATE_PATH)).toHaveLength(0);
        expect(JSON.stringify(screen.tree.toJSON()))
            .toContain('teams.credentials.directReadiness.state.sourceChanged');
    });

    it('requires fresh consent when source selection changes an accepted direct-delivery consequence', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        const first = teamCredentialSourceCandidateFixture({
            candidateId: 'candidate-pool-1',
            label: 'Primary source',
            directExportSupport: 'supported',
        });
        const second = teamCredentialSourceCandidateFixture({
            candidateId: 'candidate-pool-2',
            label: 'Secondary source',
            directExportSupport: 'supported',
            source: {
                v: 1,
                kind: 'connected_pool',
                target: {
                    kind: 'group',
                    service: { pluginId: 'happier.connected-account.test', localId: 'subscription' },
                    groupId: 'secondary',
                },
                poolIncarnation: 'pool-life-2',
            },
        });
        harness.answer(serverId, SOURCES_PATH, {
            body: {
                candidates: [first, second],
                supportedKinds: ['connected_pool'],
                brokerPresentation: emptyBrokerPresentation(),
            },
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await screen.pressByTestIdAsync('team-credential-create-source');
        let picker = shownModals.at(-1);
        let step = picker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        await act(async () => {
            await (picker?.props?.onSelect as (id: string) => Promise<void>)(step.sections[0]!.options[0]!.id);
        });
        await screen.pressByTestIdAsync('team-credential-create-ceiling:direct_allowed');
        await screen.pressByTestIdAsync('team-credential-create-audience-everyone');
        await screen.pressByTestIdAsync('team-credential-audience-mode:everyone:direct');
        confirmPolicyInvalidation.mockClear();

        await screen.pressByTestIdAsync('team-credential-create-source');
        picker = shownModals.at(-1);
        step = picker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        await act(async () => {
            await (picker?.props?.onSelect as (id: string) => Promise<void>)(step.sections[0]!.options[1]!.id);
        });

        expect(confirmPolicyInvalidation).toHaveBeenCalledWith(
            'teams.credentials.audience.directTitle',
            'teams.credentials.audience.directBody',
            expect.objectContaining({ destructive: true }),
        );
    });

    // Child 01 §7.1 rule 5: narrowing withdraws only direct disclosure. The
    // create draft and the edit draft share that one rule with the Home PATCH.
    it('narrows a drafted direct-only grant to no access and a both grant to its broker half', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        harness.answer(serverId, SOURCES_PATH, {
            body: {
                candidates: [teamCredentialSourceCandidateFixture({ directExportSupport: 'supported' })],
                supportedKinds: ['connected_pool'],
                brokerPresentation: emptyBrokerPresentation(),
            },
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.at(-1);
        const step = picker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        await act(async () => {
            await (picker?.props?.onSelect as (id: string) => Promise<void>)(step.sections[0]!.options[0]!.id);
        });
        const everyoneDetail = () => screen.findAllByTestId('team-credential-create-audience-everyone')[0]?.props.detail;

        await screen.pressByTestIdAsync('team-credential-create-ceiling:direct_allowed');
        await screen.pressByTestIdAsync('team-credential-create-audience-everyone');
        await screen.pressByTestIdAsync('team-credential-audience-mode:everyone:direct');
        expect(everyoneDetail()).toBe('teams.credentials.delivery.direct');
        await screen.pressByTestIdAsync('team-credential-create-ceiling:brokered_only');
        expect(everyoneDetail()).toBe('teams.credentials.audience.everyoneOff');

        await screen.pressByTestIdAsync('team-credential-create-ceiling:direct_allowed');
        await screen.pressByTestIdAsync('team-credential-create-audience-everyone');
        await screen.pressByTestIdAsync('team-credential-audience-mode:everyone:both');
        expect(everyoneDetail()).toBe('teams.credentials.delivery.both');
        await screen.pressByTestIdAsync('team-credential-create-ceiling:brokered_only');
        expect(everyoneDetail()).toBe('teams.credentials.delivery.brokered');
    });

    it('keeps the connected-account source selected when entered from its Settings detail', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        const candidate = teamCredentialSourceCandidateFixture({
            source: {
                v: 1,
                kind: 'connected_account',
                target: {
                    kind: 'account',
                    account: {
                        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                        accountId: 'work',
                    },
                },
                credentialIncarnation: 'credential-life-1',
            },
            candidateId: 'candidate-account-1',
            label: 'Work account',
            memberCount: null,
        });
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [candidate], supportedKinds: ['connected_account'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId, {
            kind: 'connected_account', pluginId: 'happier.agent.codex', localId: 'openai-codex', accountId: 'work',
        });
        await waitForTestId(screen, 'team-credential-create-review-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe('Work account'));

        expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe('Work account');
    });

    it('keeps the Pool source selected when entered from its Settings detail', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        const candidate = teamCredentialSourceCandidateFixture({});
        harness.answer(serverId, SOURCES_PATH, {
            body: {
                candidates: [candidate],
                supportedKinds: ['connected_pool'],
                brokerPresentation: {
                    selectedTarget: null,
                    eligibleTargets: [{ machineId: 'machine-broker', displayName: 'Office Mac', availability: 'offline' }],
                    selectedPool: null,
                    eligiblePools: [],
                },
            },
        });

        const screen = await renderCreate(serverId, {
            kind: 'connected_pool',
            pluginId: candidate.source.kind === 'connected_pool' ? candidate.source.target.service.pluginId : '',
            localId: candidate.source.kind === 'connected_pool' ? candidate.source.target.service.localId : '',
            groupId: candidate.source.kind === 'connected_pool' ? candidate.source.target.groupId : '',
        });
        await waitForTestId(screen, 'team-credential-create-review-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe(candidate.label));

        expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe(candidate.label);
    });

    it('re-resolves a Provider connection hint to its exact current pinned candidate', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        answerProviderConnections(providerOffer('pc_work', 'Work Provider'));
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['provider_connection'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId, {
            kind: 'provider_connection', machineId: 'machine-a', connectionId: 'pc_work', credentialSlotId: 'apiKey', connectionSecurityFingerprint: 'connection-security:v1:pc_work',
        });
        await waitForTestId(screen, 'team-credential-create-review-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe('Work Provider'));

        expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe('Work Provider');
        const describeRequest = providerHarness.state.requests.find(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        );
        expect(describeRequest?.payload).not.toHaveProperty('connectionId');
    });

    it('does not preselect a Provider hint from a different Machine incarnation', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        answerProviderConnections(providerOffer('pc_work', 'Work Provider'));
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['provider_connection'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId, {
            kind: 'provider_connection', machineId: 'machine-stale', connectionId: 'pc_work', credentialSlotId: 'apiKey', connectionSecurityFingerprint: 'connection-security:v1:pc_work',
        });
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(providerHarness.state.requests.some(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        )).toBe(true));

        const describeRequest = providerHarness.state.requests.find(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        );
        expect(describeRequest?.payload).toMatchObject({ machineId: 'machine-a' });
        expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe('');
        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-source-picker:modal');
        expect(picker?.props?.selectedOptionId).toBeNull();
    });

    it('does not preselect a hinted source this Account can no longer offer', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        answerProviderConnections(providerOffer('pc_work', 'Work Provider'));
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['provider_connection'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId, {
            kind: 'provider_connection', machineId: 'machine-a', connectionId: 'pc_retired', credentialSlotId: 'apiKey', connectionSecurityFingerprint: 'connection-security:v1:pc_retired',
        });
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-source')?.props.disabled).not.toBe(true));

        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-source-picker:modal');
        expect(picker?.props?.selectedOptionId).toBeNull();
        expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe('');
    });

    it('does not preselect a Provider hint after its connection fingerprint rotates', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        answerProviderConnections(providerOffer('pc_work', 'Work Provider', 'connection-security:v1:current'));
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['provider_connection'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId, {
            kind: 'provider_connection',
            machineId: 'machine-a',
            connectionId: 'pc_work',
            credentialSlotId: 'apiKey',
            connectionSecurityFingerprint: 'connection-security:v1:retired',
        });
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-source')?.props.disabled).not.toBe(true));

        expect(screen.findByTestId('team-credential-create-name')?.props.value).toBe('');
        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.at(-1);
        expect(picker?.props?.selectedOptionId).toBeNull();
    });

    it('reaches audience principals through the canonical chooser rather than an inline roster', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        answerProviderConnections(providerOffer('pc_work', 'Work Provider'));
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['provider_connection'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-audience-add');
        await screen.pressByTestIdAsync('team-credential-create-audience-add');

        const picker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-audience-picker:modal');
        expect(picker).toBeDefined();
        await act(async () => {
            (picker?.props?.onChoose as (principal: { kind: 'group'; id: string; name: string }) => void)({
                kind: 'group', id: 'group-1', name: 'Developers',
            });
        });

        // The chosen principal becomes a row with its delivery chooser open;
        // the rest of the directory stays behind the search field.
        await waitForTestId(screen, 'team-credential-create-audience-group:group-1');
        expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-audience-mode:group:group-1:brokered');
    });

    it('offers a connection whose credential lives on another computer this Account administers', async () => {
        const serverId = await addHome();
        administrationTarget.controller.setMachines([
            { machineId: 'machine-a', displayName: 'Laptop', serverId },
            { machineId: 'machine-b', displayName: 'Studio', serverId },
        ]);
        answerViewer(serverId, true);
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['provider_connection'], brokerPresentation: emptyBrokerPresentation() },
        });
        // Only the computer that is *not* the Provider Settings target can serve
        // this connection's credential.
        providerHarness.intercept(
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            async (request) => createProviderConnectionsDescribeFixture({
                connections: (request.payload as { machineId: string }).machineId === 'machine-b'
                    ? [createProviderConnectionViewFixture({
                        connectionId: 'pc_studio',
                        teamCredentialSourceOffer: providerOffer('pc_studio', 'Studio Provider'),
                    })]
                    : [],
            }),
        );

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-source')?.props.disabled).not.toBe(true));
        await screen.pressByTestIdAsync('team-credential-create-source');

        const picker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-source-picker:modal');
        const step = picker?.props?.rootStep as { sections: { options: { label: string }[] }[] };
        // Requiring a global Provider Settings change to reach an offer this
        // person is already authorized for would push them out of the flow.
        expect(step.sections[0]?.options.map((option) => option.label)).toContain('Studio Provider');
    });

    it('reads models from the exact Provider offer chosen when connection identities overlap across Machines', async () => {
        const serverId = await addHome();
        administrationTarget.controller.setMachines([
            { machineId: 'machine-a', displayName: 'Laptop', serverId },
            { machineId: 'machine-b', displayName: 'Studio', serverId },
        ]);
        answerViewer(serverId, true);
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['provider_connection'], brokerPresentation: emptyBrokerPresentation() },
        });
        providerHarness.intercept(
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            async (request) => {
                const machineId = (request.payload as { machineId: string }).machineId;
                return createProviderConnectionsDescribeFixture({
                    connections: [createProviderConnectionViewFixture({
                        connectionId: 'pc_shared',
                        teamCredentialSourceOffer: providerOffer(
                            'pc_shared',
                            machineId === 'machine-b' ? 'Studio Provider' : 'Laptop Provider',
                            `connection-security:v1:${machineId}`,
                        ),
                    })],
                });
            },
        );
        answerRequestPolicySupport(serverId, 'model-studio');

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-source')?.props.disabled).not.toBe(true));
        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.at(-1);
        const step = picker?.props?.rootStep as { sections: { options: { id: string; label: string }[] }[] };
        const studio = step.sections[0]!.options.find((option) => option.label === 'Studio Provider');
        await act(async () => { (picker?.props?.onSelect as (id: string) => void)(studio!.id); });

        await waitForTestId(screen, 'team-credential-create-policy-model:model-studio');
        expect(harness.requestsFor(REQUEST_POLICY_SUPPORT_PATH).at(-1)?.input).toMatchObject({
            scope: 'source_draft',
            source: {
                kind: 'provider_connection',
                connectionId: 'pc_shared',
                connectionSecurityFingerprint: 'connection-security:v1:machine-b',
            },
        });
    });

    it('offers the Home’s own pinned source binding unchanged and lands on the created resource', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        const candidate = teamCredentialSourceCandidateFixture({});
        harness.answer(serverId, SOURCES_PATH, { body: {
            candidates: [candidate],
            supportedKinds: ['connected_pool'],
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [{ machineId: 'machine-broker', displayName: 'Office Mac', availability: 'offline' }],
                selectedPool: null,
                eligiblePools: [],
            },
        } });
        answerRequestPolicySupport(serverId, 'pool-model');

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(harness.requestsFor(SOURCES_PATH)).toHaveLength(1));

        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-source-picker:modal');
        expect(picker).toBeDefined();
        const step = picker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        await act(async () => {
            (picker?.props?.onSelect as (id: string) => void)(step.sections[0]!.options[0]!.id);
        });

        selectBrokerMachine(screen, 'machine-broker');
        await screen.pressByTestIdAsync('team-credential-create-audience-everyone');
        await screen.pressByTestIdAsync('team-credential-audience-mode:everyone:brokered');
        await screen.pressByTestIdAsync('team-credential-create-use-policy:team_context_required');
        await screen.pressByTestIdAsync('team-credential-create-policy-protocol:openai_responses');
        act(() => screen.changeTextByTestId('team-credential-create-limit-maximum', '100'));
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-submit')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-create-submit');
        await vi.waitFor(() => expect(harness.requestsFor(CREATE_PATH)).toHaveLength(1));

        const sent = harness.requestsFor(CREATE_PATH)[0]!.input as Record<string, unknown>;
        // The binding is forwarded byte for byte. A client that rebuilt it would
        // either drop the pinned Pool lifetime or carry a stale one, and the
        // offer would silently follow a Pool that had been recreated.
        expect(sent).toMatchObject({
            teamId: 'team-1',
            displayName: candidate.label,
            disclosureCeiling: 'brokered_only',
            source: candidate.source,
            sessionUsePolicy: 'team_context_required',
            brokerPlacement: { kind: 'machine', machineId: 'machine-broker' },
            requestPolicy: {
                allowedProtocolKinds: ['openai_responses'],
                allowedModelIds: null,
                reasoningEffort: null,
            },
            allMembersDeliveryMode: 'brokered',
            groupGrants: [],
            memberGrants: [],
            usageLimits: [{
                subjectKind: 'resource', subjectId: '', period: 'month',
                metric: 'inference_requests', maximum: '100', enabled: true,
            }],
        });
    });

    it('resolves a named-member limit through the shared principal picker and submits the Account id', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        const candidate = teamCredentialSourceCandidateFixture({});
        harness.answer(serverId, SOURCES_PATH, { body: {
            candidates: [candidate],
            supportedKinds: ['connected_pool'],
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [{ machineId: 'machine-broker', displayName: 'Office Mac', availability: 'available' }],
                selectedPool: null,
                eligiblePools: [],
            },
        } });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(harness.requestsFor(SOURCES_PATH)).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-source')?.props.disabled).not.toBe(true));
        await screen.pressByTestIdAsync('team-credential-create-source');
        const sourcePicker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-source-picker:modal');
        const sourceStep = sourcePicker?.props?.rootStep as { sections: { options: { id: string }[] }[] };
        act(() => {
            (sourcePicker?.props?.onSelect as (id: string) => void)(sourceStep.sections[0]!.options[0]!.id);
        });
        selectBrokerMachine(screen, 'machine-broker');
        await screen.pressByTestIdAsync('team-credential-create-audience-everyone');
        await screen.pressByTestIdAsync('team-credential-audience-mode:everyone:brokered');
        await screen.pressByTestIdAsync('team-credential-create-limit-subject:team_member');
        await screen.pressByTestIdAsync('team-credential-create-limit-member-choose');
        const memberPicker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-audience-picker:modal');
        expect(memberPicker?.props?.allowedKinds).toEqual(['member']);
        act(() => {
            (memberPicker?.props?.onChoose as (principal: { kind: 'member'; id: string; accountId: string; name: string }) => void)({
                kind: 'member', id: 'membership-maya', accountId: 'account-maya', name: 'Maya',
            });
        });
        act(() => screen.changeTextByTestId('team-credential-create-limit-maximum', '10'));
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-create-submit')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-create-submit');
        await vi.waitFor(() => expect(harness.requestsFor(CREATE_PATH)).toHaveLength(1));

        expect(harness.requestsFor(CREATE_PATH)[0]?.input).toMatchObject({
            usageLimits: [{ subjectKind: 'team_member', subjectId: 'account-maya' }],
        });
    });

    it('does not ask for sources a viewer the Home refuses to let offer', async () => {
        const serverId = await addHome();
        answerViewer(serverId, false);

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-forbidden');

        // The refusal is the Home's own projected decision, so the screen does
        // not open a read it already knows will be denied.
        expect(harness.requestsFor(SOURCES_PATH)).toHaveLength(0);
    });

    it('cancels the complete local draft without creating any resource', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        harness.answer(serverId, SOURCES_PATH, { body: { candidates: [teamCredentialSourceCandidateFixture({})], supportedKinds: ['connected_pool'], brokerPresentation: emptyBrokerPresentation() } });
        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-cancel');
        await screen.pressByTestIdAsync('team-credential-create-cancel');
        expect(routerBack).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor(CREATE_PATH)).toHaveLength(0);
    });

    it('keeps a source this Team already offers visible and unselectable', async () => {
        const serverId = await addHome();
        harness.answer(serverId, LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture({})],
                viewer: teamCredentialViewerFixture({ manageCredentials: true, offerOwnCredential: true }),
            },
        });
        harness.answer(serverId, SOURCES_PATH, {
            body: {
                candidates: [teamCredentialSourceCandidateFixture({ offeredByResourceId: 'resource-1' })],
                supportedKinds: ['connected_pool'],
                brokerPresentation: emptyBrokerPresentation(),
            },
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(harness.requestsFor(SOURCES_PATH)).toHaveLength(1));

        await screen.pressByTestIdAsync('team-credential-create-source');
        const picker = shownModals.find((modal) => modal.chrome?.testID === 'team-credential-source-picker:modal');
        const step = picker?.props?.rootStep as { sections: { options: { id: string; disabled?: boolean }[] }[] };
        // Hiding it would leave someone hunting for a source that is right in
        // front of them; offering it again would give the Team two policies over
        // one credential with no rule for which wins.
        expect(step.sections[0]?.options[0]).toMatchObject({ disabled: true });

        await act(async () => {
            (picker?.props?.onSelect as (id: string) => void)('candidate-pool-1');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-create-submit');
        expect(harness.requestsFor(CREATE_PATH)).toHaveLength(0);
    });

    it('names the source families this Home cannot offer instead of implying you own none', async () => {
        const serverId = await addHome();
        answerViewer(serverId, true);
        harness.answer(serverId, SOURCES_PATH, {
            body: { candidates: [], supportedKinds: ['connected_pool'], brokerPresentation: emptyBrokerPresentation() },
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-credential-create-source');
        await vi.waitFor(() => expect(harness.requestsFor(SOURCES_PATH)).toHaveLength(1));

        // "You own none" and "this Home cannot offer connected accounts" imply
        // different next actions, so both are stated rather than collapsed.
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain('teams.credentials.create.sourceEmpty');
        expect(rendered).toContain('teams.credentials.create.sourceUnsupported');
    });
});
