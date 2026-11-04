import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    decodePlainArtifactStoredContent,
    machinePoolActionEndpointPathV1,
    type MachinePoolViewV1,
} from '@happier-dev/protocol';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceDiscoveryPageV1Schema } from '@happier-dev/protocol/teams';

import { collectRenderedTestIds, createDeferred, renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialResourceFixture, teamCredentialSourceCandidateFixture, teamCredentialViewerFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    applyTeamCredentialResource,
    applyTeamCredentialResourcesPage,
    applyTeamProjection,
} from '@/sync/store/teams/teamsSnapshots';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerBack = vi.hoisted(() => vi.fn());
installSettingsViewCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        router: { back: routerBack },
    }).module,
    storage: 'real',
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createMachineAdministrationTargetSelectionMock, installMachineAdministrationTargetSelectionBoundary } = await import('@/dev/testkit/mocks/machineAdministrationTargetSelection');
const administrationTarget = createMachineAdministrationTargetSelectionMock({ selectedMachineId: null });
installMachineAdministrationTargetSelectionBoundary(administrationTarget);
// Cold-load the real owner graph after transport installation, before case deadlines.
const { storage } = await import('@/sync/domains/state/storage');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { resetMachinePoolSyncRuntimeForTests } = await import('@/sync/engine/machines/machinePoolSyncRuntime');
const { resetMachinePoolProjectionForTests } = await import('@/sync/engine/machines/machinePoolProjection');

const TEAM_GET_PATH = '/v1/teams/get';
const CREDENTIALS_LIST_PATH = '/v1/teams/credential-resources/list';
const CREDENTIAL_GET_PATH = '/v1/teams/credential-resources/get';
const CREDENTIAL_UPDATE_PATH = '/v1/teams/credential-resources/update';
const LIMITS_LIST_PATH = '/v1/teams/credential-resources/limits/list';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';

function poolView(id: string, name: string, connectedCount: number): MachinePoolViewV1 {
    return {
        pool: {
            id,
            name,
            description: null,
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            members: [{ machineId: 'machine-a', priorityTier: 0, enabled: true, state: 'connected' }],
        },
        availability: { state: 'known', connectedCount, enabledCount: 1 },
    };
}

function approvalRequestFromLastArtifact(): Readonly<Record<string, unknown>> {
    const request = harness.requestsFor(ARTIFACT_CREATE_PATH).at(-1)?.input;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('approval_artifact_request_missing');
    const body = (request as { body?: unknown }).body;
    if (typeof body !== 'string') throw new Error('approval_artifact_body_missing');
    const decoded = decodePlainArtifactStoredContent(body);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('approval_artifact_envelope_invalid');
    const raw = (decoded as { body?: unknown }).body;
    if (typeof raw !== 'string') throw new Error('approval_artifact_payload_missing');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('approval_request_invalid');
    return parsed as Readonly<Record<string, unknown>>;
}

function findDeclaredRow(
    screen: Readonly<{ findAllByTestId: (testID: string) => readonly ReactTestInstance[] }>,
    testID: string,
) {
    return screen.findAllByTestId(testID)[0] ?? null;
}

function brokerMachineSelector(screen: Readonly<{ findByType: (type: string) => ReactTestInstance }>) {
    return screen.findByType('MachineAdministrationTargetSelector');
}

function selectBrokerMachine(
    screen: Readonly<{ findByType: (type: string) => ReactTestInstance }>,
    machineId: string,
): void {
    const selection = brokerMachineSelector(screen).props.selection;
    const row = selection.pickerRows.find((candidateRow: { candidate: { target: { machineId: string } } }) => (
        candidateRow.candidate.target.machineId === machineId
    ));
    if (!row) throw new Error(`missing broker Machine ${machineId}`);
    act(() => selection.selectTarget(row.candidate.target));
}

const BROKER_ROW_PREFIX = 'team-credential-edit-broker:';

/**
 * The broker-location choices are one radio group, so their semantics are read
 * from the rendered tree rather than from declared props: a row that merely
 * looks selected while publishing a button role is the defect these assert.
 * Arrow-key roving inside that group belongs to its owner and is proven at
 * `components/ui/lists/ItemGroup.radioGroup.test.tsx`, which runs the web
 * runtime this screen harness does not.
 */
type BrokerSemanticsScreen = Readonly<{
    root: ReactTestInstance;
}>;

function hostNodes(scope: ReactTestInstance, predicate: (node: ReactTestInstance) => boolean) {
    return scope.findAll((node) => typeof node.type === 'string' && predicate(node));
}

/** The role this node publishes, whichever platform channel carries it. */
function publishedRole(node: ReactTestInstance): unknown {
    return node.props?.role ?? node.props?.accessibilityRole;
}

function publishedChecked(node: ReactTestInstance): unknown {
    return node.props?.['aria-checked'] ?? node.props?.accessibilityState?.checked;
}

/** Every rendered group that actually contains a broker-location row. */
function brokerLocationRadioGroups(screen: BrokerSemanticsScreen) {
    return hostNodes(screen.root, (node) => publishedRole(node) === 'radiogroup')
        .filter((group) => hostNodes(group, (row) => (
            typeof row.props?.testID === 'string' && row.props.testID.startsWith(BROKER_ROW_PREFIX)
        )).length > 0);
}

function brokerLocationRadioGroup(screen: BrokerSemanticsScreen) {
    const groups = brokerLocationRadioGroups(screen);
    expect(groups).toHaveLength(1);
    return groups[0]!;
}

/** The accessible radio choices of the one broker-location group, in render order. */
function brokerChoiceRadios(screen: BrokerSemanticsScreen) {
    return hostNodes(brokerLocationRadioGroup(screen), (node) => publishedRole(node) === 'radio');
}

function brokerChoiceTestIds(screen: BrokerSemanticsScreen): string[] {
    return brokerChoiceRadios(screen).map((row) => String(row.props.testID));
}

function checkedBrokerChoiceTestIds(screen: BrokerSemanticsScreen): string[] {
    return brokerChoiceRadios(screen)
        .filter((row) => publishedChecked(row) === true)
        .map((row) => String(row.props.testID));
}

async function renderEditor(params?: Readonly<{
    approvalRequired?: boolean;
    poolsEnabled?: boolean;
    sourceOwner?: boolean;
    placement?: 'machine' | 'pool' | 'none';
    /** The focused administration routes render exactly one section. */
    section?: 'access' | 'request_policy' | 'limits';
    sourceReadFails?: boolean;
    resourceOverrides?: Parameters<typeof teamCredentialResourceFixture>[0];
}>) {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://team-credential-placement.test',
        accountId: 'account-ada',
        teamsEnabled: true,
        credentialResourcesEnabled: true,
        machinePoolsEnabled: params?.poolsEnabled !== false,
    });
    await harness.selectHomes([serverId]);
    administrationTarget.controller.setMachines([
        { machineId: 'machine-exact', displayName: 'Ada’s Mac mini', serverId, serverIdentityId: 'identity-home-a', serverLabel: 'Home A' },
        { machineId: 'machine-offline', displayName: 'Travel laptop', availability: 'offline', serverId, serverIdentityId: 'identity-home-a', serverLabel: 'Home A' },
        { machineId: 'machine-update', displayName: 'Old broker', serverId, serverIdentityId: 'identity-home-a', serverLabel: 'Home A' },
        { machineId: 'machine-ineligible', displayName: 'Private laptop', serverId, serverIdentityId: 'identity-home-a', serverLabel: 'Home A' },
        { machineId: 'machine-exact', displayName: 'Other Home Machine', serverId: 'other-home', serverIdentityId: 'identity-home-b', serverLabel: 'Home B' },
    ]);
    const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) });
    harness.answer(serverId, TEAM_GET_PATH, { body: team });
    const firstPoolId = '00000000-0000-4000-8000-000000000001';
    const secondPoolId = '00000000-0000-4000-8000-000000000002';
    const pools = [
        poolView(firstPoolId, 'Development', 1),
        poolView(secondPoolId, 'Development', 1),
    ];
    const resource = teamCredentialResourceFixture({
        ...(params?.sourceOwner === false ? { source: null } : {}),
        brokerPlacement: params?.placement === 'none'
            ? null
            : params?.placement === 'pool'
                ? { kind: 'machine_pool', poolId: firstPoolId }
                : { kind: 'machine', machineId: 'machine-exact' },
        brokerPresentation: {
            selectedTarget: {
                machineId: 'machine-exact', displayName: 'Ada’s Mac mini', availability: 'available',
            },
            eligibleTargets: [
                { machineId: 'machine-exact', displayName: 'Ada’s Mac mini', availability: 'available' },
                { machineId: 'machine-offline', displayName: 'Travel laptop', availability: 'offline' },
                { machineId: 'machine-update', displayName: 'Old broker', availability: 'update_required' },
            ],
            selectedPool: params?.placement === 'pool' ? {
                poolId: firstPoolId,
                displayName: 'Development',
                availability: 'unavailable',
                availableMachineCount: 0,
            } : null,
            eligiblePools: [{
                poolId: firstPoolId,
                displayName: 'Development',
                availability: 'unavailable',
                availableMachineCount: 0,
            }, {
                poolId: secondPoolId,
                displayName: 'Development',
                availability: 'not_verified',
                availableMachineCount: null,
            }],
        },
        ...params?.resourceOverrides,
    });
    harness.answer(serverId, CREDENTIALS_LIST_PATH, {
        body: {
            resources: [resource],
            viewer: teamCredentialViewerFixture({ manageCredentials: true }),
        },
    });
    harness.answer(serverId, CREDENTIAL_GET_PATH, { body: resource });
    harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [], nextCursor: null, failures: [] }) });
    harness.answer(serverId, LIMITS_LIST_PATH, { body: { limits: [], nextCursor: null } });
    if (params?.sourceReadFails) {
        harness.answer(serverId, '/v1/teams/credential-resources/sources/list', { status: 503 });
    }
    storage.setState({
        machineListByServerId: { [serverId]: [] },
        machineListStatusByServerId: { [serverId]: 'idle' },
        machinePoolListByServerId: { [serverId]: pools },
        machinePoolListStatusByServerId: { [serverId]: 'idle' },
        machinePoolAccountIdByServerId: { [serverId]: 'account-ada' },
    });
    const scope = { serverId, accountId: 'account-ada' };
    const address = { serverId, teamId: 'team-1' };
    applyTeamProjection({ scope, address, team, observedAt: 1 });
    applyTeamCredentialResourcesPage({
        scope,
        address,
        resources: [resource],
        viewer: teamCredentialViewerFixture({ manageCredentials: true }),
        observedAt: 1,
    });
    if (params?.approvalRequired === true) {
        await harness.requireUiApproval(serverId, 'teams.credentials.update');
    }
    const { TeamCredentialEditScreen } = await import('./TeamCredentialEditScreen');
    const screen = await renderScreen(
        <TeamCredentialEditScreen
            serverId={serverId}
            teamId="team-1"
            resourceId="resource-1"
            {...(params?.section ? { section: params.section } : {})}
        />,
    );
    await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()), JSON.stringify({
        text: screen.getTextContent(), requests: harness.requests.map(request => request.path),
    }))
        .toContain('team-credential-edit-save'));
    return { screen, firstPoolId, secondPoolId, resource, serverId };
}

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    resetMachinePoolSyncRuntimeForTests();
    resetMachinePoolProjectionForTests();
    administrationTarget.controller.reset();
    await harness.reset();
    await harness.selectHomes([]);
    routerBack.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('TeamCredentialEditScreen broker placement', () => {
    it.each(['succeeded', 'unreachable', 'not_visible'] as const)('waits for the exact administration read when a recipient catalog row arrives first (%s)', async (outcome) => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://recipient-editor.test', accountId: 'account-maya',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { body: teamSummaryFixture() });
        const resource = teamCredentialResourceFixture({
            source: null,
            brokerPlacement: null,
            brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
            readiness: { kind: 'broker_unavailable' },
            recoveryAction: 'source_owner_action',
        });
        const exactRead = createDeferred<{ status?: number; body: typeof resource | { error: string } }>();
        harness.answer(serverId, CREDENTIAL_GET_PATH, { select: () => exactRead.promise });
        harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ nextCursor: null, failures: [], resources: [{
            id: resource.id, teamId: resource.teamId, displayName: resource.displayName,
            resourceRevision: resource.revision, sourcePresentation: resource.sourcePresentation,
            readiness: resource.readiness, recoveryAction: resource.recoveryAction,
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
            sessionUsePolicy: resource.sessionUsePolicy, providerModels: [], connectedServiceSelections: [],
        }] }) });
        harness.answer(serverId, LIMITS_LIST_PATH, { body: { limits: [], nextCursor: null } });
        const { getTeamCredentialResourceCatalogSnapshot } = await import('@/sync/store/teams/teamsSnapshots');
        const { TeamCredentialEditScreen } = await import('./TeamCredentialEditScreen');
        const screen = await renderScreen(
            <TeamCredentialEditScreen serverId={serverId} teamId="team-1" resourceId={resource.id} />,
        );
        await vi.waitFor(() => expect(getTeamCredentialResourceCatalogSnapshot(
            { serverId, accountId: 'account-maya' }, { serverId, teamId: 'team-1' },
        )?.status).toBe('ready'));

        expect(screen.findByTestId('team-credential-edit-unavailable')).toBeNull();
        expect(screen.findByTestId('team-credential-edit-loading')).not.toBeNull();

        if (outcome === 'not_visible') {
            await act(async () => exactRead.resolve({ status: 404, body: { error: 'not_found_or_not_visible' } }));
            await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-unavailable')).not.toBeNull());
            expect(screen.findByTestId('team-credential-edit-name')).toBeNull();
            return;
        }
        if (outcome === 'unreachable') {
            await act(async () => exactRead.resolve({ status: 503, body: { error: 'unavailable' } }));
            await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-resource-retry')).not.toBeNull());
            expect(screen.findByTestId('team-credential-edit-unavailable')).toBeNull();
            harness.answer(serverId, CREDENTIAL_GET_PATH, { body: resource });
            await screen.pressByTestIdAsync('team-credential-edit-resource-retry');
        } else {
            await act(async () => exactRead.resolve({ body: resource }));
        }
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-name')?.props.value).toBe(resource.displayName));
        expect(screen.findByTestId('team-credential-edit-unavailable')).toBeNull();
        expect(screen.root.findAllByType('MachineAdministrationTargetSelector')).toHaveLength(0);
    });

    it('retries an initial source read without replacing the resource draft', async () => {
        const { screen, serverId, resource } = await renderEditor({ sourceReadFails: true });
        act(() => screen.changeTextByTestId('team-credential-edit-name', 'Keep this draft'));
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-source-retry')).not.toBeNull());
        const candidate = teamCredentialSourceCandidateFixture({ label: 'Recovered pool' });
        harness.answer(serverId, '/v1/teams/credential-resources/sources/list', {
            body: { candidates: [candidate], supportedKinds: ['connected_pool'], brokerPresentation: resource.brokerPresentation },
        });
        await screen.pressByTestIdAsync('team-credential-edit-source-retry');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-source-retry')).toBeNull());
        expect(screen.findByTestId('team-credential-edit-name')?.props.value).toBe('Keep this draft');
        await vi.waitFor(() => expect(findDeclaredRow(screen, 'team-credential-create-source')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-create-source');
        const { Modal } = await import('@/modal');
        // The modal boundary records heterogeneous component configs; this assertion reads only the picker shape.
        const picker = vi.mocked(Modal.show).mock.calls.at(-1)?.[0] as unknown as Readonly<{
            props: {
                rootStep: { sections: readonly { options: readonly { id: string; label: string }[] }[] };
                onSelect: (id: string) => void;
            };
        }>;
        const option = picker.props.rootStep.sections.flatMap((section) => section.options).find((row) => row.label === 'Recovered pool');
        expect(option).toBeDefined();
        await act(async () => picker.props.onSelect(option!.id));
        expect(findDeclaredRow(screen, 'team-credential-create-source')?.props.detail).toBe('Recovered pool');
        expect(screen.findByTestId('team-credential-edit-name')?.props.value).toBe('Keep this draft');
    });

    it('composes exact Home eligibility with canonical Machine rows and preserves offline placement', async () => {
        const { screen } = await renderEditor({ placement: 'none' });
        const selector = brokerMachineSelector(screen);
        expect(selector.props.selection.pickerRows.map((row: { candidate: { target: { machineId: string } } }) => (
            row.candidate.target.machineId
        ))).toEqual(['machine-exact', 'machine-offline', 'machine-update']);
        expect(selector.props.resolveCandidatePresentation(selector.props.selection.candidates[0])).toMatchObject({
            title: 'Ada’s Mac mini',
            subtitle: expect.stringContaining('Home A'),
        });
        expect(selector.props.resolveCandidateAvailability(
            selector.props.selection.candidates.find((candidate: { target: { machineId: string } }) => candidate.target.machineId === 'machine-offline'),
        )).toMatchObject({ selectable: true });
        expect(selector.props.resolveCandidateAvailability(
            selector.props.selection.candidates.find((candidate: { target: { machineId: string } }) => candidate.target.machineId === 'machine-update'),
        )).toMatchObject({ selectable: false });

        selectBrokerMachine(screen, 'machine-offline');
        expect(brokerMachineSelector(screen).props.selection.selectedTarget.machineId).toBe('machine-offline');
    });

    it('saves a source-unavailable personal Machine Pool without deriving readiness from its connected members', async () => {
        const { screen, firstPoolId } = await renderEditor({ approvalRequired: true });
        const poolRow = findDeclaredRow(screen, `team-credential-edit-broker:machine_pool:${firstPoolId}`);
        expect(poolRow?.props.disabled).toBe(false);
        expect(poolRow?.props.detail).toContain('No broker available');

        await screen.pressByTestIdAsync(`team-credential-edit-broker:machine_pool:${firstPoolId}`);
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-edit-save');

        await vi.waitFor(() => expect(harness.requestsFor(ARTIFACT_CREATE_PATH), JSON.stringify({
            text: screen.getTextContent(), requests: harness.requests.map(request => request.path),
        })).toHaveLength(1));
        expect(approvalRequestFromLastArtifact()).toMatchObject({
            actionId: 'teams.credentials.update',
            actionArgs: {
                resourceId: 'resource-1',
                expectedRevision: 3,
                replacement: {
                    enabled: true,
                    displayName: 'Claude Enterprise',
                    sessionUsePolicy: 'personal_allowed',
                    requestPolicy: null,
                    custodian: {
                        brokerPlacement: { kind: 'machine_pool', poolId: firstPoolId },
                    },
                    usageLimitDelta: { upserts: [], deleteIds: [] },
                },
            },
        });
        const actionArgs = approvalRequestFromLastArtifact().actionArgs;
        expect(actionArgs).not.toHaveProperty('source');
        expect(actionArgs).not.toHaveProperty('brokerPlacement');
    });

    it('keeps duplicate Pool names exact and accessible, including an unverified source decision', async () => {
        const { screen, firstPoolId, secondPoolId } = await renderEditor();
        const first = findDeclaredRow(screen, `team-credential-edit-broker:machine_pool:${firstPoolId}`);
        const second = findDeclaredRow(screen, `team-credential-edit-broker:machine_pool:${secondPoolId}`);
        expect(first?.props.title).toBe('Development');
        expect(second?.props.title).toBe('Development');
        expect(first?.props.accessibilityLabel).not.toBe(second?.props.accessibilityLabel);
        expect(first?.props.accessibilityLabel).toContain(firstPoolId);
        expect(second?.props.accessibilityLabel).toContain(secondPoolId);
        expect(second?.props.detail).toContain('Not verified');
    });

    it('hides only Machine Pool choices when the Pool feature is unsupported', async () => {
        const { screen, firstPoolId } = await renderEditor({ poolsEnabled: false });
        const testIds = collectRenderedTestIds(screen.tree.toJSON());
        expect(brokerMachineSelector(screen).props.selection.pickerRows).toHaveLength(3);
        expect(testIds).not.toContain(`team-credential-edit-broker:machine_pool:${firstPoolId}`);
    });

    it('keeps the server-projected current Pool visible when Pool operations are unsupported', async () => {
        const { screen, firstPoolId } = await renderEditor({ poolsEnabled: false, placement: 'pool' });
        const currentPool = findDeclaredRow(screen, `team-credential-edit-broker:machine_pool:${firstPoolId}`);
        expect(currentPool?.props.title).toBe('Development');
        expect(currentPool?.props.detail).toBe('Machine pools are unavailable on this Home. Update or enable them on the Home to continue.');
        expect(currentPool?.props.accessibilityLabel).toContain('Machine pools are unavailable');
        expect(currentPool?.props.selected).toBe(true);
        expect(currentPool?.props.disabled).toBe(true);
        expect(brokerMachineSelector(screen).props.selection.pickerRows).toHaveLength(3);
    });

    it('shows the repairable choose-location state when placement is null', async () => {
        const { screen } = await renderEditor({ placement: 'none' });
        const selector = brokerMachineSelector(screen);
        expect(selector.props.selection.selectedTarget).toBeNull();
        expect(selector.props.unselectedTitle).toContain('Choose a broker location');
    });

    it('preserves its Pool draft across refresh and adopts the current Pool only on explicit reload', async () => {
        const { screen, firstPoolId, secondPoolId, resource, serverId } = await renderEditor();
        await screen.pressByTestIdAsync(`team-credential-edit-broker:machine_pool:${firstPoolId}`);

        act(() => applyTeamCredentialResource({
            scope: { serverId, accountId: 'account-ada' },
            address: { serverId, teamId: 'team-1' },
            resource: {
                ...resource,
                revision: 4,
                brokerPlacement: { kind: 'machine_pool', poolId: secondPoolId },
                brokerPresentation: {
                    ...resource.brokerPresentation,
                    selectedPool: resource.brokerPresentation.eligiblePools[1]!,
                },
            },
            observedAt: 4,
        }));

        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-reload')).not.toBeNull());
        expect(findDeclaredRow(screen, `team-credential-edit-broker:machine_pool:${firstPoolId}`)?.props.selected).toBe(true);
        expect(screen.findByTestId('team-credential-edit-save')?.props.disabled).toBe(true);

        await screen.pressByTestIdAsync('team-credential-edit-reload');
        expect(findDeclaredRow(screen, `team-credential-edit-broker:machine_pool:${secondPoolId}`)?.props.selected).toBe(true);
        expect(findDeclaredRow(screen, `team-credential-edit-broker:machine_pool:${firstPoolId}`)?.props.selected).toBe(false);
    });

    it('does not enumerate a custodian’s private Pools to another Team manager', async () => {
        const { screen, firstPoolId } = await renderEditor({ sourceOwner: false });
        const testIds = collectRenderedTestIds(screen.tree.toJSON());
        expect(testIds).not.toContain(`team-credential-edit-broker:machine_pool:${firstPoolId}`);
        expect(screen.root.findAllByType('MachineAdministrationTargetSelector')).toHaveLength(0);
    });

    it('omits masked custodian authority from a manager replacement save', async () => {
        const { screen } = await renderEditor({ sourceOwner: false, approvalRequired: true });

        act(() => screen.changeTextByTestId('team-credential-edit-name', 'Manager-visible name'));
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-edit-save');

        await vi.waitFor(() => expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(1));
        const actionArgs = approvalRequestFromLastArtifact().actionArgs as {
            replacement?: Readonly<Record<string, unknown>>;
        };
        expect(actionArgs.replacement).toMatchObject({
            displayName: 'Manager-visible name',
            requestPolicy: null,
            usageLimitDelta: { upserts: [], deleteIds: [] },
        });
        expect(actionArgs.replacement).not.toHaveProperty('custodian');
    });

    it('keeps the editor draft visible when a resource refresh fails and offers an exact retry', async () => {
        const { screen, serverId } = await renderEditor();
        act(() => screen.changeTextByTestId('team-credential-edit-name', 'Draft name'));
        harness.answer(serverId, CREDENTIAL_GET_PATH, { status: 503, body: { error: 'unavailable' } });
        const { refreshTeamCredentialResource } = await import('@/sync/engine/teams/teamsDirectoryEngine');

        await refreshTeamCredentialResource(
            { serverId, accountId: 'account-ada' },
            { serverId, teamId: 'team-1' },
            'resource-1',
        );

        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-resource-retry')).not.toBeNull());
        expect(screen.findByTestId('team-credential-edit-name')?.props.value).toBe('Draft name');
    });

    it('keeps broker Machines in the canonical selector and Pools in their own named group', async () => {
        const { screen, firstPoolId, secondPoolId } = await renderEditor({ placement: 'none' });

        const group = brokerLocationRadioGroup(screen);
        expect(group.props['aria-label'] ?? group.props.accessibilityLabel).toBe('My machine pools');
        expect(brokerChoiceTestIds(screen)).toEqual([
            `team-credential-edit-broker:machine_pool:${firstPoolId}`,
            `team-credential-edit-broker:machine_pool:${secondPoolId}`,
        ]);
        expect(checkedBrokerChoiceTestIds(screen)).toEqual([]);
        expect(brokerMachineSelector(screen).props.selection.pickerRows).toHaveLength(3);
    });

    it('checks the unavailable Pool only while the draft still points at it', async () => {
        const { screen, firstPoolId } = await renderEditor({ poolsEnabled: false, placement: 'pool' });
        const staleTestId = `team-credential-edit-broker:machine_pool:${firstPoolId}`;
        expect(checkedBrokerChoiceTestIds(screen)).toEqual([staleTestId]);

        selectBrokerMachine(screen, 'machine-exact');
        expect(checkedBrokerChoiceTestIds(screen)).toEqual([]);
        expect(brokerMachineSelector(screen).props.selection.selectedTarget.machineId).toBe('machine-exact');
        expect(findDeclaredRow(screen, staleTestId)?.props.selected).toBe(false);
    });

    it('keeps an unsaved Pool draft checked after a refresh removes it from the live catalog', async () => {
        const { screen, secondPoolId, serverId } = await renderEditor();
        const draftTestId = `team-credential-edit-broker:machine_pool:${secondPoolId}`;
        await screen.pressByTestIdAsync(draftTestId);
        expect(checkedBrokerChoiceTestIds(screen)).toEqual([draftTestId]);

        act(() => storage.getState().removeMachinePool(secondPoolId, {
            sourceServerId: serverId,
            sourceAccountId: 'account-ada',
        }));

        expect(checkedBrokerChoiceTestIds(screen)).toEqual([draftTestId]);
        const draftRow = findDeclaredRow(screen, draftTestId);
        expect(draftRow?.props.title).toBe('Development');
        expect(draftRow?.props.disabled).toBe(true);
        expect(draftRow?.props.accessibilityLabel).toContain(secondPoolId);

        selectBrokerMachine(screen, 'machine-exact');
        expect(checkedBrokerChoiceTestIds(screen)).toEqual([]);
        expect(brokerMachineSelector(screen).props.selection.selectedTarget.machineId).toBe('machine-exact');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(draftTestId);
    });

    it('keeps exactly one checked choice when the saved Pool and the draft Pool are both unavailable', async () => {
        const { screen, firstPoolId, secondPoolId, serverId } = await renderEditor({ placement: 'pool' });
        await screen.pressByTestIdAsync(`team-credential-edit-broker:machine_pool:${secondPoolId}`);

        act(() => {
            const scope = { sourceServerId: serverId, sourceAccountId: 'account-ada' };
            storage.getState().removeMachinePool(firstPoolId, scope);
            storage.getState().removeMachinePool(secondPoolId, scope);
        });

        expect(brokerChoiceTestIds(screen)).toEqual([
            `team-credential-edit-broker:machine_pool:${firstPoolId}`,
            `team-credential-edit-broker:machine_pool:${secondPoolId}`,
        ]);
        expect(checkedBrokerChoiceTestIds(screen))
            .toEqual([`team-credential-edit-broker:machine_pool:${secondPoolId}`]);
        expect(findDeclaredRow(screen, `team-credential-edit-broker:machine_pool:${firstPoolId}`)?.props.disabled)
            .toBe(true);
    });

    it('saves the replacement location chosen over an unavailable Pool and keeps the edited name', async () => {
        const { screen } = await renderEditor({
            approvalRequired: true,
            poolsEnabled: false,
            placement: 'pool',
        });
        act(() => screen.changeTextByTestId('team-credential-edit-name', 'Repaired credential'));

        selectBrokerMachine(screen, 'machine-exact');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-edit-save');

        await vi.waitFor(() => expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(1));
        expect(approvalRequestFromLastArtifact()).toMatchObject({
            actionId: 'teams.credentials.update',
            actionArgs: {
                resourceId: 'resource-1',
                expectedRevision: 3,
                replacement: {
                    enabled: true,
                    displayName: 'Repaired credential',
                    sessionUsePolicy: 'personal_allowed',
                    requestPolicy: null,
                    custodian: {
                        brokerPlacement: { kind: 'machine', machineId: 'machine-exact' },
                    },
                    usageLimitDelta: { upserts: [], deleteIds: [] },
                },
            },
        });
        const actionArgs = approvalRequestFromLastArtifact().actionArgs as Record<string, unknown>;
        expect(actionArgs).not.toHaveProperty('displayName');
        expect(actionArgs).not.toHaveProperty('brokerPlacement');
    });

    it('keeps a Pool projection failure actionable and preserves the credential draft while retrying', async () => {
        const { screen, serverId } = await renderEditor();
        const response = createDeferred<void>();
        const listPath = machinePoolActionEndpointPathV1('machines.pools.list');
        const priorReads = harness.requestsFor(listPath).length;
        const retainedPools = storage.getState().machinePoolListByServerId[serverId];
        const retainedChoices = brokerChoiceTestIds(screen);
        harness.answer(serverId, listPath, {
            body: { pools: retainedPools },
            respondAfter: response.promise,
        });
        act(() => screen.changeTextByTestId('team-credential-edit-name', 'Draft name'));
        act(() => storage.getState().setMachinePoolListStatus(serverId, 'error'));

        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-broker:machine_pool:retry')).not.toBeNull());
        const retry = findDeclaredRow(screen, 'team-credential-edit-broker:machine_pool:retry');
        expect(retry?.props.disabled).not.toBe(true);
        expect(retry?.props.accessibilityLabel).toBe('Retry: My machine pools');

        try {
            await screen.pressByTestIdAsync('team-credential-edit-broker:machine_pool:retry');
            await vi.waitFor(() => expect(harness.requestsFor(listPath)).toHaveLength(priorReads + 1));
            // A hydrated Pool list stays painted during a background retry.
            expect(storage.getState().machinePoolListByServerId[serverId]).toEqual(retainedPools);
            expect(brokerChoiceTestIds(screen)).toEqual(retainedChoices);
            expect(screen.findByTestId('team-credential-edit-broker:machine_pool:loading')).toBeNull();
            expect(screen.findByTestId('team-credential-edit-name')?.props.value).toBe('Draft name');
        } finally {
            await act(async () => response.resolve());
        }
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-broker:machine_pool:retry')).toBeNull());
        expect(screen.findByTestId('team-credential-edit-name')?.props.value).toBe('Draft name');
    });

    it('shows a focused Access save refusal, which the full editor’s name group could never render', async () => {
        const { screen, serverId } = await renderEditor({ section: 'access' });
        harness.answer(serverId, CREDENTIAL_UPDATE_PATH, {
            status: 400,
            body: { error: 'invalid_audience' },
        });

        await screen.pressByTestIdAsync('team-credential-audience-everyone');
        await screen.pressByTestIdAsync('team-credential-audience-mode:everyone:brokered');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-edit-save');

        const { t } = await import('@/text');
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain(t('teams.credentials.errors.invalidAudience'));
        });
        // The refusal keeps the person where they are, with their draft.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-edit-save');
        expect(routerBack).not.toHaveBeenCalled();
    });
});

describe('TeamCredentialEditScreen disclosure narrowing', () => {
    // Child 01 §7.1 rule 5 and the §7.2 "Narrow direct ceiling" row: broker and
    // direct rights are independent, and narrowing withdraws only the direct
    // half. A direct-only grant ends; it never becomes broker use nobody chose.
    it('withdraws only direct delivery when the full editor narrows the ceiling', async () => {
        const { screen } = await renderEditor({
            approvalRequired: true,
            resourceOverrides: {
                deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
                directExportSupport: 'supported',
                allMembersAllowedRoutes: ['direct'],
                groupGrants: [
                    { teamGroupId: 'group-both', allowedRoutes: ['brokered', 'direct'] },
                    { teamGroupId: 'group-direct', allowedRoutes: ['direct'] },
                ],
                memberGrants: [
                    { teamMembershipId: 'membership-direct', allowedRoutes: ['direct'] },
                    { teamMembershipId: 'membership-brokered', allowedRoutes: ['brokered'] },
                ],
            },
        });

        await screen.pressByTestIdAsync('team-credential-edit-ceiling:brokered_only');
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-edit-save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('team-credential-edit-save');

        await vi.waitFor(() => expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(1));
        const actionArgs = approvalRequestFromLastArtifact().actionArgs as {
            replacement: Readonly<Record<string, unknown>>;
        };
        expect(actionArgs.replacement).toMatchObject({
            allMembersAllowedRoutes: null,
            groupGrants: [{ teamGroupId: 'group-both', allowedRoutes: ['brokered'] }],
            memberGrants: [{ teamMembershipId: 'membership-brokered', allowedRoutes: ['brokered'] }],
            custodian: { deliveryPolicy: { preferredAllowedModes: ['brokered'] } },
        });
    });
});
