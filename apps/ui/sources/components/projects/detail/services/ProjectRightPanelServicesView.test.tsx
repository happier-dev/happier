import * as React from 'react';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalServiceLauncherSnapshotV1} from '@happier-dev/protocol/local/services/launcher/v1';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ActionOperationSnapshotV1Schema, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { readExplicitActionApprovalPreferenceV1 } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema, DaemonLocalServiceLauncherStartRequestV1Schema,
    DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePublicPreviewCreateResponseV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import type { IModal } from '@/modal/types';
import { buildLocalServiceInventoryRow, buildLocalServiceInventoryState } from '@/dev/testkit/fixtures/localServices';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { pressTestInstanceAsync, renderScreen, flushHookEffects } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

// Real Account lifetime beneath genuine network/device-credential boundaries;
// signed-out fixtures cannot dispatch through the mounted Services host.
const home = createHomeGovernanceHarness();
installDisconnectedServerSocketBoundary();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
const { ProjectRightPanelServicesView } = await import('./ProjectRightPanelServicesView');
const { SessionRightPanelServicesView } = await import('@/components/sessions/panes/services/SessionRightPanelServicesView');
const { SessionServicesSurfaceScreen } = await import('@/components/workspaceCockpit/session/SessionServicesSurfaceScreen');
const { ServiceRowView } = await import('@/components/sessions/localServices/ServiceRowView');
const { createFrontDoorRuntimeActionExecutor } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');

// Load the real daemon producers at runtime without rooting the CLI's compiler graph in UI tests.
const launcherProducerPath = fileURLToPath(new URL('../../../../../../cli/src/daemon/local/services/launch/suggestions.ts', import.meta.url));
const previewProducerPath = fileURLToPath(new URL('../../../../../../cli/src/daemon/local/services/preview/registry.ts', import.meta.url));
const { buildLocalServiceLauncherSnapshot } = await vi.importActual<{
    buildLocalServiceLauncherSnapshot(input: Readonly<{
        machineId: string; accountId: string; sessionId: string; updatedAt: number;
        runTargets: readonly never[];
        inventoryEntries: readonly ReturnType<typeof buildLocalServiceInventoryRow>[];
        previewResources: readonly LocalServicePreviewResourceV1[];
    }>): LocalServiceLauncherSnapshotV1;
}>(launcherProducerPath);
const { previewIdForInventoryEntry } = await vi.importActual<{
    previewIdForInventoryEntry(accountId: string, machineId: string, sessionId: string | undefined, entryId: string): string;
}>(previewProducerPath);
const publicPreviewId = previewIdForInventoryEntry('project-account', 'machine-a', 'session-a', 'project-feed');

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: navigation.push },
}).module);
// Only the daemon network is substituted; the mounted host and all Action dispatch run for real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});

const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalShowMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const boundary = createModalModuleMock({
        confirmResult: true,
        renderCustomModals: true,
        spies: { confirm: modalConfirmMock, alert: modalAlertMock },
    });
    modalShowMock.mockImplementation(boundary.spies.show);
    return { ...boundary.module, Modal: { ...boundary.module.Modal, show: modalShowMock } };
});

const { Modal, ModalProvider } = await import('@/modal');

async function publishFeatures(serverId: string, publicPreviewEnabled: boolean) {
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: 'srv_services_project' },
    }, features: {
        localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
            preview: { enabled: true }, publicPreview: { enabled: publicPreviewEnabled } },
        browser: { enabled: true, viewTargets: { enabled: true } },
    } });
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    // The real decision hook reads the Home's canonical published snapshot.
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features,
        serverIdentityId: features.capabilities.serverIdentity.serverIdentityId } });
    return features;
}

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        updatedAt: 3_000,
        targets: [{
            id: 'inventory:project-feed',
            source: 'inventory_entry',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'project-feed' },
            machineId: 'machine-a',
            title: 'Project feed service',
            subtitle: 'localhost:3000',
            confidence: 'medium',
            state: 'available',
            actions: ['start'],
        }],
    });
}

function buildPublicPreviewLauncherState() {
    const snapshot = buildLocalServiceLauncherSnapshot({
        machineId: 'machine-a',
        accountId: 'project-account',
        sessionId: 'session-a',
        updatedAt: 3_000,
        runTargets: [],
        inventoryEntries: [buildLocalServiceInventoryRow({ id: 'project-feed', port: 3000,
            classification: { kind: 'vite', displayName: 'Vite', confidence: 'high', lowSignal: false, signals: ['vite'] },
            provenance: { session: { id: 'session-a' } } })],
        previewResources: [{
            previewId: publicPreviewId,
            machineId: 'machine-a',
            sessionId: 'session-a',
            owner: { kind: 'session', id: 'session-a' },
            target: { scheme: 'http', host: '127.0.0.1', port: 3000 },
            initialPath: { pathname: '/', search: '' },
            display: { title: 'Project feed preview', addressLabel: 'localhost:3000' },
            originMode: 'host',
        }],
    });
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), snapshot);
}

function buildPublicPreviewState() {
    return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        generatedAt: 4_000,
        refreshState: 'idle',
        policy: {
            enabled: true,
            allowedModes: ['secret_link'],
            maxTtlMs: 600_000,
            maxConcurrentExposures: 2,
            dnsTlsRequired: true,
            auditRequired: true,
            rateLimitProfileIds: ['default'],
        },
        exposures: [],
        diagnostics: [],
    });
}

describe('ProjectRightPanelServicesView', () => {
    let serverId: string;
    let serverIdentityId: string;
    let connection: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>> | undefined;
    beforeEach(async () => {
        await home.reset();
        serverId = await home.addHome({ name: 'Project Home', serverUrl: 'https://project.example.test', accountId: 'project-account',
            serverIdentityId: 'srv_services_project', currentAccount: true });
        home.answer(serverId, '/v1/projects/execution/config/read', { body: { status: 'absent' } });
        const features = await publishFeatures(serverId, true);
        if (!features.capabilities.serverIdentity.serverIdentityId) throw new Error('expected_home_identity');
        serverIdentityId = features.capabilities.serverIdentity.serverIdentityId;
        rpc.machine.mockReset();
        rpc.machine.mockImplementation(async () => { throw new Error('unexpected_machine_rpc'); });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'project-account' };
        storage.setState({ profileScope: scope, settingsScope: scope });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'], 'localServices.publicPreview.create': ['ui'] },
        } }), 1);
        modalConfirmMock.mockClear();
        navigation.push.mockClear();
        modalAlertMock.mockClear();
        modalShowMock.mockClear();
        Modal.hideAll();
    });
    afterEach(async () => { await connection?.dispose(); connection = undefined; await home.reset(); });

    it.each(['project', 'session'] as const)('keeps the %s Services header unknown after a failed launcher read and reports a confirmed empty read', async surface => {
        const { PaneHeader } = await import('@/components/appShell/panes/PaneHeader');
        const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
        const { SessionRightPanelServicesView } = await import('@/components/sessions/panes/services/SessionRightPanelServicesView');
        const { t } = await import('@/text');
        rpc.machine.mockImplementation(async ({ method, signal }: { method: string; signal?: AbortSignal }) => {
            if (method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) throw new Error(`unexpected_rpc:${method}`);
            return new Promise(resolve => signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'request_failed' }), { once: true }));
        });
        function HeaderProbe(): React.ReactElement {
            const published = usePublishedPaneHeaderContent('services');
            return <PaneHeader testID="launcher-truth-header" title="Services" line={published?.line ?? null} actions={published?.action} />;
        }
        for (const failed of [false, true]) {
            const machineId = `launcher-truth-${surface}-${failed}`;
            // The daemon read is the boundary; the shared launcher store and mounted header remain real.
            const launcherSnapshotClient = vi.fn(async () => failed
                ? { ok: false as const, reason: 'request_failed' as const }
                : { ok: true as const, snapshot: { v: 1 as const, machineId, updatedAt: 1, targets: [] } });
            const props = { serverId, machineId, inventoryState: buildLocalServiceInventoryState({ rows: [] }), launcherSnapshotClient };
            const screen = await renderScreen(<PaneHeaderSlotProvider><HeaderProbe /><PaneHeaderSlotScope slotKey="services">
                {surface === 'project' ? <ProjectRightPanelServicesView {...props} /> : <SessionRightPanelServicesView {...props} />}
            </PaneHeaderSlotScope></PaneHeaderSlotProvider>);
            const prefix = `${surface}-rightpanel-services`;
            await vi.waitFor(() => expect(screen.findByTestId(`${prefix}-${failed ? 'error' : 'empty'}`)).not.toBeNull());
            const collect = (node: { children: readonly unknown[] }): string => node.children.map(child => typeof child === 'string'
                ? child : collect(child as { children: readonly unknown[] })).join(' ');
            const header = collect(screen.findByTestId('launcher-truth-header')!);
            const emptyCopy = t('localServices.pane.nothingRunningInWorkspace');
            if (failed) expect(header).not.toContain(emptyCopy);
            else expect(header).toContain(emptyCopy);
            await screen.unmount();
        }
    });

    it('keeps one managed runtime state and recovery across the real rail, detail and Services', async () => {
        const { View } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { t } = await import('@/text');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { sync } = await import('@/sync/sync');
        const { AuthProvider } = await import('@/auth/context/AuthContext');
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const { createEmptyAccountBootstrapHttpResponse } = await import('@/dev/testkit/fixtures/accountBootstrapHttpBoundary');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { MachineCollectionRail } = await import('@/components/settings/machines/collection/MachineCollectionList');
        const { MachinePageHeader } = await import('@/components/machines/page/MachinePageHeader');
        const { MachineOverview } = await import('@/components/machines/page/MachineOverview');
        const { MachineDetailsSection } = await import('@/components/machines/details/MachineDetailsSection');
        const { MachinePageStateContext } = await import('@/components/machines/page/machinePageContext');
        const { useMachinePagePresenceTarget } = await import('@/components/machines/page/useMachinePageTarget');
        const { useManagedEnrolledMachine, useManagedMachineHeaderIdentity } = await import('@/components/settings/machines/managed/ManagedMachineSections');
        const { useServerScopedMachine } = await import('@/sync/domains/state/storage');
        const { CheckoutReachabilityLine, CheckoutReachabilityScope } = await import('@/components/workspaces/reachability/checkoutReachability');
        const launch = { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1,
            name: 'Retained studio', choices: {} };
        let managed: import('@happier-dev/protocol/machines/managed/managedMachineV1').ManagedMachineV1 = {
            id: 'managed-studio', homeId: serverIdentityId, custodianAccountId: 'project-account', launch,
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'machine-a',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} }, allocation: 'bound', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power: 'stopped', storage: 'retained' },
            reviewedFacts: { launch, controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
                billing: { location: 'local', stoppedBilling: 'not-billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        };
        let machine = createMachineFixture({ id: 'machine-a', active: false, activeAt: 1, presenceProtocolVersion: 1,
            metadata: { ...createMachineFixture().metadata!, displayName: launch.name },
            managedMachineRef: { homeId: serverIdentityId, managedId: managed.id },
            managedInputRuntime: { nativeReady: false, wakeState: null, state: 'asleep' },
        });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'project-account' };
        home.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [managed] } });
        home.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
        home.answer(serverId, '/v1/machines/pools/list', { body: { pools: [] } });
        const inventory = buildLocalServiceInventoryState({ rows: [] });
        const launcher = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1, machineId: machine.id, updatedAt: 1, targets: [],
        });
        const answerMachine = () => {
            const row = { ...createPlainMachineRowFixture({ id: machine.id, accountId: scope.accountId, machine }),
                managedInputRuntime: machine.managedInputRuntime };
            home.answer(serverId, '/v1/machines', { body: [row] });
            home.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine: row } });
        };
        answerMachine();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://project.example.test',
            serverIdentityId, accountId: scope.accountId,
            request: async (input, init) => {
                const response = await home.request(input, init);
                return response.status === 404
                    ? createEmptyAccountBootstrapHttpResponse(new URL(String(input)).pathname, init) ?? response
                    : response;
            },
        });
        const publishMachine = async () => {
            answerMachine();
            await sync.refreshMachines({ serverId: scope.serverId });
        };
        await publishMachine();
        expect(storage.getState().machines[machine.id], 'real HTTP Sync must hydrate the displayed Machine').toMatchObject({ id: machine.id });
        const reload = async () => {};
        function Detail() {
            const current = useServerScopedMachine(serverId, machine.id)!;
            const enrolled = useManagedEnrolledMachine({ serverId, enrolledMachineId: machine.id });
            const target = { machineId: current.id, requestedServerId: serverId, serverId, activeServerId: serverId,
                machine: current, machineName: launch.name, machineSentenceName: launch.name,
                isServerSwitching: false, isHydratingMachine: false, switchReady: true };
            const presenceTarget = useMachinePagePresenceTarget(target);
            const identity = useManagedMachineHeaderIdentity(enrolled.machine, serverId);
            return <MachinePageStateContext.Provider value={{ target, managedEnrolled: enrolled, refreshKey: 0, reload }}>
                <MachinePageHeader target={target} managedIdentity={identity} renaming={false} onRename={() => {}} />
                <MachineOverview serverId={serverId} machineId={machine.id} machineName={launch.name}
                    online={presenceTarget.online} params={{ id: 'overview' }} setParams={() => {}} />
            </MachinePageStateContext.Provider>;
        }
        function NativeDetails() {
            const current = useServerScopedMachine(serverId, machine.id)!;
            return <MachineDetailsSection machine={current} serverId={serverId} />;
        }
        const screen = await renderScreen(<AuthProvider initialCredentials={connection.credentials}>
            <View testID="runtime-rail"><MachineCollectionRail /></View>
            <View testID="runtime-detail"><Detail /></View>
            <View testID="runtime-services"><CheckoutReachabilityScope scope={{ serverId, machineId: machine.id }}>
                <CheckoutReachabilityLine scope={{ serverId, machineId: machine.id }} />
                <ProjectRightPanelServicesView serverId={serverId} machineId={machine.id} workspaceRoot="/repo"
                    presentation="page" inventoryState={inventory} launcherState={launcher} testID="runtime-services-pane" />
            </CheckoutReachabilityScope></View>
            <View testID="runtime-native-details"><NativeDetails /></View>
        </AuthProvider>);
        const text = (node: import('react-test-renderer').ReactTestInstance): string => node.children
            .map(child => typeof child === 'string' ? child : text(child)).join(' ');
        const allSay = async (word: string) => waitForHomeGovernance(async () => {
            await flushHookEffects();
            for (const surface of ['runtime-rail', 'machine-detail-header', 'runtime-services']) {
                expect(text(screen.findByTestId(surface)!), surface).toContain(word);
            }
        });
        // Input wake is disabled. Native parking is still Asleep in every surface, and merely
        // reading Services must neither wake it nor invent a second offline recovery.
        await allSay(t('managedPower.asleep'));
        expect(screen.findByTestId('runtime-services-pane-offline')).toBeNull();
        expect(screen.findByTestId('machine-vitals-offline')).toBeNull();
        // A retained fresh heartbeat cannot add a competing Online fact after native parking.
        machine = { ...machine, active: true, activeAt: Date.now() };
        await act(async () => { await publishMachine(); });
        await allSay(t('managedPower.asleep'));
        expect(screen.findByTestId('machine-detail-presence')).toBeNull();
        expect(screen.findByTestId('machine-detail-unavailable')).toBeNull();
        managed = { ...managed, submittedNativeEffect: { intent: 'start', intentRevision: managed.intentRevision, requestId: 'start-studio' },
            observation: { availability: 'present', observedAt: 2, power: 'stopped', storage: 'retained' } };
        const offlineAt = Date.now();
        machine = { ...machine, active: false, activeAt: offlineAt,
            managedInputRuntime: { nativeReady: false, wakeState: null, state: 'starting' } };
        home.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [managed] } });
        await act(async () => { await publishMachine(); publishHomeAccountChange(serverId); });
        await allSay(t('managedWake.starting', { machine: launch.name }));
        // Vendor Running is not proof that this Home can reach the guest. Desired Start alone
        // must not keep the rail Starting while the detail says Offline and Running.
        machine = { ...machine, managedInputRuntime: { nativeReady: true, wakeState: null, state: null } };
        await act(async () => { await publishMachine(); });
        // Public lifecycle settles before the protected list refreshes. The header must consume
        // that same result, rather than retain its previous native Starting word.
        await allSay(t('settingsOverview.machineOffline', { lastSeen: (await import('@/utils/sessions/sessionUtils')).formatLastSeen(offlineAt) }));
        managed = { ...managed, submittedNativeEffect: undefined,
            observation: { availability: 'present', observedAt: 3, power: 'running', storage: 'retained' } };
        home.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [managed] } });
        await act(async () => { await publishMachine(); publishHomeAccountChange(serverId); });
        await allSay(t('settingsOverview.machineOffline', { lastSeen: (await import('@/utils/sessions/sessionUtils')).formatLastSeen(offlineAt) }));
        expect(screen.findByTestId('machine-detail-managed-power')).toBeNull();
        expect(text(screen.findByTestId('machine-details-native-power')!)).toContain(t('managedMachines.detail.power.running'));
        expect(screen.findByTestId('runtime-services-pane-offline')).toBeNull();
        expect(rpc.machine.mock.calls.some(([request]) => request?.method?.includes('managed'))).toBe(false);
        await screen.unmount();
    });

    it('keeps same-name checkout descriptions separate across workspace and machine scope, retaining worker copies', async () => {
        const workspace = { serverId, machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const source = { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } as const;
        const inspection = ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(JSON.stringify({
                version: 1, services: { web: { source, execution: 'portable' } },
            })) },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            commands: [{ name: 'web', usage: 'service', source, availability: 'available', invocation: { tool: 'npm', args: ['run', 'dev'], cwd: '.' } }],
        });
        await answerExternalActionAccountForHome(home, serverId, {
            machineId: 'machine-a', actionId: 'projects.inspect', tokenEpoch: 0,
            requesterInvocation: 'none', execute: () => inspection,
        });
        rpc.machine.mockImplementation(async ({ method }) => {
            if (method === 'daemon.projects.inspect.v1') return inspection;
            throw new Error(`unexpected_rpc:${method}`);
        });
        const target = (id: string, machineId: string, workspaceRefId: string, rootPath: string) => LocalServiceLaunchTargetV1Schema.parse({
            id, source: 'managed_service', machineId, workspace: { ...workspace, machineId, workspaceId: workspaceRefId, rootPath },
            declaration: { workspaceRefId, selection: { kind: 'manifest', name: 'web' } }, title: 'web',
            confidence: 'high', state: 'available', serviceState: 'running', actions: ['manage'],
        });
        const own = target('own-web', 'machine-a', 'accepted', '/repo');
        const worker = target('worker-web', 'machine-b', 'worker-copy', '/worker');
        const foreign = { ...target('foreign-web', 'machine-a', 'other', '/other'), commandPreview: 'docker compose up web',
            declaration: { workspaceRefId: 'other', selection: { kind: 'native' as const,
                source: { kind: 'native' as const, tool: 'compose' as const, file: 'compose.yaml', target: 'web' } } } };
        const foreignManifest = { ...target('foreign-manifest-web', 'machine-a', 'third', '/third'), commandPreview: 'echo foreign' };
        const launcherSnapshotClient = vi.fn(async (input: { scope?: 'workspace' | 'machine' | null }) => ({ ok: true as const,
            snapshot: { v: 1 as const, machineId: 'machine-a', updatedAt: 1,
                targets: input.scope === 'machine' ? [own, worker, foreign, foreignManifest] : [own, worker] } }));
        const screen = await renderScreen(<ProjectRightPanelServicesView {...{ serverId }} machineId="machine-a"
            workspaceRefId="accepted" workspaceRoot="/repo" inventoryState={buildLocalServiceInventoryState({ rows: [] })}
            launcherSnapshotClient={launcherSnapshotClient} />);
        const text = (id: string) => {
            const row = screen.findByTestId(`project-rightpanel-services-row:${id}`);
            const collect = (node: { children: readonly unknown[] }): string => node.children.map(child => typeof child === 'string'
                ? child : collect(child as { children: readonly unknown[] })).join(' ');
            return row ? collect(row) : '';
        };
        // The real row boundary carries the full command; running rows may display only its executable.
        const row = (id: string): ServiceRow | undefined => screen.findAllByType(ServiceRowView)
            .find(node => node.props.row.target.id === id)?.props.row;
        await vi.waitFor(() => expect(row('own-web')).toMatchObject({ processLabel: 'npm run dev', sourceBadge: 'package.json' }));
        expect(text('own-web')).toContain('package.json');
        expect(row('worker-web')).toMatchObject({ processLabel: 'npm run dev', sourceBadge: 'package.json' });
        expect(text('worker-web')).toContain('package.json');
        expect(text('foreign-web')).toBe('');
        await screen.pressByTestIdAsync('project-rightpanel-services-scope-toggle:machine');
        await vi.waitFor(() => expect(row('foreign-web')).toMatchObject({ processLabel: 'docker compose up web', sourceBadge: 'compose.yaml' }));
        expect(text('foreign-web')).toContain('compose.yaml');
        expect(text('foreign-web')).not.toContain('package.json');
        expect(row('foreign-manifest-web')).toMatchObject({ processLabel: 'echo foreign', sourceBadge: 'project.json' });
        expect(text('foreign-manifest-web')).toContain('project.json');
        expect(text('foreign-manifest-web')).not.toContain('package.json');
        expect(row('own-web')).toMatchObject({ processLabel: 'npm run dev', sourceBadge: 'package.json' });
        expect(row('worker-web')).toMatchObject({ processLabel: 'npm run dev', sourceBadge: 'package.json' });
        await screen.unmount();
    });

    it.each([true, false])('answers a declared Service Start Ask through native review without granting the feed launch authority (accepted=%s)', async accepted => {
        const workspace = { serverId, machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const target = { id: 'declared:web', source: 'managed_service' as const, machineId: workspace.machineId,
            workspace, declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest' as const, name: 'web' } },
            title: 'Web', confidence: 'high' as const, state: 'unavailable' as const, unavailableReason: 'launch_unavailable', actions: [] };
        await home.requireUiApproval(serverId, 'localServices.launcher.start');
        const readApprovalPreference = () => readExplicitActionApprovalPreferenceV1('localServices.launcher.start',
            storage.getState().settings.actionsSettingsV1, { surface: 'ui' });
        expect(readApprovalPreference()).toBe(true);
        await installOwnMachineApprovalReplayBoundary({ harness: home, serverId, accountId: 'project-account', machineId: workspace.machineId,
            runtimeActionExecute: createDefaultRuntimeActionExecutor() });
        const running = { ...target, state: 'available' as const, serviceState: 'running' as const, actions: ['manage' as const] };
        rpc.machine.mockImplementation(async ({ method, payload }) => {
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT && payload.startReview) {
                // Native review resolves the effect independently of the feed's launch suggestion.
                // The preceding placement read must retain the Account's Ask preference.
                expect(readApprovalPreference()).toBe(true);
                const request = DaemonLocalServiceLauncherStartRequestV1Schema.parse(payload.startReview.request);
                return DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse({ protocolVersion: 1,
                    snapshot: { v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [target] },
                    startReview: { request, target: workspace, reviewedEffect: { command: 'echo web' },
                        reviewedEffectDigest: 'b'.repeat(64), setup: { required: false,
                            project: { serverId, projectId: workspace.workspaceId },
                            reviewedEffect: { commands: [] }, reviewedEffectDigest: 'a'.repeat(64) } },
                });
            }
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) return DaemonLocalServiceLauncherStartResponseV1Schema.parse({
                protocolVersion: 1, machineId: workspace.machineId, targetId: target.id, status: 'succeeded',
                snapshot: { v: 1, machineId: workspace.machineId, updatedAt: 2, targets: [running] },
            });
            throw new Error(`unexpected_rpc:${method}`);
        });
        const screen = await renderScreen(<ModalProvider><ProjectRightPanelServicesView machineId={workspace.machineId} serverId={serverId}
            inventoryState={buildLocalServiceInventoryState({ rows: [] })}
            launcherState={applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
                v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [target],
            })} /></ModalProvider>);
        try {
            const start = screen.pressByTestIdAsync('project-rightpanel-services-row:declared:web-start');
            await vi.waitFor(() => expect(rpc.machine.mock.calls.some(([request]) =>
                request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT && request.payload.startReview)).toBe(true));
            await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
            expect(rpc.machine.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START))
                .toHaveLength(0);
            await screen.pressByTestIdAsync(`actions.confirmation-review.decision-${accepted ? 'approve' : 'reject'}`);
            await start;
            expect(readApprovalPreference()).toBe(true);
            expect(home.artifacts(serverId).list()).toEqual([]);
            expect(navigation.push).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(rpc.machine.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START))
                .toHaveLength(accepted ? 1 : 0));
            expect(modalAlertMock).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it('routes a real daemon Setup refusal through the Action front door into retained preparation and its command review', async () => {
        const workspace = { serverId, machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'project-account' };
        storage.setState({ projectAccountRows: createProjectAccountRowsFixture(scope, { workspaceRefs: [
            { id: workspace.workspaceId, ...workspace, createdAtMs: 1, projectKey: 'project' },
        ] }) });
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'], 'projects.prepare': ['ui'] },
        } }), 2);
        const consent = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'a'.repeat(64),
            reviewedEffect: { v: 1, purpose: 'setup', commands: [{ kind: 'command', command: 'echo setup', cwd: '.', os: 'linux' }] } } as const;
        const held = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'service-preparation', revision: 1,
            actionId: 'projects.prepare', state: 'accepted', scope: { accountId: scope.accountId, machineId: workspace.machineId },
            title: 'Setup', createdAt: 1, cancellation: 'supported', setupReview: consent,
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId, machineId: workspace.machineId,
                workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace } });
        const target = { id: 'declared:web', source: 'managed_service' as const, machineId: workspace.machineId,
            workspace, declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest' as const, name: 'web' } },
            title: 'Web', confidence: 'high' as const, state: 'unavailable' as const, unavailableReason: 'launch_unavailable', actions: [] };
        // Finite preparation uses the captured Home's HTTP Action admission, not ambient RPC.
        const machine = ExternalActionMachineBootstrapV1Schema.parse({ id: workspace.machineId,
            kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
            installationId: 'service-machine-installation', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            runnerContentKeyBinding: null, access: { custodian: { accountId: scope.accountId, displayName: 'Project account' },
                role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
        const machineRow = { ...createPlainMachineRowFixture({ id: machine.id, accountId: scope.accountId }),
            installationId: machine.installationId };
        home.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine: machineRow } });
        home.answer(serverId, '/v1/actions/projects.prepare/execution-authorization', { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'finite-setup-root', binding: {
                accountId: scope.accountId, authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
                machineId: machine.id, installationId: machine.installationId, custodianAccountId: scope.accountId,
                accountEncryptionMode: 'plain', actionId: 'projects.prepare', requestId: request.envelope.requestId,
                target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } }) };
        } });
        home.answer(serverId, '/v1/actions/projects.prepare', { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.prepare',
                requestId: request.envelope.requestId, execution: { ok: true,
                    result: ProjectCommandActionOutputV1Schema.parse({ operation: held }) } }) };
        } });
        rpc.machine.mockImplementation(async ({ method }) => {
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) return DaemonLocalServiceLauncherStartResponseV1Schema.parse({
                protocolVersion: 1, machineId: workspace.machineId, targetId: target.id, status: 'denied',
                reasonCode: consent.code, reviewedEffect: consent.reviewedEffect, reviewedEffectDigest: consent.reviewedEffectDigest,
                snapshot: { v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [target] },
            });
            if (method === ACTION_OPERATION_RPC_METHODS_V2.get) return { kind: 'found', operation: held };
            if (method === ACTION_OPERATION_RPC_METHODS_V2.list) return { items: [held], nextCursor: null };
            throw new Error(`unexpected_rpc:${method}`);
        });
        const frontDoor = createFrontDoorRuntimeActionExecutor();
        const execute = Object.assign(vi.fn(frontDoor), { actionExecute: frontDoor.actionExecute });
        const screen = await renderScreen(<ProjectRightPanelServicesView machineId={workspace.machineId} serverId={serverId} runtimeActionExecute={execute}
            inventoryState={buildLocalServiceInventoryState({ rows: [] })}
            launcherState={applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
                v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [target],
            })} />);
        await flushHookEffects();
        screen.pressByTestId('project-rightpanel-services-row:declared:web-start');
        await vi.waitFor(() => expect(screen.findByTestId('project-rightpanel-services-setup-review-approve')).toBeTruthy());
        expect(screen.getTextContent()).toContain('echo setup');
        expect(modalAlertMock).not.toHaveBeenCalled();
        const startRequest = rpc.machine.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START)?.[0];
        // Submitted Start outlives the issuing view; native preparation has no shorter caller deadline.
        expect(startRequest).toMatchObject({ operationTimeoutMs: null });
        expect(startRequest?.signal).toBeUndefined();
        expect(home.requestsFor('/v1/actions/projects.prepare').map(request =>
            ExternalActionRequestEnvelopeV1Schema.parse(ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.input).envelope).input))
            .toEqual([{ workspace: { ...workspace, serverId: serverIdentityId }, phase: 'setup' }]);
        await screen.unmount();
    });

    it.each(['project', 'session', 'session-page'] as const)('offers the retained service terminal in its %s output scope', async (surface) => {
        const workspace = { serverId, machineId: 'machine-a', workspaceId: 'service-workspace', rootPath: '/repo' };
        const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1, machineId: workspace.machineId, updatedAt: 3_000,
            targets: [LocalServiceLaunchTargetV1Schema.parse({
                id: 'project-service:web', source: 'managed_service',
                sourceClass: { kind: 'managed_service', managedServiceId: 'service-web' },
                machineId: workspace.machineId, workspaceId: workspace.workspaceId, workspace, cwd: workspace.rootPath,
                title: 'Web', confidence: 'high', state: 'available', serviceState: 'healthy', actions: ['manage'],
                terminalView: { kind: 'terminal_view', machineId: workspace.machineId, terminalId: 'retained-web',
                    terminalKey: 'owned-qa-service', cwd: workspace.rootPath, workspace, interactive: true },
            })],
        });
        const props = { serverId, machineId: workspace.machineId, outputScopeId: 'project:service-workspace',
            inventoryState: buildLocalServiceInventoryState({ rows: [] }), launcherState };
        const screen = await renderScreen(<ModalProvider>{surface === 'project'
            ? <ProjectRightPanelServicesView {...props} />
            : surface === 'session' ? <SessionRightPanelServicesView {...props} />
                : <SessionServicesSurfaceScreen {...props} />}</ModalProvider>);
        await flushHookEffects();
        const prefix = surface === 'session-page' ? 'session-mobile-services' : `${surface}-rightpanel-services`;
        await pressTestInstanceAsync(screen.findByTestId(`${prefix}-row:project-service:web-overflow`), 'service overflow');
        expect(screen.findByTestId('stop')).toBeTruthy();
        expect(screen.findByTestId('show-terminal')).toBeTruthy();
        await screen.unmount();
    });

    it('passes supplied local service launcher state into the Services pane', async () => {
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
    });

    it('mounts one body on the Services page and the rail: only the page leads with its purpose', async () => {
        const page = await renderScreen(
            <ProjectRightPanelServicesView
                presentation="page"
                testID="project-services-page"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        expect(page.findByTestId('project-services-page-header')).toBeTruthy();
        expect(page.getTextContent()).toContain('Long-running services for this checkout');
        expect(page.findByTestId('project-services-page-row:inventory:project-feed')).toBeTruthy();
        await page.unmount();

        const rail = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        expect(rail.findAllByTestId('project-rightpanel-services-header')).toHaveLength(0);
        expect(rail.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
    });

    it('does not poll public preview status when public previews are disabled', async () => {
        await publishFeatures(serverId, false);
        const publicPreviewStatusClient = vi.fn(async () => ({
            ok: false as const,
            reason: 'unavailable' as const,
        }));

        await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                publicPreviewStatusClient={publicPreviewStatusClient}
            />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(publicPreviewStatusClient).not.toHaveBeenCalled();
    });

    it('builds a launcher start runtime action request without requiring session context', async () => {
        rpc.machine.mockResolvedValue(DaemonLocalServiceLauncherStartResponseV1Schema.parse({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'inventory:project-feed',
            status: 'succeeded',
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                updatedAt: 4_000,
                targets: [],
            },
        }));
        const frontDoor = createFrontDoorRuntimeActionExecutor();
        const runtimeActionExecute = Object.assign(vi.fn(frontDoor), { actionExecute: frontDoor.actionExecute });
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        // Let the real asynchronous credential binding publish before user ingress.
        await flushHookEffects();
        await pressTestInstanceAsync(
            screen.findByTestId('project-rightpanel-services-row:inventory:project-feed-start'),
            'project-rightpanel-services-row:inventory:project-feed-start',
        );

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine-a',
                targetId: 'inventory:project-feed',
            },
            context: {
                serverId,
                expectedAccountId: 'project-account',
                surface: 'ui',
            },
        });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId, machineId: 'machine-a', method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            payload: { machineId: 'machine-a', targetId: 'inventory:project-feed' },
        }));
        await expect(runtimeActionExecute.mock.results[0]!.value).resolves.toMatchObject({
            protocolVersion: 1, machineId: 'machine-a', targetId: 'inventory:project-feed',
            status: 'succeeded', snapshot: { targets: [] },
        });
    });

    it('creates a public preview through the real Services Action host under the Account UI approval waiver', async () => {
        rpc.machine.mockResolvedValue(DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse({
            protocolVersion: 1,
            exposure: {
                exposureId: 'public-preview-1',
                previewId: publicPreviewId,
                sessionId: 'session-a',
                machineId: 'machine-a',
                mode: 'secret_link',
                state: 'active',
                publicUrl: 'https://preview.example.test/public-preview-1',
                issuedAt: 4_000,
                expiresAt: 604_000,
                auditEventIds: ['audit-1'],
                rateLimitProfileId: 'default',
            },
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: publicPreviewId,
                generatedAt: 4_000,
                refreshState: 'idle',
                policy: {
                    enabled: true,
                    allowedModes: ['secret_link'],
                    maxTtlMs: 600_000,
                    maxConcurrentExposures: 2,
                    dnsTlsRequired: true,
                    auditRequired: true,
                    rateLimitProfileIds: ['default'],
                },
                exposures: [],
                diagnostics: [],
            },
        }));
        const frontDoor = createFrontDoorRuntimeActionExecutor();
        const runtimeActionExecute = Object.assign(vi.fn(frontDoor), { actionExecute: frontDoor.actionExecute });
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildPublicPreviewLauncherState()}
                publicPreviewState={buildPublicPreviewState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await screen.pressByTestIdAsync('project-rightpanel-services-row:inventory:project-feed-item');
        await flushHookEffects();
        await screen.pressByTestIdAsync('project-rightpanel-services-row:inventory:project-feed-share');
        await flushHookEffects();

        expect(modalShowMock).not.toHaveBeenCalled();
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: publicPreviewId,
                mode: 'secret_link',
                ttlMs: 600_000,
                confirmation: { acknowledged: true },
            },
            context: {
                serverId,
                expectedAccountId: 'project-account',
                signal: expect.any(AbortSignal),
                surface: 'ui',
            },
        });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId, machineId: 'machine-a', method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            payload: expect.objectContaining({ previewId: publicPreviewId, sessionId: 'session-a',
                mode: 'secret_link', ttlMs: 600_000, confirmation: { acknowledged: true } }),
        }));
        await expect(runtimeActionExecute.mock.results[0]!.value).resolves.toMatchObject({
            protocolVersion: 1, exposure: { exposureId: 'public-preview-1', previewId: publicPreviewId,
                publicUrl: 'https://preview.example.test/public-preview-1' },
        });
    });
});
