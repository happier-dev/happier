import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createServerAccountConnectionProbeHttpResponse, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest, publishMachineActivityForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessHttpResponse } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createMachineProvisionerOptionsFixture, createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { storage } from '@/sync/domains/state/storage';
import { createDeferred, flushHookEffects, pressTestInstanceAsync, renderHook, renderScreen as renderTestScreen } from '@/dev/testkit';
import { AccountNoticeInvestigationBoundary } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { useManagedMachineInventory } from './useManagedMachineInventory';
import { useManagedCreationScopeBirth } from './useManagedCreationScopeBirth';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch as installRuntimeFetch } from '@/utils/system/runtimeFetch';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { ManagedMachineDetail } from './ManagedMachineDetail';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

/** Pages render under the app shell, which owns the Account's one Investigate owner (D5). */
const renderScreen: typeof renderTestScreen = (element, options = {}) => {
    const Outer = options.wrapper;
    return renderTestScreen(element, { ...options, wrapper: Outer
        ? ({ children }) => <AccountNoticeInvestigationBoundary><ListPresentationProvider value="page"><Outer>{children}</Outer></ListPresentationProvider></AccountNoticeInvestigationBoundary>
        : ({ children }) => <AccountNoticeInvestigationBoundary><ListPresentationProvider value="page">{children}</ListPresentationProvider></AccountNoticeInvestigationBoundary> });
};
import { t } from '@/text';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { openExternalActionRequesterAccountContextV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ManagedCreationProgress } from './ManagedCreationProgress';
import { ManagedMachineSections, ManagedMachineResizeResult, ManagedEnrolledMachineSections, useManagedMachineHeaderIdentity, type ManagedMachineHeaderIdentity } from './ManagedMachineSections';
import { ManagedReceiptPageLayout } from './ManagedReceiptPageLayout';
import { ManagedMachinePolicySection, ManagedMachineControllerSection, ManagedControllerMoveList } from './ManagedMachineDetailSections';
import { MachineConfigurationReceipt } from './MachineConfigurationReceipt';
import { ManagedMachineFullV1Schema, ManagedMachineV1Schema, type ManagedMachineFullV1, type ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedResizeOutputV1Schema, MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema, ManagedControlAdmissionInputV1Schema, ManagedAdmissionOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetGetResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/public-types';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
    ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1, projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { resolveHref } from 'expo-router/build/link/href';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import sodium from 'libsodium-wrappers';
import { ACTION_OPERATION_RPC_METHODS_V2, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import { readOriginalAccountActionMachine, readOriginalAccountActionAuthentication } from '@/sync/api/externalActionAccountTransport';
import { Modal, ModalProvider } from '@/modal';
import { Dimensions, Text } from 'react-native';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRetentionDuration } from './managedRetentionPresentation';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { ManagedCreationScopeRuleSection } from './ManagedCreationScopeRuleSection';
import { ManagedScopeRuleRow } from './ManagedMachineDetailSections';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ManagedMachineStateRow } from './ManagedMachineStateRow';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { MachineProvisionersListResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionRecordSchema, encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';
import { commitWebServerUrlOverride } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { resolveCompactAppDestinations, resolveDestinationRefFromHref } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { WorkspaceRouteBody as ManagedMachineRouteBody } from '@/app/(app)/machines/managed/[id]';
import { WorkspaceRouteBody as SettingsManagedMachineRouteBody } from '@/app/(app)/settings/machines/managed/[id]';
import { MachinePageScreen } from '@/components/machines/page/MachinePageScreen';
import { MachineSubPageScreen } from '@/components/machines/page/MachineSubPageScreen';
import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { resolveActionTitle } from '@/text/actionTitles';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ConnectedPresentationRowReadResponseV1Schema, ConnectedAcknowledgementsRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

const operationRpcBoundary = vi.hoisted(() => ({ answer: null as unknown, registryAnswer: null as unknown, schemaAnswer: null as unknown,
    handler: null as ((request: { method: string; payload: unknown }) => unknown) | null,
    requests: [] as Array<Readonly<{ serverId?: string | null; accountId?: string | null; machineId: string; method: string }>> }));
let restoreActionExecutorModuleLoader: (() => void) | undefined;
// The same physical browser storage must exist before Sync/profile consumers
// capture their adapter, then be reactivated after the global Node reset.
const browser = await installBrowserRuntimeForTests({ url: 'https://managed-detail-ui.test/' });
await sodium.ready;
const controllerInstallationPublicKey = encodeBase64(sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(11)).publicKey, 'base64');
const httpFacts: Array<Readonly<{ path: string; status: number }>> = [];
function setRuntimeFetch(fetch: Parameters<typeof installRuntimeFetch>[0]) {
    installRuntimeFetch(async (input, init) => {
        const path = new URL(String(input)).pathname;
        // These fixtures are current plain Accounts. Keep their currentness wire
        // separate from the deliberately strict legacy mode responses below.
        const response = createServerAccountConnectionProbeHttpResponse(path)
            ?? createPlainAccountEncryptionCurrentnessHttpResponse(path) ?? await fetch(input, init);
        httpFacts.push({ path, status: response.status });
        return response;
    });
}
// Match the app entry before routes consume the public Sync handle. Native
// network/Socket boundaries below remain the only substituted runtime effects.
await loadSyncSingletonForTests();
beforeEach(async ({ onTestFailed }) => {
    httpFacts.length = 0;
    onTestFailed(() => console.error('managed_detail_http_facts', httpFacts));
    browser.activate();
    browser.storage.clear();
    browser.window.sessionStorage.clear();
    restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
});

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
// ReactTestRenderer cannot host the web portal opened by the real retention menu.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module;
});
vi.mock('@/text', async () => await vi.importActual<typeof import('@/text')>('@/text'));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async params => {
        operationRpcBoundary.requests.push({ serverId: params.serverId, accountId: params.accountId, machineId: params.machineId, method: params.method });
        const handled = operationRpcBoundary.handler?.(params);
        if (handled !== undefined) return handled;
        if (params.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)
            return operationRpcBoundary.schemaAnswer ?? { ok: true, inputSchema: { type: 'object', additionalProperties: true } };
        if (params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE && operationRpcBoundary.registryAnswer)
            return operationRpcBoundary.registryAnswer;
        return operationRpcBoundary.answer ?? { items: [], nextCursor: null };
    });
});
afterEach(() => {
    restoreActionExecutorModuleLoader?.();
    retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    operationRpcBoundary.answer = null; operationRpcBoundary.registryAnswer = null; operationRpcBoundary.schemaAnswer = null;
    operationRpcBoundary.handler = null;
    resetMachineProjectionReadsForTests();
    operationRpcBoundary.requests = []; actionOperationStore.reset();
});
afterAll(() => browser.restore());

/** Exact Home read boundary: the declared native controllers exist independently of the UI's loaded list. */
function managedControllerReadBatch(machine: ManagedMachineReadSnapshotV1, url: URL, init?: RequestInit,
    controllers: readonly NonNullable<ManagedMachineReadSnapshotV1['controller']>[] = machine.controller ? [machine.controller] : []): Response | null {
    if (url.pathname !== '/v1/machines/read-batch') return null;
    return createMachineReadBatchResponseFixture(init?.body, id => {
        const controller = controllers.find(candidate => candidate.machineId === id);
        return controller ? { ...createPlainMachineRowFixture({ id, accountId: machine.custodianAccountId }),
            installationId: controller.installationId, installationPublicKey: controllerInstallationPublicKey } : null;
    });
}

/** Home's signed-root HTTP issuer; confirmation and policy stay in the real executors. */
function managedControllerAuthorization(machine: ManagedMachineReadSnapshotV1, url: URL, init?: RequestInit,
    controllers: readonly NonNullable<ManagedMachineReadSnapshotV1['controller']>[] = machine.controller ? [machine.controller] : []): Response | null {
    if (!url.pathname.startsWith('/v1/actions/') || !url.pathname.endsWith('/execution-authorization')) return null;
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
    const controller = controllers.find(value => value.machineId === request.machineId);
    if (!controller) throw new Error('Unknown controller at fixture issuer');
    const actionId = ActionIdSchema.parse(url.pathname.slice('/v1/actions/'.length, -'/execution-authorization'.length));
    return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-native-authorization', binding: {
        accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: machine.homeId,
        machineId: controller.machineId, installationId: controller.installationId, custodianAccountId: machine.custodianAccountId,
        accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId, target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
    } }));
}

function readNativeControllerRequest(init?: RequestInit) {
    const body: unknown = JSON.parse(String(init?.body));
    const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
    return ExternalActionRequestEnvelopeV1Schema.parse(carrier.success ? carrier.data.envelope : body);
}

/** Native HTTP boundary for tests whose current provisioner declares static capabilities. */
function staticRetentionQualification(machine: ManagedMachineFullV1, url: URL, init?: RequestInit,
    supportedIntents: NonNullable<ManagedMachineReadSnapshotV1['reviewedFacts']>['retentionCapabilities']['supportedIntents'] = ['start', 'stop', 'delete']): Response | null {
    const machines = managedControllerReadBatch(machine, url, init);
    if (machines) return machines;
    const authorization = managedControllerAuthorization(machine, url, init);
    if (authorization) return authorization;
    const actionId = url.pathname === '/v1/actions/machines.provisioners.list' ? 'machines.provisioners.list'
        : url.pathname === '/v1/actions/machines.provisioners.check' ? 'machines.provisioners.check' : null;
    if (!actionId) return null;
    const request = readNativeControllerRequest(init);
    const result = actionId === 'machines.provisioners.list' ? MachineProvisionersListResultV1Schema.parse({
        provisioners: [{ contribution: machine.launch.provider, occurrenceId: 'static-native-occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: machine.launch.provider.localId, title: 'Static native resource', icon: 'server',
            resourceKind: 'static-native-resource', schemaVersion: machine.launch.schemaVersion,
            launchSchema: { type: 'object', properties: { cpu: { type: 'integer' }, image: { type: 'string' } }, additionalProperties: false },
            resourceSchema: { type: 'object', properties: { resourceId: { type: 'string' } }, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: machine.reviewedFacts?.billing ?? { location: 'cloud', stoppedBilling: 'billed' },
            retention: { supportedIntents },
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
        } }],
    }) : { available: true };
    return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, requestId: request.requestId, actionId,
        execution: { ok: true, result } }));
}

describe('managed Machine detail', () => {
    it.each(['opaque', 'native'] as const)('presents a %s resize refusal without inventing a private reason', async form => {
        const output = ManagedResizeOutputV1Schema.parse(form === 'opaque'
            ? { result: { kind: 'refused' }, presetContent: { t: 'plain', v: { privateReason: 'not disclosed' } } }
            : { result: { kind: 'refused', code: 'provider_resize_refused' } });
        const screen = await renderScreen(<ManagedMachineResizeResult output={output} />);
        try {
            const card = screen.tree.findByType(SurfaceStateCard);
            expect(card.props.title).toBe(form === 'opaque' ? t('common.unavailable') : 'provider_resize_refused');
            expect(card.props.diagnosticCode).toBe(form === 'opaque' ? undefined : 'provider_resize_refused');
            expect(screen.getTextContent()).not.toContain('not disclosed');
        } finally { await screen.unmount(); }
    });

    it.each([
        { enrolled: true, availability: 'present', checkAvailable: false },
        { enrolled: false, availability: 'present', checkAvailable: true },
        { enrolled: true, availability: 'unavailable', checkAvailable: true },
    ] as const)('shows a Use member the managed policy without owner-only power, delete, or policy editors (enrolled: $enrolled; observation: $availability)', async ({ enrolled, availability, checkAvailable }) => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-shared-use.test', scope: 'tab' });
        const homeId = 'srv_managed_shared_use';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('viewer', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        const controller = { machineId: 'shared-controller', installationId: 'installation' };
        const launch = { provider, schemaVersion: 1, name: 'Shared sandbox', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'shared-created', homeId, custodianAccountId: 'owner', launch, controller,
            allocation: 'bound', creationState: 'active', ...(enrolled ? { enrolledMachineId: 'shared-guest' } : {}),
            observation: availability === 'present' ? { observedAt: 1, availability, power: 'running' } : { observedAt: 1, availability },
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'local', stoppedBilling: 'not-billed' },
                prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const access = { custodian: { accountId: 'owner', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } as const;
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [
            createMachineFixture({ id: controller.machineId, installationId: controller.installationId, isShared: true, access }),
            createMachineFixture({ id: 'shared-guest', isShared: true, access }),
        ] } });
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(enrolled
            ? <ManagedEnrolledMachineSections serverId={target.id} enrolledMachineId="shared-guest" />
            : <ManagedMachineDetail serverId={target.id} managedId={machine.id} />);
        try {
            await flushHookEffects({ cycles: 30 });
            expect(screen.findByTestId('managed-machine.detail')).not.toBeNull();
            expect(screen.findByTestId('managed-machine.start')).toBeNull();
            expect(screen.findByTestId('managed-machine.stop')).toBeNull();
            expect(screen.findByTestId('managed-machine.delete')).toBeNull();
            expect(screen.findByTestId('managed-machine.cancel')).toBeNull();
            expect(screen.findByTestId('managed-machine.policy.keep')).toBeNull();
            expect(screen.findByTestId('managed-machine.policy.whenUnused')).not.toBeNull();
            const policyRow = screen.tree.findAllByType(Item).find(item => item.props.testID === 'managed-machine.policy.whenUnused');
            expect(policyRow?.props.mode).toBe('info');
            expect(policyRow?.props.onPress).toBeUndefined();
            const check = screen.tree.findAllByType(RoundButton).find(button => button.props.title === t('managedMachines.inspect.checkNow'));
            if (checkAvailable) {
                expect(check).toBeDefined();
                expect(check?.props.disabled).not.toBe(true);
            } else expect(check).toBeUndefined();
        } finally { await screen.unmount(); }
    });
    it.each([
        { requester: 'viewer', deletable: true },
        { requester: 'other-member', deletable: false },
    ] as const)('offers Delete to the member who created a Team container, never power or Archive (requester: $requester)', async ({ requester, deletable }) => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-member-delete.test', scope: 'tab' });
        const homeId = 'srv_managed_member_delete';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('viewer', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        // The Team owner's controller stays private to the member: it is not in the member's machine list.
        const controller = { machineId: 'owner-controller', installationId: 'installation' };
        const launch = { provider, schemaVersion: 1, name: 'Team container', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'member-created', homeId, custodianAccountId: 'owner', enrollmentAccountId: requester,
            launch, controller, allocation: 'bound', creationState: 'active', enrolledMachineId: 'member-guest',
            observation: { observedAt: 1, availability: 'present', power: 'running' },
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'local', stoppedBilling: 'not-billed' },
                prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'member-guest' })] } });
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedEnrolledMachineSections serverId={target.id} enrolledMachineId="member-guest" />);
        try {
            await flushHookEffects({ cycles: 30 });
            expect(screen.findByTestId('managed-machine.detail')).not.toBeNull();
            expect(screen.findByTestId('managed-machine.stop')).toBeNull();
            expect(screen.findByTestId('managed-machine.resize')).toBeNull();
            expect(screen.findByTestId('managed-machine.remove')).toBeNull();
            const remove = screen.findByTestId('managed-machine.delete');
            if (!deletable) { expect(remove).toBeNull(); return; }
            expect(remove).not.toBeNull();
            expect(remove?.props.disabled).not.toBe(true);
            await act(async () => { remove?.props.onPress(); });
            await flushHookEffects({ cycles: 30 });
            // Delete opens the same dependency review and confirmation the owner gets.
            expect(screen.findByTestId('managed-machine.delete-review')).not.toBeNull();
            expect(screen.findByTestId('managed-machine.delete-confirm')?.props.disabled).not.toBe(true);
        } finally { await screen.unmount(); }
    });
    it('renders an Account-owned Machine without inventing a managing computer', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-account-detail.test', scope: 'tab' });
        const homeId = 'srv_managed_account_detail';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner') });
        const machine = ManagedMachineFullV1Schema.parse({ id: 'account-owned', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Account guest', choices: {} },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'account-native' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [] } });
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail serverId={target.id} managedId={machine.id} />);
        try {
            await flushHookEffects({ cycles: 30 });
            expect(screen.findByTestId('managed-machine.detail')).not.toBeNull();
            expect(screen.findByTestId('managed-machine.controller')).toBeNull();
            expect(screen.findByTestId('managed-machine.controller.pending')).toBeNull();
            expect(screen.findByTestId('managed-machine.controller-unavailable')).toBeNull();
        } finally { await screen.unmount(); }
    });
    it('keeps an unreadable preset Machine visible with Retry instead of opening private receipt controls', async () => {
        const machine = ManagedMachineV1Schema.parse({ id: 'opaque-unreadable', homeId: 'home-unreadable', custodianAccountId: 'owner',
            preset: { id: 'preset-unreadable', revision: 1, contentEncryptionMode: 'e2ee' },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const onChanged = vi.fn();
        const screen = await renderScreen(<ManagedMachineSections machine={machine} serverId="server-unreadable" current
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} onChanged={onChanged} onDenied={() => {}} />);
        try {
            const state = screen.tree.findAllByType(SurfaceStateCard).find(row => row.props.diagnosticCode === 'content_unavailable');
            expect(state?.props.kind).toBe('unavailable');
            expect(screen.findByTestId('managed-machine.resize')).toBeNull();
            expect(screen.findByTestId('managed-machine.delete')).toBeNull();
            await act(async () => state?.props.action.onPress());
            expect(onChanged).toHaveBeenCalledOnce();
        } finally { await screen.unmount(); }
    });
    it('renders the Machine picker mark when a retained preset body cannot be opened', async () => {
        const { MachineRowMark } = await import('@/components/sessions/new/components/machineSelection/MachineSelectionRowAccessory');
        const machine = ManagedMachineV1Schema.parse({ id: 'opaque-picker', homeId: 'home-unreadable', custodianAccountId: 'owner',
            preset: { id: 'preset-unreadable', revision: 1, contentEncryptionMode: 'e2ee' },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const screen = await renderScreen(<MachineRowMark machineId={machine.id} serverId="server-unreadable" size={17} managedMachine={machine} />);
        try { expect(screen.tree.findByType(MachineRowMark).props.managedMachine).toBe(machine); }
        finally { await screen.unmount(); }
    });
    it('offers Resize from the managed receipt without changing the machine before review', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-resize-detail.test', scope: 'tab' });
        const homeId = 'srv_managed_resize_detail';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id },
            { token: createAccountTokenForTests('owner') });
        const machine = ManagedMachineFullV1Schema.parse({ id: 'resize-reviewed', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build guest', choices: {} },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 3,
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [] } });
        const resizeRequests: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (path === '/v1/actions/machines.managed.resize') resizeRequests.push(JSON.parse(String(init?.body)));
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail serverId={target.id} managedId={machine.id} />);
        await flushHookEffects({ cycles: 30 });
        expect(screen.findByTestId('managed-machine.resize')).not.toBeNull();
        await screen.pressByTestIdAsync('managed-machine.resize');
        expect(screen.findByTestId('managed-machine.resize-review')).not.toBeNull();
        expect(resizeRequests).toEqual([]);
    });
    it.each(['opaque', 'legacy'] as const)('prepares an Account-hosted %s preset resize at the real Action boundary', async form => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-opaque-resize-detail.test', scope: 'tab' });
        const homeId = 'srv_managed_opaque_resize_detail';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        const token = createAccountTokenForTests('owner', { currentAccount: true });
        expect(readOriginalAccountActionAuthentication(token)).toEqual({ kind: 'account', tokenEpoch: 0 });
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id },
            { token });
        const { PLUGIN_MANIFEST } = await import('@/dev/testkit/fixtures/managedAccountSsh');
        const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
        const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
        const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
        const provisioner = manifest.contributes.machineProvisioners?.[0];
        if (!provisioner?.resize?.cpuCores || !provisioner.actions.resize) throw new Error('Expected the Account resize provisioner');
        const restoreBundles = installBundledPluginUiDeclarationsForTests([{
            pluginId: manifest.id, pluginVersion: manifest.version, packageName: '@acme/cloud-ssh',
            displayName: 'Cloud SSH', hasMachineProvisioners: true, entriesById: {}, normalizedManifest: manifest,
        }]);
        onTestFinished(restoreBundles);
        const provider = { pluginId: manifest.id, localId: provisioner.id };
        const launch = { provider, schemaVersion: provisioner.schemaVersion,
            name: 'Private Cloud SSH guest', choices: { region: 'ams' } } as const;
        const opaque = {
            machine: {
                id: 'opaque-resize-reviewed', homeId, custodianAccountId: 'owner',
                preset: { id: 'opaque-resize-preset', revision: 7, contentEncryptionMode: 'plain' as const },
                allocation: 'bound' as const, creationState: 'active' as const, desired: 'start' as const,
                desiredWhen: 'now' as const, intentRevision: 3, retention: { kind: 'until-delete' as const },
                wakeOnAcceptedMessage: false,
            },
            presetContent: {
                content: { t: 'plain' as const, v: {
                    v: 1 as const, name: 'Private preset name', launch,
                    reviewedFacts: { launch, optionStatus: 'current' as const, prerequisites: [],
                        billing: provisioner.billing, retentionCapabilities: provisioner.retention,
                        retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false },
                    nativeResult: { kind: 'bound' as const, resource: { contributionRef: launch.provider,
                        schemaVersion: launch.schemaVersion, value: { id: 'private-cloud-ssh' } } },
                    observation: { observedAt: 1, availability: 'present' as const, power: 'running' as const,
                        size: { cpuCores: 2 } },
                } },
                recipientEnvelope: null,
            },
        };
        const read = form === 'opaque' ? opaque : { ...opaque.machine,
            launch, reviewedFacts: opaque.presetContent.content.v.reviewedFacts,
            resource: opaque.presetContent.content.v.nativeResult.resource,
            observation: opaque.presetContent.content.v.observation };
        const refreshedRead = { ...opaque, machine: { ...opaque.machine,
            preset: { ...opaque.machine.preset, revision: 8 } },
            presetContent: { ...opaque.presetContent, content: { ...opaque.presetContent.content,
                v: { ...opaque.presetContent.content.v, name: 'Newer unreviewed preset body' } } } };
        let refreshed = false;
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [] } });
        const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection,
            clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        onTestFinished(clearPluginAccountAvailabilityProjection);
        const scope = { serverId, accountId: 'owner' };
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const declarations = await readPluginAccountAvailability(scope).ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
        expect(declarations).toMatchObject({ kind: 'available' });
        expect(declarations.kind === 'available' && declarations.declarations.some(declaration =>
            declaration.manifest.id === manifest.id && declaration.manifest.contributes.machineProvisioners?.some(candidate =>
                candidate.id === provisioner.id && candidate.resize?.cpuCores.kind === 'supported'))).toBe(true);
        const admissions: unknown[] = [];
        const actionResults: Array<Readonly<{ actionId: string; result: unknown }>> = [];
        const frontDoor = createFrontDoorActionExecute(createDefaultActionExecutor());
        const executeAction = Object.assign(async (...args: Parameters<typeof frontDoor>) => {
            const result = await frontDoor(...args);
            actionResults.push({ actionId: args[0], result });
            return result;
        }, { confirmed: async (...args: Parameters<typeof frontDoor.confirmed>) => {
            const result = await frontDoor.confirmed(...args);
            actionResults.push({ actionId: args[0], result });
            return result;
        }, prepare: frontDoor.prepare });
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/machines/managed/actions/get') return Response.json(refreshed ? refreshedRead : read);
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [refreshed ? refreshedRead : read] });
            if (path === '/v1/machines/managed/actions/birth.get') return Response.json({ source: null });
            if (path === '/v1/machines/managed/controller/admit-control') {
                admissions.push(JSON.parse(String(init?.body)));
                return Response.json({ code: 'permission_denied' }, { status: 403 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const { openManagedMachineReadSnapshots, prepareManagedMachinePresetResizeOverrideForSnapshot } =
            await import('@/sync/ops/machines/machinePresetCollectionClient');
        const [opened] = await openManagedMachineReadSnapshots({ serverId, accountId: 'owner' }, [read]);
        if (form === 'opaque') expect(await prepareManagedMachinePresetResizeOverrideForSnapshot({ serverId, accountId: 'owner' }, opened!, { cpuCores: 4 }))
            .toMatchObject({ kind: 'ready', override: { content: expect.any(Object) } });
        const screen = await renderScreen(<ManagedMachineDetail serverId={target.id} managedId={opaque.machine.id} executeAction={executeAction} />);
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.findByTestId('managed-machine.resize')).not.toBeNull();
            });
            const renderedMachine = screen.tree.findByType(ManagedMachineSections).props.machine;
            if (form === 'opaque') expect(await prepareManagedMachinePresetResizeOverrideForSnapshot({ serverId, accountId: 'owner' }, renderedMachine, { cpuCores: 4 }))
                .toMatchObject({ kind: 'ready', override: { content: expect.any(Object) } });
            await screen.pressByTestIdAsync('managed-machine.resize');
            if (form === 'opaque') {
                refreshed = true;
                await act(async () => publishHomeAccountChange(target.id));
                await waitForHomeGovernance(() => expect(screen.tree.findByType(ManagedMachineSections).props.machine.preset.revision).toBe(8));
                expect(screen.findByTestId('managed-machine.resize-review')).not.toBeNull();
            }
            await act(async () => screen.changeTextByTestId('managed-machine.resize-field:cpuCores', '4'));
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.findByTestId('managed-machine.resize-confirm')?.props.disabled).not.toBe(true);
            });
            await screen.pressByTestIdAsync('managed-machine.resize-confirm');
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.findByTestId('managed-machine.control-error')?.props.diagnosticCode).toBeUndefined();
                const action = actionResults.find(candidate => candidate.actionId === 'machines.managed.resize');
                expect(action?.result).toMatchObject({ ok: false, errorCode: 'permission_denied' });
                expect(JSON.stringify(action?.result)).not.toContain('Private preset name');
                expect(JSON.stringify(action?.result)).not.toContain('Private Cloud SSH guest');
                expect(JSON.stringify(action?.result)).not.toContain('private-cloud-ssh');
                expect(admissions).toHaveLength(1);
            });
            expect(admissions[0]).toMatchObject({ action: 'machines.managed.resize', input: {
                homeId, managedId: opaque.machine.id, ...(form === 'opaque'
                    ? { presetContentOverride: { content: expect.any(Object) } } : { size: { cpuCores: 4 } }),
            } });
            if (form === 'opaque') expect((admissions[0] as { input: Record<string, unknown> }).input).not.toHaveProperty('size');
            if (form === 'opaque') expect(admissions[0]).toMatchObject({ input: {
                presetContentOverride: { content: { t: 'plain', v: { name: 'Private preset name' } } },
            } });
        } finally {
            await screen.unmount();
        }
    });
    it.each(['rail', 'settings'] as const)('keeps a removed enrolled resource visible in its saved %s destination without reloading', async door => {
        const target = await upsertAndActivateServer({ serverUrl: `https://managed-removed-${door}.test`, scope: 'tab' });
        const homeId = `srv_managed_removed_${door}`;
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner') });
        let machine = ManagedMachineFullV1Schema.parse({ id: 'removed-enrolled', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Removed guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'deleted-guest',
            allocation: 'bound', creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native-id' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'deleted-guest' })] } });
        const request: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']> = async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'owner' });
            if (path === '/v1/machines') return Response.json(machine.allocation === 'confirmed-absent' ? []
                : [createPlainMachineRowFixture({ id: 'deleted-guest', accountId: 'owner' })]);
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => createPlainMachineRowFixture({ id, accountId: 'owner' }));
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        };
        const connection = await restoreServerAccountForTest({ serverUrl: target.serverUrl, serverIdentityId: homeId,
            accountId: 'owner', credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) }, request });
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const pathname = `${door === 'rail' ? '' : '/settings'}/machines/managed/${machine.id}`;
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const destination = resolveDestinationRefFromHref(catalog, `${pathname}?serverId=${homeId}`);
        if (!destination) throw new Error('Managed destination must be admitted');
        const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
        const { WorkspaceShell } = await import('@/components/appShell/workspace/WorkspaceShell');
        const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
        const { registerWorkspaceRouteContext } = await import('@/components/appShell/workspace/workspaceRouteContext');
        const machineLayout = await import('@/app/(app)/settings/machines/_layout');
        // Expo's module loader is the boundary; destination admission, retention and redirects remain real.
        const routeModules = {
            './(app)/settings/machines/_layout.tsx': machineLayout,
            './(app)/machines/managed/[id].tsx': { WorkspaceRouteBody: ManagedMachineRouteBody },
            './(app)/settings/machines/managed/[id].tsx': { WorkspaceRouteBody: SettingsManagedMachineRouteBody },
            './(app)/settings/machines/[id]/index.tsx': { WorkspaceRouteBody: MachinePageScreen },
        };
        registerWorkspaceRouteContext(Object.assign((key: string) => {
            if (!Object.hasOwn(routeModules, key)) throw new Error(`Unexpected retained Machine route: ${key}`);
            return routeModules[key as keyof typeof routeModules];
        }, { keys: () => Object.keys(routeModules) }));
        window.history.replaceState(null, '', `${pathname}?serverId=${homeId}`);
        const screen = await renderScreen(<InjectedAuthProvider credentials={{ token: createAccountTokenForTests('owner', { currentAccount: true }) }}><KeyboardShortcutProvider handlers={{}}>
            <WorkspaceProvider enabled catalog={catalog}>{navigation => <>
                {React.createElement('DeleteWorkspaceProbe', { navigation })}
                <WorkspaceShell catalog={catalog} />
            </>}</WorkspaceProvider>
        </KeyboardShortcutProvider></InjectedAuthProvider>);
        try {
            await flushHookEffects();
            await act(async () => {
                const { state } = screen.tree.findByType('DeleteWorkspaceProbe').props.navigation;
                for (const groupId of Object.keys(state.groups)) {
                    screen.findByTestId(`split-canvas-content-slot-${groupId}`)?.props.onLayout({
                        nativeEvent: { layout: { x: 0, y: 32, width: 760, height: 820 } },
                    });
                }
            });
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(window.location.pathname).toBe(`${door === 'rail' ? '' : '/settings'}/machines/deleted-guest`);
            });
            const retainedTabId = screen.tree.findByType('DeleteWorkspaceProbe').props.navigation.state.groups['group:1'].activeTabId;
            machine = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'confirmed-absent', intentRevision: 3,
                observation: { observedAt: Date.now(), availability: 'absent' } });
            await act(async () => {
                storage.setState({ machineListByServerId: { [serverId]: [] } });
                publishHomeAccountChange(target.id);
            });
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.findByTestId('managed-machine.detail')).not.toBeNull();
                expect(screen.tree.findByType(ManagedMachineSections).props.machine.intentRevision).toBe(3);
            });
            expect(screen.getTextContent()).toContain(t('managedPower.resourceAbsent'));
            expect(screen.findByTestId('managed-machine.installation-error')).toBeNull();
            expect(screen.findByTestId('managed-machine.delete')).toBeNull();
            expect(window.location.pathname).toBe(pathname);
            expect(screen.tree.findByType('DeleteWorkspaceProbe').props.navigation.state.groups['group:1'].activeTabId).toBe(retainedTabId);
        } finally { await screen.unmount(); await connection.dispose(); }
    });
    it.each(['rail', 'settings'] as const)('resolves a removed enrolled resource from its missing Machine page to the retained %s receipt', async door => {
        const target = await upsertAndActivateServer({ serverUrl: `https://enrolled-removed-${door}.test`, scope: 'tab' });
        const homeId = `srv_enrolled_removed_${door}`;
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner') });
        const machine = ManagedMachineFullV1Schema.parse({ id: 'retained-removed', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Removed guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'deleted-guest',
            allocation: 'confirmed-absent', creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 3,
            observation: { observedAt: Date.now(), availability: 'absent' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        storage.setState({ machines: {}, machineListByServerId: { [homeId]: [] } });
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines') return Response.json([]);
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const pathname = `${door === 'rail' ? '' : '/settings'}/machines/deleted-guest`;
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const destination = resolveDestinationRefFromHref(catalog, `${pathname}?serverId=${homeId}`);
        if (!destination) throw new Error('Machine destination must be admitted');
        const navigation = (await import('expo-router')).router;
        vi.mocked(navigation.replace).mockClear();
        const screen = await renderScreen(<DestinationInstanceHost tabId={`enrolled-removed-${door}`} ref={destination} pathname={pathname}
            focused visible navigation={navigation}><MachinesDoorProvider door={door}><MachinePageScreen /></MachinesDoorProvider></DestinationInstanceHost>);
        try {
            await flushHookEffects({ cycles: 30 });
            expect(navigation.replace).toHaveBeenCalledWith(`${door === 'rail' ? '' : '/settings'}/machines/managed/${machine.id}?serverId=${homeId}`);
        } finally { await screen.unmount(); }
        const sharingPathname = `${pathname}/sharing`;
        const sharingDestination = resolveDestinationRefFromHref(catalog, `${sharingPathname}?serverId=${homeId}`);
        if (!sharingDestination) throw new Error('Sharing destination must be admitted');
        const sharing = await renderScreen(<DestinationInstanceHost tabId={`removed-sharing-${door}`} ref={sharingDestination} pathname={sharingPathname}
            focused visible navigation={navigation}><MachinesDoorProvider door={door}><MachineSubPageScreen /></MachinesDoorProvider></DestinationInstanceHost>);
        try {
            await flushHookEffects({ cycles: 30 });
            // MACH-COMPOSE D1 (d441ea4a98): the old Sharing page opens its place in Security.
            expect(navigation.replace).toHaveBeenLastCalledWith(`${pathname}?serverId=${homeId}&tab=security&page=sharing`);
            expect(sharing.findByTestId('machine-detail-sharing')).toBeNull();
        } finally { await sharing.unmount(); }
    });
    it('reads a cold managed destination through the real consumed Home URL and retained route producer', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-cold-destination.test', scope: 'tab' });
        const homeId = 'srv_managed_cold_destination';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const machine = ManagedMachineFullV1Schema.parse({ id: 'cold-managed', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Cold managed receipt', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'unsubmitted', creationState: 'active',
            desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const pathname = `/machines/managed/${machine.id}`;
        const location = { href: `https://app.test${pathname}?serverId=${homeId}&server=${encodeURIComponent(target.serverUrl)}` };
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { location, history: { state: null,
            replaceState: (_state: unknown, _title: string, href: string) => { location.href = new URL(href, location.href).href; } } });
        await commitWebServerUrlOverride({ action: { kind: 'refresh_auth', serverUrl: target.serverUrl },
            switchServer: async () => { throw new Error('Already admitted Home must not switch'); }, refreshAuth: async () => {} });
        const url = new URL(location.href);
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const destination = resolveDestinationRefFromHref(catalog, `${url.pathname}${url.search}`);
        if (!destination) throw new Error('Managed destination must be admitted');
        // URL cleanup uses a browser boundary; the renderer keeps the suite's native host boundary.
        vi.unstubAllGlobals();
        const reads: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const requestUrl = new URL(String(input));
            if (requestUrl.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (requestUrl.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (requestUrl.pathname === '/v1/machines/managed/actions/get') {
                expect(requestUrl.origin).toBe(target.serverUrl);
                reads.push(JSON.parse(String(init?.body)));
                return Response.json(machine);
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const navigation = (await import('expo-router')).router;
        const screen = await renderScreen(<DestinationInstanceHost tabId="cold-managed-tab" ref={destination} pathname={pathname} focused visible navigation={navigation}>
            <ManagedMachineRouteBody />
        </DestinationInstanceHost>);
        await flushHookEffects({ cycles: 30 });
        expect(reads).toContainEqual({ homeId, managedId: machine.id });
        expect(screen.tree.findByType(ManagedMachineSections).props.machine).toEqual(machine);
        await screen.unmount();
    });
    it('clears a transient cold-read failure when Retry succeeds through the same inventory owner', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-retry.test', scope: 'tab' });
        const homeId = 'srv_managed_retry';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
        });
        const machine = ManagedMachineFullV1Schema.parse({
            id: 'managed-retry', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Retry managed receipt', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'unsubmitted', creationState: 'active',
            desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        });
        let detailReads = 0;
        let detailReadable = false;
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (path === '/v1/machines/managed/actions/get') {
                detailReads += 1;
                return detailReadable ? Response.json(machine) : Response.json({ error: 'unavailable' }, { status: 503 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        const readState = () => screen.tree.findAllByType(SurfaceStateCard)
            .find(node => node.props.testID === 'managed-machine.read-state');
        await vi.waitFor(() => expect(readState()?.props.kind).toBe('unavailable'));

        const readsBeforeRetry = detailReads;
        detailReadable = true;
        await act(async () => readState()!.props.action.onPress());

        await vi.waitFor(() => expect(screen.tree.findByType(ManagedMachineSections).props.machine).toEqual(machine));
        expect(detailReads).toBeGreaterThan(readsBeforeRetry);
        expect(screen.findByTestId('managed-machine.read-state')).toBeNull();
        await screen.unmount();
    });
    it('shows an unsubmitted allocation without an invented controller name or active creation', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-unsubmitted-controller.test', scope: 'tab' });
        const homeId = 'srv_managed_unsubmitted_controller';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
        });
        const machine: ManagedMachineFullV1 = { id: 'unsubmitted-managed', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'unlisted-controller', installationId: 'installation' },
            allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, []);
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        try {
            await flushHookEffects({ cycles: 30 });
            expect(screen.getTextContent()).toContain(t('managedMachines.inspect.notCreated'));
            expect(screen.getTextContent()).not.toContain(t('managedMachines.creation.waiting', { name: 'Guest' }));
            expect(screen.getTextContent()).not.toContain(t('common.unknown'));
            expect(screen.findByTestId('managed-machine.controller.pending')).toBeNull();
        } finally { await screen.unmount(); }
    });
    it('holds the managing computer as a pending value, never "Loading…" in its sentences, until its name is read', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-controller-pending.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_controller_pending');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const launch = { provider, schemaVersion: 1, name: 'Local sandbox', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'controller-pending', homeId: 'srv_managed_controller_pending', custodianAccountId: 'owner',
            launch, controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'local', stoppedBilling: 'not-billed' },
                prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        const named = createMachineFixture({ id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now() });
        // Presence arrived before the machine list: the row exists, its name is still being read.
        const { availability: _availability, ...hydrating } = { ...named, metadata: null };
        storage.setState({ machineListByServerId: { [serverId]: [hydrating as typeof named] } });
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await flushHookEffects({ cycles: 30 });
        expect(screen.getTextContent()).not.toContain(t('common.loading'));
        expect(screen.getTextContent()).toContain(t('managedController.fixedLocalUnnamed'));
        expect(screen.findByTestId('managed-machine.controller.pending')).not.toBeNull();
        // A local machine runs on the computer that manages it: the receipt names it once, in Runs on (O-MACH 11-10).
        expect(screen.findByTestId('managed-machine.detail.receipt:fact:controller')).toBeNull();
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [named] } }));
        await flushHookEffects({ cycles: 10 });
        const { getMachineDisplayName } = await import('@/utils/sessions/machineDisplayNames');
        const name = getMachineDisplayName(named);
        expect(screen.getTextContent()).toContain(t('managedController.fixedLocal', { controller: name }));
        expect(screen.getTextContent()).toContain(t('managedMachines.price.runsOn', { computer: name }));
        expect(screen.findByTestId('managed-machine.controller.pending')).toBeNull();
        await screen.unmount();
    });
    it('closes a resource that no longer exists to its state and its record, with nothing left to manage or bill', async () => {
        vi.spyOn(await import('react-native'), 'useWindowDimensions').mockReturnValue({ width: 1440, height: 900, scale: 1, fontScale: 1 });
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-ended-record.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_ended_record');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const launch = { provider, schemaVersion: 1, name: 'Local sandbox', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'ended-record', homeId: 'srv_managed_ended_record', custodianAccountId: 'owner',
            launch, controller, allocation: 'confirmed-absent', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 5, availability: 'absent' },
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'local', stoppedBilling: 'not-billed' },
                prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, updatedAt: Date.now() })] } });
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await flushHookEffects({ cycles: 30 });
        expect(screen.findByTestId('managed-machine.detail.receipt:fact:controller')).not.toBeNull();
        expect(screen.findByTestId('managed-machine.controller')).toBeNull();
        expect(screen.findByTestId('managed-machine.launch')).toBeNull();
        expect(screen.findByTestId('managed-machine.detail.receipt:cost')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('managedMachines.price.noBill'));
        // Nothing is left to check or read: no Check now, no Read log; the record says what went and what stays.
        expect(screen.findByTestId('managed-machine.observation-check')).toBeNull();
        expect(screen.findByTestId('managed-machine.logs.read')).toBeNull();
        expect(screen.findByTestId('managed-machine.ended-record')).not.toBeNull();
        await screen.unmount();
    });
    it('offers Create another on an ended resource, opening its configurator made like the same preset and controller (lab m-life/L#4)', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-ended-another.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_ended_another');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const launch = { provider, schemaVersion: 1, name: 'Finite sandbox', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'ended-another', homeId: 'srv_managed_ended_another', custodianAccountId: 'owner',
            preset: { id: 'preset-sandbox', revision: 2, contentEncryptionMode: 'plain' }, launch, controller, allocation: 'confirmed-absent', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 5, availability: 'absent' } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, updatedAt: Date.now() })] } });
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await flushHookEffects({ cycles: 30 });
        const createAnother = screen.findByTestId('managed-machine.progress:createAnother');
        expect(createAnother).not.toBeNull();
        await act(async () => { createAnother!.props.onPress(); });
        const { buildManagedMachineConfigurationRoute } = await import('./managedMachineConfigurationRoute');
        expect((await import('expo-router')).router.push).toHaveBeenCalledWith(buildManagedMachineConfigurationRoute({
            serverId, provisioner: 'custom.provisioner/native', controller, presetId: 'preset-sandbox' }));
        await screen.unmount();
    });
    it.each(['provider', 'credential', 'credential-many'] as const)('offers the canonical %s recovery from current native facts without installation retry', async removed => {
        const target = await upsertAndActivateServer({ serverUrl: `https://managed-missing-${removed}.test`, scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, `srv_managed_missing_${removed}`);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        if (removed !== 'provider') await upsertAndActivateServer({ serverUrl: 'https://managed-recovery-other-home.test', scope: 'tab' });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        const account = { service: { pluginId: 'custom.credentials', localId: 'cloud' }, accountId: 'refused-cloud-account' };
        const credentials = removed === 'provider' ? [] : [{ purpose: { consumer: provider, purpose: 'compute' }, account },
            ...(removed === 'credential-many' ? [{ purpose: { consumer: provider, purpose: 'desktop' },
                account: { ...account, accountId: 'other-cloud-account' } }] : [])];
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        const machine = { id: 'missing-native-owner', homeId: `srv_managed_missing_${removed}`, custodianAccountId: 'owner',
            launch: { provider, credentials, schemaVersion: 1, name: 'Retained resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } satisfies ManagedMachineReadSnapshotV1;
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: machine.controller.machineId,
            installationId: machine.controller.installationId, updatedAt: Date.now() })]);
        const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'native-failure', revision: 2,
            actionId: 'machines.managed.delete', state: 'failed', scope: { accountId: 'owner', machineId: machine.controller.machineId },
            title: 'Delete retained resource', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller },
            error: { error: 'Native owner unavailable', errorCode: removed !== 'provider' ? 'credential_unavailable' : 'provider_unavailable' } };
        operationRpcBoundary.answer = { items: [snapshot], nextCursor: null };
        if (removed === 'provider') operationRpcBoundary.registryAnswer = { protocolVersion: 1,
            projection: { v: 2, generation: 1, familiesById: {} } };
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await flushHookEffects({ cycles: 30 });
        if (removed !== 'provider') expect(screen.tree.findByType(ManagedCreationProgress).props.operation)
            .toMatchObject({ observation: 'available', snapshot: { operationId: snapshot.operationId } });
        const state = screen.tree.findByType(ManagedMachineStateRow).props.state;
        expect(state.kind).toBe(removed === 'provider' ? 'providerRemoved' : 'credentialRefused');
        expect(screen.findByTestId('managed-machine.installation-retry')).toBeNull();
        const trigger = { getBoundingClientRect: () => ({ left: 30, top: 40, width: 24, height: 24 }) };
        await act(async () => { screen.findByTestId(`managed-machine.progress:${removed === 'provider' ? 'reinstall' : 'reconnect'}`)!.props.onPress({ currentTarget: trigger }); });
        const router = (await import('expo-router')).router;
        if (removed === 'provider') {
            expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: SETTINGS_ROUTES.plugins,
                params: expect.objectContaining({ serverId, machineId: machine.controller.machineId }) }));
        } else {
            expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({
                request: removed === 'credential' ? { scope: { serverId, accountId: 'owner' }, intent: 'reconnect', service: account.service, account }
                    : { scope: { serverId, accountId: 'owner' }, intent: 'link', service: undefined },
            }) }));
            expect(router.push).not.toHaveBeenCalled();
        }
        await screen.unmount();
    });
    it.each(['owned', 'shared', 'moved', 'different-home', 'fin-read-failed', 'other-focused-home', 'other-focused-bound',
        'unloaded-keep', 'unloaded-stop', 'unloaded-delete', 'unloaded-archived', 'unloaded-other-home',
        'unloaded-task-keep', 'unloaded-task-unrelated', 'unloaded-task-matching', 'unloaded-no-birth-bound',
        'unloaded-task-birth-retry', 'unloaded-task-birth-run', 'unloaded-task-birth-demanded'] as const)('shows the Home retention rule for its exact birth in the Account/Home (%s)', async ownership => {
        const unloaded = ownership.startsWith('unloaded-');
        const task = ownership.startsWith('unloaded-task-');
        const conflicting = ownership === 'unloaded-task-unrelated' || ownership === 'unloaded-task-matching';
        const matching = ownership === 'unloaded-task-matching';
        const recovery = ownership === 'unloaded-task-birth-retry' || ownership === 'unloaded-task-birth-run'
            || ownership === 'unloaded-task-birth-demanded';
        let birthAvailable = !recovery;
        let birthReads = 0;
        const bound = ownership === 'other-focused-bound' || ownership === 'unloaded-stop' || ownership === 'unloaded-delete'
            || ownership === 'unloaded-no-birth-bound' || conflicting;
        const target = await upsertAndActivateServer({ serverUrl: `https://managed-birth-${ownership}.test`, scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, `srv_managed_birth_${ownership}`);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        const machine = { id: 'birth-resource', homeId: `srv_managed_birth_${ownership}`,
            custodianAccountId: ownership === 'shared' ? 'foreign-owner' : 'owner',
            launch: { provider, schemaVersion: 1, name: task ? 'Born for task' : 'Born for Session', choices: {} },
            controller: { machineId: ownership === 'moved' ? 'new-controller' : 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            enrolledMachineId: 'guest', resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            ...(bound && (!conflicting || matching) ? { creationScopeRetention: {
                effect: ownership === 'unloaded-delete' ? 'delete' as const : 'stop' as const,
                source: task ? { kind: 'run' as const, source: { kind: 'workflow_run' as const, runId: '11111111-1111-4111-8111-111111111111' } }
                    : { kind: 'session' as const, sessionId: 'original-source' },
            } } : {}),
        } satisfies ManagedMachineReadSnapshotV1;
        const source = createSessionFixture({ id: 'original-source', serverId: target.id, metadata: {
            name: 'Original source Session', path: '/repo', host: 'guest', machineId: 'guest', sessionCreationCorrespondenceV1: { v: 1,
                sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'birth' }),
                recipe: { execution: { machineId: 'guest', directory: { kind: 'managed' } }, organization: { folderId: null, tagIds: [] },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, modelSelection: null,
                    profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null, connectedServices: null,
                    capabilitySelection: null, transcriptStorage: null, terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
                    managedCreation: { homeId: ownership === 'different-home' ? 'unrelated-home' : machine.homeId,
                        managedId: machine.id, controller: { machineId: 'controller', installationId: 'installation' } } } } } });
        let triggerReads = 0;
        const finRequests: string[] = [];
        const ownerMetadata = createSessionOwnerMetadataV1({ metadata: source.metadata! });
        if (!ownerMetadata.ok) throw new Error('Source fixture must have canonical owner metadata');
        const sourceRecord = V2SessionRecordSchema.parse({ id: source.id, seq: source.seq, createdAt: source.createdAt,
            updatedAt: source.updatedAt, active: false, activeAt: source.activeAt, encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: source.metadata! })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata), metadataVersion: 1,
            agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null });
        const cursor = encodeV2SessionListCursorV1('first-page');
        const request: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']> = async (input, init) => {
            const url = new URL(String(input));
            finRequests.push(url.pathname);
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'owner' });
            if (url.pathname === '/v1/machines/managed/actions/birth.get') {
                birthReads += 1;
                return birthAvailable ? Response.json({ source: task
                    ? { kind: 'run', source: { kind: 'workflow_run', runId: '11111111-1111-4111-8111-111111111111' } }
                    : ownership === 'different-home' || ownership === 'unloaded-no-birth-bound' ? null : { kind: 'session', sessionId: source.id } })
                    : Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
            }
            if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/active' || url.pathname === '/v2/sessions/archived') {
                expect(url.origin).toBe(target.serverUrl);
                const archived = url.pathname.endsWith('/archived');
                const containsSource = archived === (ownership === 'unloaded-archived');
                // Inventory exists at the transport boundary, but exact birth discovery must not read it.
                if (containsSource && unloaded && !bound && !url.searchParams.has('cursor'))
                    return Response.json({ sessions: [], nextCursor: cursor, hasNext: true });
                return Response.json({ sessions: containsSource ? [sourceRecord] : [], nextCursor: null, hasNext: false });
            }
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated')
                return Response.json(createRootLayoutFeaturesResponse({ features: { workflows: { enabled: true } } }));
            if (url.pathname === '/v3/automations/query') {
                expect(url.origin).toBe(target.serverUrl);
                triggerReads += 1;
                return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
            }
            // The source Session is the only retained Account data in this fixture.
            // Other bootstrap owners still receive their canonical empty wire;
            // unclaimed Session batches remain with the full-record adapter.
            return createEmptyAccountBootstrapHttpResponse(url.pathname, init);
        };
        const connection = await restoreServerAccountForTest({ serverUrl: target.serverUrl, serverIdentityId: machine.homeId,
            accountId: 'owner', credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) }, request });
        // Measure the mounted exact-birth reader, not the Account's independent
        // startup inventory. Drain that real owner before seeding unloaded state.
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(storage.getState().profileScope).toEqual({ serverId: connection.serverId, accountId: 'owner' });
            expect(storage.getState().isDataReady).toBe(true);
        });
        // Profile admission schedules the ordinary background queue after the
        // foreground route phase. Drain that queue before its hydration read.
        await sync.refreshSessions();
        await sync.refreshSessions({ awaitSessionListHydration: true });
        storage.setState({ profileScope: { serverId: target.id, accountId: 'owner' }, isDataReady: true,
            sessionLocalStateScope: { serverId: target.id, accountId: 'owner' },
            sessions: { ...(unloaded ? {} : { [source.id]: source }), earlier: createSessionFixture({ id: 'earlier', serverId: target.id, createdAt: 0,
                metadata: { path: '/repo', host: 'guest', machineId: 'guest' } }) } });
        if (ownership === 'other-focused-home' || ownership === 'other-focused-bound' || ownership === 'unloaded-other-home') {
            const focused = await upsertAndActivateServer({ serverUrl: 'https://managed-birth-ambient.test', scope: 'tab' });
            storage.setState({ profileScope: { serverId: focused.id, accountId: 'ambient-owner' } });
        }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const beforeSourceRead = finRequests.length;
        try {
            screen = await renderScreen(<InjectedAuthProvider credentials={{ token: createAccountTokenForTests('owner', { currentAccount: true }) }}>
                <ManagedEnrolledMachineSections enrolledMachineId="guest" serverId={target.id}
                    executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} /></InjectedAuthProvider>);
            await flushHookEffects({ cycles: 30 });
            if (recovery) {
                expect(screen.tree.findAllByType(ManagedScopeRuleRow)).toHaveLength(0);
                expect(birthReads).toBe(1);
                // A failed exact birth read keeps its place with its cause and Retry, never a silent absence.
                const failed = screen.tree.findAllByType(SurfaceStateCard)
                    .filter(node => node.props.testID === 'managed-machine.scope-birth-failed');
                expect(failed).toHaveLength(1);
                expect(failed[0]!.props).toMatchObject({ kind: 'warning', diagnosticCode: 'managed_birth_lookup_failed',
                    title: t('managedRetention.scopeBirthFailed', { name: machine.launch.name }) });
                birthAvailable = true;
                if (ownership === 'unloaded-task-birth-demanded') await pressTestInstanceAsync(
                    screen.tree.root.findByProps({ testID: 'managed-machine.scope-birth-failed:retry' } as never));
                else await act(async () => {
                    // Check now's exact-target success emits this incumbent Home wake;
                    // Run admissions publish their typed existing account entity.
                    publishHomeAccountChange(target.id, ownership === 'unloaded-task-birth-run'
                        ? ['workflow-run:11111111-1111-4111-8111-111111111111'] : undefined,
                    ownership === 'unloaded-task-birth-run' ? { changeKinds: ['account'] } : undefined);
                });
                await flushHookEffects({ cycles: 30 });
                expect(birthReads).toBe(2);
                expect(screen.tree.findAllByType(SurfaceStateCard)
                    .filter(node => node.props.testID === 'managed-machine.scope-birth-failed')).toHaveLength(0);
            }
            expect(finRequests.slice(beforeSourceRead).filter(path => ['/v2/sessions', '/v2/sessions/archived'].includes(path))).toHaveLength(0);
            const rows = screen.tree.findAllByType(ManagedScopeRuleRow);
            if (ownership === 'different-home') expect(rows).toHaveLength(0);
            else {
                expect(rows, JSON.stringify(finRequests)).toHaveLength(1);
                expect(rows[0]!.props.rule.scope).toBe(task ? 'task' : 'session');
                expect(triggerReads, JSON.stringify(finRequests)).toBe(0);
                expect(rows[0]!.props.rule.summary, JSON.stringify(finRequests)).toBe(bound && (!conflicting || matching)
                        ? t('managedRetention.scopeRuleChosen', { rule: t(ownership === 'unloaded-delete'
                            ? 'managedRetention.scopeRuleDeleteIdle' : 'managedRetention.scopeRuleStopIdle', { name: machine.launch.name }), name: machine.launch.name })
                        : t('common.keep'));
                if (ownership === 'owned') {
                    const previousSettings = storage.getState().settings;
                    const previousAssignments = storage.getState().sessionOrganizationTagAssignmentsBySessionKey;
                    const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
                    try {
                        await act(async () => {
                            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [target.id]: ['private'] } });
                            storage.getState().setSessionTagAssignmentsOptimistic(target.id, source.id, ['private']);
                            setScreenSharingPrivacyActive(true);
                        });
                        expect(screen.getTextContent()).not.toContain('Original source Session');
                        expect(screen.getTextContent()).not.toContain('/repo');
                        expect(screen.findByTestId('managed-machine.scope-session')).not.toBeNull();
                        await act(async () => { setScreenSharingPrivacyActive(false); });
                        expect(screen.getTextContent()).toContain('Original source Session');
                    } finally {
                        setScreenSharingPrivacyActive(false);
                        storage.setState({ settings: previousSettings, sessionOrganizationTagAssignmentsBySessionKey: previousAssignments });
                    }
                }
                if (!unloaded) expect(screen.getTextContent()).toContain('Original source Session');
                else expect(storage.getState().sessions[source.id]).toBeUndefined();
                expect(typeof rows[0]!.props.rule.onOpen).toBe(ownership === 'shared' ? 'undefined' : 'function');
                if (ownership !== 'shared') {
                    await act(async () => rows[0]!.props.rule.onOpen());
                    expect((await import('expo-router')).router.push).not.toHaveBeenCalled();
                }
            }
        } finally {
            await screen?.unmount();
            await connection.dispose();
        }
    });
    it('keeps opaque Machine scope recovery visible without opened private labels', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-opaque-birth.test', scope: 'tab' });
        const homeId = 'srv_managed_opaque_birth';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        const { ManagedOpaquePresetMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'opaque-birth', homeId, custodianAccountId: 'owner',
            preset: { id: 'sealed', revision: 1, contentEncryptionMode: 'e2ee' },
            allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        let available = false;
        const connection = await restoreServerAccountForTest({ serverUrl: target.serverUrl, serverIdentityId: homeId,
            accountId: 'owner', credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
            request: async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/machines/managed/actions/birth.get') return available
                    ? Response.json({ source: { kind: 'run', source: { kind: 'workflow_run', runId: '11111111-1111-4111-8111-111111111111' } } })
                    : Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        function Scope() {
            const { binding } = useServerCredentialAccountScopeBinding(target.id);
            return <ManagedCreationScopeRuleSection machine={machine} serverId={target.id} binding={binding ?? undefined} supportedEffects={['stop', 'delete']} />;
        }
        const screen = await renderScreen(<Scope />);
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('managed-machine.scope-birth-failed')).not.toBeNull());
            expect(screen.tree.findByType(SurfaceStateCard).props.title)
                .toBe(t('managedRetention.scopeBirthFailed', { name: t('common.machine') }));
            available = true;
            await screen.pressByTestIdAsync('managed-machine.scope-birth-failed:retry');
            await waitForHomeGovernance(() => expect(screen.tree.findAllByType(ManagedScopeRuleRow)).toHaveLength(1));
            expect(screen.tree.findByType(ManagedScopeRuleRow).props.rule.summary).toBe(t('common.keep'));
        } finally { await screen.unmount(); await connection.dispose(); }
    });
    it('keeps birth pending, empty and failed distinct and exposes a demanded retry without unrelated reads', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-birth-state.test', scope: 'tab' });
        const homeId = 'srv_managed_birth_state';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        const pending = createDeferred<Response>();
        let reads = 0;
        let answer: 'pending' | 'failed' | 'ready' = 'pending';
        const request: Parameters<typeof setRuntimeFetch>[0] = async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/machines/managed/actions/birth.get') {
                reads += 1;
                return answer === 'pending' ? pending.promise : answer === 'failed'
                    ? Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) : Response.json({ source: null });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        const connection = await restoreServerAccountForTest({ serverUrl: target.serverUrl, serverIdentityId: homeId,
            accountId: 'owner', credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) }, request });
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(target.id);
            return useManagedCreationScopeBirth({ homeId, id: 'managed-state' }, binding);
        });
        try {
            await flushHookEffects({ cycles: 30 });
            expect(hook.getCurrent()).toMatchObject({ status: 'pending', source: null });
            pending.resolve(Response.json({ error: 'temporarily_unavailable' }, { status: 503 }));
            await flushHookEffects({ cycles: 30 });
            expect(hook.getCurrent()).toMatchObject({ status: 'failed', source: null });
            const settledReads = reads;
            await act(async () => publishHomeAccountChange(target.id, ['unrelated-artifact'], { changeKinds: ['artifact'] }));
            await flushHookEffects();
            expect(reads).toBe(settledReads);
            answer = 'ready';
            await act(async () => hook.getCurrent().retry());
            await flushHookEffects({ cycles: 30 });
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', source: null });
            expect(reads).toBe(settledReads + 1);
        } finally { await hook.unmount(); await connection.dispose(); }
    });
    it('keeps Delete available for a canceled Account creation with pending paid-resource cleanup', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-canceled-cleanup.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_canceled_cleanup');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id },
            { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        const machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'srv_managed_canceled_cleanup',
            custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Studio', choices: {} },
            allocation: 'bound', creationState: 'canceled',
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            cleanup: { disposition: 'pending', reason: 'creation_canceled' },
            desired: 'delete', desiredWhen: 'now', intentRevision: 2, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch: { provider, schemaVersion: 1, name: 'Studio', choices: {} },
                optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.findByTestId('managed-machine.delete')).not.toBeNull();
                expect(screen.findByTestId('managed-machine.delete')?.props.disabled).not.toBe(true);
            });
            expect(screen.findByTestId('managed-machine.start')).toBeNull();
            expect(screen.findByTestId('managed-machine.stop')).toBeNull();
        } finally { await screen.unmount(); }
    });
    it('offers Remove only where Delete cannot end the resource and reads pending Delete from admitted approvals without scanning unrelated Artifact arrivals (UIR5)', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-remove-gate.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_remove_gate');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        let machine: ManagedMachineFullV1 = { id: 'healthy-bound', homeId: 'srv_managed_remove_gate', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Studio', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        machine = { ...machine, reviewedFacts: { launch: machine.launch, controller: machine.controller,
            optionStatus: 'current', billing: { location: 'local', stoppedBilling: 'not-billed' }, prerequisites: [],
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
            retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage } };
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('managed-machine.delete')).not.toBeNull();
        });
        expect(screen.findByTestId('managed-machine.remove')).toBeNull();
        const priorArtifacts = storage.getState().artifacts;
        const row = (id: string, kind: string) => ({ id, header: { kind, title: null }, title: null,
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true as const, draft: false });
        await act(async () => storage.getState().applyArtifacts(
            Array.from({ length: 4096 }, (_, index) => row(`approval-cost-history-${index}`, 'note'))));
        const values = Object.values;
        let artifactVisits = 0;
        // Observe actual corpus enumeration without replacing store admission or selection.
        const enumeration = vi.spyOn(Object, 'values').mockImplementation(value => {
            const result = values(value);
            if (value === storage.getState().artifacts) artifactVisits += result.length;
            return result;
        });
        try {
            for (const kind of ['note', 'prompt_bundle.v2', 'ui_widget.v1']) {
                await act(async () => storage.getState().addArtifact(row(`approval-cost-arrival-${kind}`, kind)));
            }
            expect(artifactVisits).toBe(0);
            const request = StoredApprovalRequestSchema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent',
                actionId: 'machines.managed.delete', actionArgs: { homeId: machine.homeId, managedId: machine.id, when: 'now',
                    expectedRevision: 1, intent: 'delete', reviewedDependencies: true }, summary: 'Delete managed resource' });
            const approval = { ...row('approval-cost-delete', 'approval_request.v1'),
                header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request), bodyVersion: 1 };
            await act(async () => storage.getState().addArtifact(approval));
            expect(screen.findByTestId('managed-machine.approval')).not.toBeNull();
            const settled = StoredApprovalRequestSchema.parse({ ...request, status: 'rejected', updatedAtMs: 2,
                decision: { kind: 'reject', decidedAtMs: 2 } });
            await act(async () => storage.getState().updateArtifact({ ...approval, headerVersion: 2, bodyVersion: 2,
                header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled) }));
            expect(screen.findByTestId('managed-machine.approval')).toBeNull();
            expect(artifactVisits).toBe(0);
        } finally {
            enumeration.mockRestore();
            await screen.unmount();
            storage.getState().applyArtifacts(Object.values(priorArtifacts), storage.getState().artifacts);
        }
    });
    it('keeps a bound acquire failure visible with its typed cause, same-resource Retry and Delete', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-acquire-host-key-failure.test', scope: 'tab' });
        const homeId = 'srv_managed_host_key_failure';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'host-key-controller', installationId: 'host-key-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, active: true, activeAt: Date.now(), updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })]);
        const machine = ManagedMachineFullV1Schema.parse({ id: 'host-key-managed', homeId, custodianAccountId: 'owner', controller,
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1,
                name: 'Design sandbox', choices: {} }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1,
                value: { resourceId: 'same-paid-resource' } }, desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        // The host publishes this exact binding before asking the provisioner for a bootstrap carrier.
        // A failure before a task exists still belongs to the paid resource; it needs no fake task or prompt.
        const failed: ActionOperationSnapshotV1 = { version: 1, operationId: 'acquire-host-key-failure', revision: 2,
            actionId: 'machines.managed.acquire', state: 'failed', scope: { accountId: 'owner', machineId: controller.machineId },
            title: 'Create Design sandbox', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller },
            error: { errorCode: 'native_ssh_host_key_unavailable', error: 'native_ssh_host_key_unavailable' } };
        operationRpcBoundary.answer = { items: [failed], nextCursor: null };
        const retries: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            const qualification = staticRetentionQualification(machine, url, init);
            if (qualification) return qualification;
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (actionId === 'machines.managed.bootstrap.retry') retries.push(request.input);
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.managed.get' ? machine : actionId === 'machines.managed.list' ? { machines: [machine] }
                        : { kind: 'approval_request_created', artifactId: 'same-resource-retry', actionId } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.findByTestId('managed-machine.installation-error'), screen.getTextContent()).not.toBeNull();
                expect(screen.findByTestId('managed-machine.installation-retry')).not.toBeNull();
                expect(screen.findByTestId('managed-machine.delete')).not.toBeNull();
                expect(screen.findByTestId('managed-machine.delete')?.props.disabled).not.toBe(true);
            });
            expect(screen.getTextContent()).not.toContain(t('managedMachines.creation.resourceReady'));
            expect(screen.findByTestId('managed-machine.installation-prompt-approve')).toBeNull();
            await screen.pressByTestIdAsync('managed-machine.installation-error.details');
            expect(screen.getTextContent()).toContain(failed.error!.errorCode);
            expect(screen.findByTestId('managed-machine.installation-retry')).not.toBeNull();
            expect(retries).toEqual([]);
            // Investigate sits beside Retry. With Triage unavailable, its catalog owner offers recovery
            // without a launch control.
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                const investigation = screen.findByTestId('managed-machine.investigate');
                expect(investigation).not.toBeNull();
                const catalog = investigation?.findAllByType(SurfaceStateCard)
                    .find(node => node.props.testID === 'investigation.agentActions.unavailable');
                expect(catalog?.props.action?.onPress).toEqual(expect.any(Function));
            });
            expect(retries).toEqual([]);
            await screen.pressByTestIdAsync('managed-machine.installation-retry');
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(retries).toEqual([{ homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision }]);
            });
            expect(screen.tree.findByType(ManagedCreationProgress).props.machine.resource).toEqual(machine.resource);
        } finally { await screen.unmount(); }
    });
    it('keeps an archived enrolled resource at its retained recovery destination', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-archived-detail.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_archived_detail');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        let machine: ManagedMachineFullV1 = { id: 'archived-enrolled', homeId: 'srv_managed_archived_detail', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Archived resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            enrolledMachineId: 'retained-guest', archivedAt: 10,
            cleanup: { disposition: 'unavailable', reason: 'manual_responsibility' },
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            recovery: { reference: 'retained-provider-reference', reason: 'native_records_missing' },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        machine = { ...machine, reviewedFacts: { launch: machine.launch, controller: machine.controller,
            optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'billed' }, prerequisites: [],
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
            retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage } };
        expect(ManagedMachineV1Schema.safeParse(machine).success).toBe(true);
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('managed-machine.recovery')).not.toBeNull();
        });
        expect(screen.getTextContent()).toContain('retained-provider-reference');
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(true);
        expect(screen.findByTestId('managed-machine.stop')).toBeNull();
        expect(screen.findByTestId('managed-machine.delete')).toBeNull();
        await act(async () => screen.tree.unmount());
    });
    it('retains the authored deadline after a policy conflict and retries against the refreshed revision', async () => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-policy-conflict.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_policy_conflict');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        let machine: ManagedMachineFullV1 = { id: 'conflicted-policy', homeId: 'srv_managed_policy_conflict', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Retained resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        machine = { ...machine, reviewedFacts: { launch: machine.launch, controller: machine.controller,
            optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'billed' }, prerequisites: [],
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
            retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage } };
        const authored = { retention: { kind: 'deadline' as const, at: 1_790_008_200_000, effect: 'stop' as const },
            wakeOnAcceptedMessage: false };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: nativeController.machineId,
            installationId: nativeController.installationId, updatedAt: Date.now() })]);
        const controllerRow = { ...createPlainMachineRowFixture({ id: nativeController.machineId, accountId: 'owner' }),
            installationId: nativeController.installationId };
        const requests: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const qualification = staticRetentionQualification(machine, url, init);
            if (qualification) return qualification;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines') return Response.json([controllerRow]);
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname === '/v1/actions/machines.managed.retention.update') {
                const envelope = readNativeControllerRequest(init);
                requests.push(envelope.input);
                if (requests.length === 1) machine = { ...machine, intentRevision: 2,
                    retention: { kind: 'unused', afterMs: 7_200_000, effect: 'stop' } };
                if (requests.length === 1) return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
                    requestId: envelope.requestId, actionId: 'machines.managed.retention.update',
                    execution: { ok: false, errorCode: 'intent_changed', error: 'intent_changed' } }));
                const result = machine = { ...machine, ...authored, intentRevision: 3 };
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, requestId: envelope.requestId,
                    actionId: 'machines.managed.retention.update', execution: { ok: true, result } }));
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ModalProvider><ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} /></ModalProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        let saved: unknown;
        await act(async () => { saved = await screen.tree.findByType(ManagedMachinePolicySection).props.keep.onChange(authored); });
        expect(saved).toBe(false);
        const keep = screen.tree.findByType(ManagedMachinePolicySection).props.keep;
        expect(requests, JSON.stringify({ disabled: keep.disabled, capabilitiesAvailable: keep.capabilitiesAvailable,
            unavailableReason: keep.unavailableReason, policy: keep.policy, defaultPolicy: keep.defaultPolicy,
            text: screen.getTextContent() })).toHaveLength(1);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error')
            .map(node => node.props.diagnosticCode)).toContainEqual(expect.stringMatching(/^intent_changed(?: · |$)/u));
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject(authored);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedCreationProgress).props.machine.intentRevision).toBe(2);
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject(authored);
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject(authored);
        await act(async () => { saved = await screen.tree.findByType(ManagedMachinePolicySection).props.keep.onChange(authored); });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error')
            .map(node => node.props.diagnosticCode)).toEqual([]);
        expect(saved).toBe(true);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedCreationProgress).props.machine.intentRevision).toBe(3);
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject(authored);
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        expect(requests).toEqual([expect.objectContaining({ expectedIntentRevision: 1, ...authored }),
            expect.objectContaining({ expectedIntentRevision: 2, ...authored })]);
        await act(async () => screen.tree.findByType(ManagedMachinePolicySection).props.compactSummary.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('managed-machine.policy-sheet.keep:choice:until-delete')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('managed-machine.policy-sheet.keep:choice:deadline');
        await act(async () => {
            screen.tree.changeTextByTestId('managed-machine.policy-sheet.keep:deadline-date-input', '2099-01-02');
        });
        await act(async () => {
            screen.tree.changeTextByTestId('managed-machine.policy-sheet.keep:deadline-time-input', '18:30');
        });
        await screen.pressByTestIdAsync('managed-machine.policy-sheet.keep:deadline:effect:delete');
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.policy-sheet.keep:deadline-date-input'
            && typeof node.props.onChangeText === 'function')[0]?.props.value).toBe('2099-01-02');
        await act(async () => screen.tree.findByType(ManagedMachineSections).props.onChanged());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.policy-sheet.keep:deadline-date-input'
            && typeof node.props.onChangeText === 'function')[0]?.props.value).toBe('2099-01-02');
        await act(async () => { Modal.show({ component: () => <Text testID="unrelated-dialog">Other flow</Text> }); });
        await act(async () => screen.tree.update(<ModalProvider>{null}</ModalProvider>));
        expect(screen.findByTestId('managed-machine.policy-sheet.keep:choice:until-delete') === null).toBe(true);
        expect(screen.findByTestId('managed-machine.policy-sheet.keep:deadline-date-input') === null).toBe(true);
        expect(screen.findByTestId('unrelated-dialog')).not.toBeNull();
        await screen.unmount();
    });
    it.each(['executed', 'rejected', 'rejected-after-cancel'] as const)('settles the authored deadline through the existing native Ask Artifact (%s)', async status => {
        await sodium.ready;
        const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(27));
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        const target = await upsertAndActivateServer({ serverUrl: `https://managed-policy-ask-${status}.test`, scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, `srv_managed_policy_ask_${status}`);
        const token = createAccountTokenForTests('owner', { currentAccount: true });
        const authentication = readOriginalAccountActionAuthentication(token);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token });
        const controller = { machineId: 'controller', installationId: 'installation' };
        const provider = { pluginId: 'custom.provisioner', localId: 'native' };
        let machine: ManagedMachineFullV1 = { id: 'ask-policy', homeId: `srv_managed_policy_ask_${status}`, custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Retained resource', choices: {} }, controller,
            allocation: 'bound', creationState: 'active', resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        machine = { ...machine, reviewedFacts: { launch: machine.launch, controller, optionStatus: 'current',
            billing: { location: 'cloud', stoppedBilling: 'billed' }, prerequisites: [],
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention: machine.retention, wakeOnAcceptedMessage: false } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, updatedAt: Date.now() })]);
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const authored = { retention: { kind: 'deadline' as const, at: new Date(2099, 0, 2, 18, 30).getTime(),
            effect: 'delete' as const }, wakeOnAcceptedMessage: false };
        let approvalRecord: ReturnType<typeof StoredApprovalRequestSchema.parse> | undefined;
        let artifactId: string | undefined;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const qualification = staticRetentionQualification(machine, url, init);
            if (qualification) return qualification;
            const artifactResponse = artifacts.handle(url.pathname, init);
            if (artifactResponse) return artifactResponse;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname === '/v1/actions/machines.managed.retention.update') {
                const actionId = 'machines.managed.retention.update';
                const envelope = readNativeControllerRequest(init);
                if (envelope.target?.kind !== 'machine') throw new Error('Expected the native controller');
                const authorization = { v: 1 as const, token: 'native-policy-authorization', binding: {
                    accountId: 'owner', authentication, serverIdentityId: machine.homeId, machineId: controller.machineId,
                    custodianAccountId: 'owner', installationId: controller.installationId, actionId, requestId: envelope.requestId,
                    target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } };
                // The genuine native HTTP boundary publishes the signed persisted Ask record.
                approvalRecord = StoredApprovalRequestSchema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                    createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: envelope.input, summary: 'Review deadline',
                    executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId: target.id,
                        serverIdentityId: machine.homeId, accountId: 'owner', machineId: controller.machineId, target: envelope.target,
                        actionId, requestId: envelope.requestId, externalActionExecutionAuthorization: authorization,
                        externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                            actionId, input: envelope.input, target: envelope.target, privateKey: installation.privateKey }) } });
                const account = await captureLazyActionAccountContext(target.id);
                try { artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(approvalRecord), JSON.stringify(approvalRecord)); }
                finally { account.dispose(); }
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                    execution: { ok: true, result: { kind: 'approval_request_created', artifactId, actionId } } }));
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ModalProvider><ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} /></ModalProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        await screen.pressByTestIdAsync('managed-machine.policy.whenUnused');
        await screen.pressByTestIdAsync('managed-machine.policy-sheet.keep:choice:deadline');
        await act(async () => {
            screen.tree.changeTextByTestId('managed-machine.policy-sheet.keep:deadline-date-input', '2099-01-02');
        });
        await act(async () => {
            screen.tree.changeTextByTestId('managed-machine.policy-sheet.keep:deadline-time-input', '18:30');
        });
        await screen.pressByTestIdAsync('managed-machine.policy-sheet.keep:deadline:effect:delete');
        await act(async () => {
            const confirm = screen.tree.findAll(node => node.props.testID === 'managed-machine.policy-sheet.keep:deadline:confirm'
                && typeof node.props.onPress === 'function')[0];
            if (!confirm) throw new Error('Expected reviewed deadline confirmation');
            void confirm.props.onPress();
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('managed-machine.approval')).not.toBeNull();
        });
        expect(screen.tree.findAll(node => node.props.testID === 'managed-machine.policy-sheet.keep:deadline-date-input'
            && typeof node.props.onChangeText === 'function')[0]?.props.value).toBe('2099-01-02');
        if (status === 'rejected-after-cancel') {
            await screen.pressByTestIdAsync('managed-machine.policy-sheet.keep:deadline:cancel');
            expect(screen.findByTestId('managed-machine.policy-sheet.keep:deadline-date-input') === null).toBe(true);
        }
        if (!approvalRecord || !artifactId) throw new Error('Expected native Ask Artifact');
        const capturedArtifactId = artifactId;
        if (status === 'executed') machine = { ...machine, ...authored, intentRevision: 2 };
        const settled = StoredApprovalRequestSchema.parse({ ...approvalRecord, status: status === 'executed' ? 'executed' : 'rejected', updatedAtMs: 2,
            decision: { kind: status === 'executed' ? 'approve' : 'reject', decidedAtMs: 2 },
            ...(status === 'executed' ? { execution: { executedAtMs: 2, ok: true, result: machine } } : {}) });
        const account = await captureLazyActionAccountContext(target.id);
        try { await act(async () => account.updateArtifact(capturedArtifactId, buildApprovalRequestArtifactHeaderV1(settled), JSON.stringify(settled))); }
        finally { account.dispose(); }
        act(() => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            if (status === 'executed') expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject(authored);
            else expect(screen.tree.findAll(node => node.props.testID === 'managed-machine.control-error'
                && node.props.diagnosticCode === 'approval_rejected')).not.toHaveLength(0);
        });
        if (status === 'executed') {
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject(authored);
            expect(screen.findByTestId('managed-machine.policy-sheet.keep:deadline-date-input') === null).toBe(true);
        } else if (status === 'rejected-after-cancel') {
            expect(screen.findByTestId('managed-machine.policy-sheet.keep:deadline-date-input') === null).toBe(true);
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy.retention).toEqual({ kind: 'until-delete' });
        } else {
            expect(screen.tree.findAll(node => node.props.testID === 'managed-machine.policy-sheet.keep:deadline-date-input'
                && typeof node.props.onChangeText === 'function')[0]?.props.value).toBe('2099-01-02');
        }
        await screen.unmount();
    });
    it.each(['saved', 'enrolled'] as const)('presents retained credential accounts from the captured Home profile and metadata rows while another Home is focused (%s)', async surface => {
        const browserStorage = installLocalStorageMock();
        const browserLocks = installWebLockManagerMock();
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            const target = await upsertAndActivateServer({ serverUrl: 'https://credential-receipt-a.test', scope: 'tab' });
            await setServerProfileIdentityForUrl(target.serverUrl, 'srv_credential_receipt_a');
            const tokenA = createAccountTokenForTests('receipt-owner-a', { currentAccount: true });
            expect(await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: tokenA })).toBe(true);
            const focused = await upsertAndActivateServer({ serverUrl: 'https://credential-receipt-b.test', scope: 'tab' });
            await setServerProfileIdentityForUrl(focused.serverUrl, 'srv_credential_receipt_b');
            const tokenB = createAccountTokenForTests('receipt-owner-b', { currentAccount: true });
            expect(await TokenStorage.setCredentialsForServerUrl(focused.serverUrl, { serverId: focused.id }, { token: tokenB })).toBe(true);
            const service = { pluginId: 'custom.retained-accounts', localId: 'compute' };
            const accountId = 'opaque-retained-account';
            const account = { ref: { service, accountId }, status: 'connected' as const, authenticationModeId: 'manual',
                revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false,
                configurationRevision: null, displayName: 'A provider name', scopes: [] };
            const focusedScope = { serverId: resolveServerProfileScopeIdForIdentifier(focused.id), accountId: 'receipt-owner-b' };
            storage.getState().activateProfileScope(focusedScope);
            storage.getState().applyProfile({ ...profileDefaults, id: focusedScope.accountId, connectedAccountsV4: [{ ...account, displayName: 'Ambient B account' }] });
            const provider = { pluginId: 'custom.receipt-provisioner', localId: 'vm' };
            const machine: ManagedMachineFullV1 = { id: 'receipt-resource', homeId: 'srv_credential_receipt_a', custodianAccountId: 'receipt-owner-a',
                launch: { provider, credentials: [{ purpose: { consumer: provider, purpose: 'native-compute' }, account: account.ref }],
                    schemaVersion: 1, name: 'Retained guest', choices: {} }, controller: { machineId: 'controller', installationId: 'installation' },
                allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                ...(surface === 'enrolled' ? { enrolledMachineId: 'enrolled-receipt-machine' } : {}) };
            const profileReads: string[] = [];
            setRuntimeFetch(async (input, init) => {
                const url = new URL(String(input));
                const targetHome = url.origin === target.serverUrl;
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${targetHome ? tokenA : tokenB}`);
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (url.pathname === '/v1/account/entity-rows/connected-metadata/presentation') return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [
                        { v: 1, subject: { kind: 'account', account: account.ref }, label: targetHome ? 'Work on Home A' : 'Personal on Home B' },
                    ] } },
                });
                if (url.pathname === '/v1/account/entity-rows/connected-metadata/acknowledgements') return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [] } },
                });
                if (url.pathname === '/v1/account/profile') {
                    profileReads.push(url.origin);
                    return Response.json({ ...profileDefaults, id: targetHome ? 'receipt-owner-a' : 'receipt-owner-b',
                        connectedAccountsV4: [{ ...account, displayName: targetHome ? 'A provider name' : 'Ambient B account' }] });
                }
                if (url.pathname === '/v1/machines/managed/actions/get') { expect(targetHome).toBe(true); return Response.json(machine); }
                if (url.pathname === '/v1/machines/managed/actions/list') { expect(targetHome).toBe(true); return Response.json({ machines: [machine] }); }
                return Response.json({ error: 'not_found' }, { status: 404 });
            });
            screen = await renderScreen(surface === 'saved' ? <ManagedMachineDetail managedId={machine.id} serverId={target.id}
                executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} /> : <ManagedEnrolledMachineSections enrolledMachineId="enrolled-receipt-machine"
                    serverId={target.id} executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
            await flushHookEffects({ cycles: 30 });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen!.tree.findByType(MachineConfigurationReceipt).props.model.facts).toEqual(expect.arrayContaining([
                    expect.objectContaining({ id: 'credential:0', value: expect.stringContaining('Work on Home A') }),
                ]));
            });
            const receipt = screen.tree.findByType(MachineConfigurationReceipt).props.model;
            expect(receipt.name).toBe('Retained guest');
            expect(receipt.facts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'credential:0', value: expect.stringContaining('Work on Home A') })]));
            expect(profileReads.length).toBeGreaterThan(0);
            expect(profileReads.every(origin => origin === target.serverUrl)).toBe(true);
            const visible = JSON.stringify(receipt.facts);
            expect(visible).not.toContain('Ambient B account');
            expect(visible).not.toContain('Personal on Home B');
            expect(visible).not.toContain(accountId);
            expect(storage.getState().profile.id).toBe(focusedScope.accountId);
            expect(storage.getState().profile.connectedAccountsV4[0]?.displayName).toBe('Ambient B account');
        } finally { await screen?.unmount(); browserLocks.restore(); browserStorage.restore(); }
    });
    it('offers resource custodian Move candidates to a shared manager and revalidates custody before dispatch', async () => {
        await sodium.ready;
        const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(19));
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-shared-move.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_shared_move');
        const token = createAccountTokenForTests('manager', { currentAccount: true });
        const authentication = readOriginalAccountActionAuthentication(token);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token });
        const controller = { machineId: 'shared-original', installationId: 'shared-original-installation' };
        const destination = { machineId: 'custodian-destination', installationId: 'custodian-destination-installation' };
        const requesterOwned = { machineId: 'requester-owned', installationId: 'requester-owned-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        const rows = [controller, destination, requesterOwned].map(row => createMachineFixture({ id: row.machineId,
            installationId: row.installationId, updatedAt: Date.now(), access: {
                custodian: { accountId: row === requesterOwned ? 'manager' : 'resource-owner', displayName: 'Custodian' },
                role: 'manage', resourceMode: 'plain', accessState: 'ready',
            } }));
        await publishMachineInventoryForTest({ serverId, accountId: 'manager' }, rows);
        const provider = { pluginId: 'custom.shared-move', localId: 'vm' };
        const credentials = ['compute', 'desktop'].map(purpose => ({ purpose: { consumer: provider, purpose },
            account: { service: { pluginId: 'custom.accounts', localId: purpose }, accountId: `${purpose}-account` } }));
        const machine: ManagedMachineFullV1 = { id: 'shared-managed', homeId: 'srv_managed_shared_move', custodianAccountId: 'resource-owner',
            launch: { provider, credentials: credentials.map(credential => ({ ...credential, configurationRevision: 'reviewed-config' })),
                schemaVersion: 1, name: 'Shared guest', choices: {} }, controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { nativeId: 'retained-shared-resource' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 5, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const provisioner = { contribution: provider, occurrenceId: 'occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: 'vm', title: 'Guest', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        const checked: unknown[] = [];
        const moves: unknown[] = [];
        const actionIds = ['machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options', 'machines.managed.controller.update'] as const;
        const publishedRows = rows.map(row => ({
            ...createPlainMachineRowFixture({ id: row.id, accountId: row.access!.custodian.accountId }),
            access: row.access, installationId: row.installationId, installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
        }));
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-shared-move.test');
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname === '/v1/machines') return Response.json(publishedRows);
            if (url.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => publishedRows.find(row => row.id === id) ?? null);
            const mintAction = actionIds.find(actionId => url.pathname === bindExternalActionExecutionAuthorizationHttpPathV1(actionId));
            if (mintAction) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                if (request.envelope.target?.kind !== 'machine') throw new Error('Expected a native controller');
                const machineId = request.envelope.target.machineId;
                const row = rows.find(row => row.id === machineId)!;
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'shared-native-authorization', binding: {
                    accountId: 'manager', authentication, serverIdentityId: machine.homeId, machineId: row.id,
                    custodianAccountId: row.access!.custodian.accountId, installationId: row.installationId, accountEncryptionMode: 'plain',
                    actionId: mintAction, requestId: request.envelope.requestId, target: request.envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                } }));
            }
            const actionId = actionIds.find(actionId => url.pathname === `/v1/actions/${actionId}`);
            if (actionId) {
                const body: unknown = JSON.parse(String(init?.body));
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
                const request = carrier.success ? ExternalActionRequestEnvelopeV1Schema.parse(carrier.data.envelope) : ExternalActionRequestEnvelopeV1Schema.parse(body);
                if (actionId === 'machines.provisioners.check') checked.push(request.input);
                if (actionId === 'machines.managed.controller.update') moves.push(request.input);
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.check' ? { available: true }
                        : actionId === 'machines.provisioners.options' ? createMachineProvisionerOptionsFixture({ base: { launch: machine.launch.choices } })
                        : { kind: 'approval_request_created', artifactId: 'shared-move-approval', actionId };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachineControllerSection).props.controller.move.kind).toBe('movable');
        });
        const move = screen.tree.findByType(ManagedMachineControllerSection).props.controller.move;
        expect(move.kind).toBe('movable');
        await act(async () => move.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedControllerMoveList).props.candidates
                .find((row: { id: string }) => row.id === destination.machineId)?.reachable).toBe(true);
        });
        const candidates = screen.tree.findByType(ManagedControllerMoveList).props.candidates;
        expect(candidates.find((row: { id: string }) => row.id === destination.machineId)?.reachable).toBe(true);
        expect(candidates.find((row: { id: string }) => row.id === requesterOwned.machineId)?.reachable).toBe(false);
        expect(checked).toContainEqual({ homeId: machine.homeId, controller: destination, contribution: provider, credentials });
        await act(async () => publishMachineInventoryForTest({ serverId, accountId: 'manager' }, rows.map(row => row.id === destination.machineId
            ? { ...row, access: { ...row.access!, custodian: { accountId: 'manager', displayName: 'Manager' } } } : row)));
        await act(async () => screen.tree.findByType(ManagedControllerMoveList).props.onMove(destination.machineId));
        await flushHookEffects({ cycles: 10 });
        expect(moves).toEqual([]);
        await act(async () => publishMachineInventoryForTest({ serverId, accountId: 'manager' }, rows));
        await act(async () => screen.tree.findByType(ManagedControllerMoveList).props.onMove(destination.machineId));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(moves, JSON.stringify({ errors: screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error')
                .map(node => node.props.diagnosticCode), httpFacts })).toEqual([{ homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 5,
                controller: destination, reviewedPendingEffects: true }]);
        });
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toEqual(machine);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
    });
    it('reloads the canonical moved controller after native binding repair fails, without replaying Move or applying failure details locally', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-move-partial.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_move_partial');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'partial-original', installationId: 'partial-original-installation' };
        const destination = { machineId: 'partial-destination', installationId: 'partial-destination-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [controller, destination].map(row => createMachineFixture({
            id: row.machineId, installationId: row.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })));
        const provider = { pluginId: 'custom.partial', localId: 'vm' };
        const credential = { purpose: { consumer: provider, purpose: 'native-compute' },
            account: { service: { pluginId: 'custom.credentials', localId: 'cloud' }, accountId: 'partial-account' } };
        const desktopCredential = { purpose: { consumer: provider, purpose: 'desktop-control' },
            account: { service: { pluginId: 'custom.credentials', localId: 'desktop' }, accountId: 'partial-desktop-account' } };
        const publicCredentials = [credential, desktopCredential];
        const machine: ManagedMachineFullV1 = { id: 'partial-resource', homeId: 'srv_managed_move_partial', custodianAccountId: 'owner',
            launch: { provider, credentials: [
                { ...credential, configurationRevision: 'cloud-config-3' },
                { ...desktopCredential, configurationRevision: 'desktop-config-7' },
            ], schemaVersion: 1, name: 'Guest', choices: {} }, controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { nativeId: 'original-paid-resource' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 5, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const moved = { ...machine, controller: destination, intentRevision: 6 };
        const provisioner = { contribution: provider, occurrenceId: 'occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: 'vm', title: 'Guest', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        const submitted: unknown[] = [];
        const credentialChecks: unknown[] = [];
        let currentMachine = machine;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-move-partial.test');
            const machines = managedControllerReadBatch(currentMachine, url, init, [controller, destination]);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(currentMachine, url, init, [controller, destination]);
            if (authorization) return authorization;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/entity-rows/connected-metadata/presentation') return Response.json(
                ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'present', revision: 0, content: { t: 'plain', v: { v: 1,
                    entries: publicCredentials.map((selected, index) => ({ v: 1, subject: { kind: 'account', account: selected.account },
                        label: index === 0 ? 'Cloud Work account' : 'Desktop Work account' })),
                } } }));
            if (url.pathname === '/v1/account/entity-rows/connected-metadata/acknowledgements') return Response.json(
                ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [] } } }));
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'owner',
                connectedAccountsV4: publicCredentials.map((selected, index) => ({ ref: selected.account,
                    status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
                    credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null,
                    displayName: index === 0 ? 'Cloud Work account' : 'Desktop Work account', scopes: [] })) });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(currentMachine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (actionId === 'machines.provisioners.check') credentialChecks.push(request.input);
                if (actionId === 'machines.managed.controller.update') {
                    submitted.push(request.input);
                    currentMachine = moved;
                    return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: false,
                        errorCode: 'managed_binding_move_incomplete', error: 'managed_binding_move_incomplete',
                        details: { machine: { ...moved, intentRevision: 999 }, code: 'scope_binding_refused' } } });
                }
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.options' ? createMachineProvisionerOptionsFixture({ base: { launch: machine.launch.choices } })
                        : { available: true };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachineControllerSection).props.controller.move.kind).toBe('movable');
        });
        await act(async () => screen.tree.findByType(ManagedMachineControllerSection).props.controller.move.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedControllerMoveList).props.candidates
                .find((row: { id: string }) => row.id === destination.machineId)?.reachable).toBe(true);
        });
        const reachable = screen.tree.findByType(ManagedControllerMoveList).props.candidates
            .find((row: { id: string }) => row.id === destination.machineId);
        expect(reachable.subtitle).toContain('Cloud Work account');
        expect(reachable.subtitle).toContain('Desktop Work account');
        expect(reachable.subtitle).not.toContain(credential.account.accountId);
        expect(reachable.subtitle).not.toContain(desktopCredential.account.accountId);
        expect(credentialChecks).toContainEqual({ homeId: machine.homeId, controller: destination, contribution: provider,
            credentials: publicCredentials });
        await act(async () => screen.tree.findByType(ManagedControllerMoveList).props.onMove(destination.machineId));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(submitted).toHaveLength(1);
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error')
                .map(node => node.props.diagnosticCode)).toContainEqual(expect.stringMatching(/^managed_binding_move_incomplete(?: · |$)/u));
            expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toMatchObject({ controller: destination, intentRevision: 6, resource: machine.resource });
        });
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toMatchObject({ controller: destination, intentRevision: 6, resource: machine.resource });
    });
    it.each(['machines.provisioners.list', 'machines.provisioners.options'] as const)(
        'consumes a native %s approval after 30 seconds without losing its policy parent or asking again', async approvedAction => {
        await sodium.ready;
        const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(7));
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-parent-approval.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_parent_approval');
        const token = createAccountTokenForTests('owner', { currentAccount: true });
        const authentication = readOriginalAccountActionAuthentication(token);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token });
        const controller = { machineId: 'parent-controller', installationId: 'parent-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now() })]);
        const provider = { pluginId: 'custom.parent', localId: 'vm' };
        const machine: ManagedMachineFullV1 = { id: 'parent-resource', homeId: 'srv_managed_parent_approval', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} }, controller,
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: provider, schemaVersion: 1, value: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const provisioner = { contribution: provider, occurrenceId: 'occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: 'vm', title: 'Guest', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const reads: string[] = [];
        const parentCatalogInputs: unknown[] = [];
        let settleApproval: (() => Promise<void>) | undefined;
        let currentMachine = machine;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const machines = managedControllerReadBatch(currentMachine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(currentMachine, url, init);
            if (authorization) return authorization;
            const artifactResponse = artifacts.handle(url.pathname, init);
            if (artifactResponse) return artifactResponse;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(currentMachine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const envelope = readNativeControllerRequest(init);
                if (envelope.target?.kind !== 'machine') throw new Error('Expected the captured native controller target');
                reads.push(actionId);
                if (actionId === 'machines.provisioners.list') parentCatalogInputs.push(envelope.input);
                if (actionId === approvedAction) {
                    // This genuine daemon HTTP boundary publishes the current ordinary UI origin.
                    // Admission and Home-token verification stay outside the mounted UI process.
                    const authorization = { v: 1 as const, token: 'native-daemon-authorization', binding: {
                        accountId: 'owner', authentication, serverIdentityId: machine.homeId,
                        machineId: controller.machineId, custodianAccountId: 'owner', installationId: controller.installationId,
                        actionId: approvedAction, requestId: envelope.requestId, target: envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    } };
                    const request = StoredApprovalRequestSchema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
                        createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: envelope.input, summary: 'Read available provisioners',
                        decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 2, ok: true,
                            result: approvedAction === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                                : createMachineProvisionerOptionsFixture({ base: { launch: machine.launch.choices } }) },
                        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId: target.id,
                            serverIdentityId: machine.homeId, accountId: 'owner', machineId: controller.machineId, target: envelope.target,
                            actionId, requestId: envelope.requestId, externalActionExecutionAuthorization: authorization,
                            externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                                actionId, input: envelope.input, target: envelope.target, privateKey: installationKey.privateKey }) } });
                    const account = await captureLazyActionAccountContext(target.id);
                    let artifactId: string;
                    const firstApproval = settleApproval === undefined;
                    const initial = firstApproval ? StoredApprovalRequestSchema.parse({ ...request, status: 'open', decision: undefined, execution: undefined }) : request;
                    try { artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(initial), JSON.stringify(initial)); }
                    finally { account.dispose(); }
                    if (firstApproval) settleApproval = async () => {
                        const current = await captureLazyActionAccountContext(target.id);
                        try { await current.updateArtifact(artifactId, buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)); }
                        finally { current.dispose(); }
                        // Another device's committed approval wakes the exact-Home reader even when this
                        // Account is not the focused store's publication target.
                        publishHomeAccountChange(target.id, [artifactId], { changeKinds: ['artifact'] });
                    };
                    return Response.json({ v: 1, requestId: envelope.requestId, actionId,
                        execution: { ok: true, result: { kind: 'approval_request_created', artifactId, actionId } } });
                }
                if (actionId === 'machines.managed.retention.update') {
                    currentMachine = { ...machine, intentRevision: 3, retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true };
                    return Response.json({ v: 1, requestId: envelope.requestId, actionId, execution: { ok: true, result: currentMachine } });
                }
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.options' ? createMachineProvisionerOptionsFixture({ base: { launch: machine.launch.choices } })
                        : { available: true };
                return Response.json({ v: 1, requestId: envelope.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(artifacts.list()).toHaveLength(1);
                expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
            });
            await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1); });
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeUndefined();
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
            expect(settleApproval).toBeTypeOf('function');
            await act(async () => settleApproval!());
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
            });
        } finally { vi.useRealTimers(); }
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifacts.list()[0]!.id) ?? 'null'))).toMatchObject({
            status: 'executed', actionId: approvedAction, execution: { ok: true },
            executionOriginV1: { surface: 'ui', authority: 'present_user', accountId: 'owner', serverIdentityId: machine.homeId,
                externalActionExecutionAuthorization: { binding: { machineId: controller.machineId, installationId: controller.installationId } } },
        });
        expect(reads.filter(id => id === 'machines.provisioners.list')).toHaveLength(1);
        expect(parentCatalogInputs).toEqual([{ homeId: machine.homeId, controller, contribution: provider }]);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
        await act(async () => screen.tree.findByType(ManagedMachinePolicySection).props.keep.onChange({
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true,
        }));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(reads.filter(id => id === 'machines.managed.retention.update')).toHaveLength(1);
            expect(reads.filter(id => id === 'machines.provisioners.list')).toHaveLength(2);
            expect(artifacts.list()).toHaveLength(2);
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject({ intentRevision: 3 });
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
        });
        expect(artifacts.list()).toHaveLength(2);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject({ intentRevision: 3 });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
    });
    it.each(['modal', 'aws', 'gcp', 'descriptor-fallback', 'unavailable', 'different-launch', 'refresh-unavailable', 'refresh-equal'] as const)(
        'qualifies live BYOC retention from the current exact native variant, not the creation receipt (%s)', async variant => {
        const target = await upsertAndActivateServer({ serverUrl: `https://managed-live-variant-${variant}.test`, scope: 'tab' });
        const homeId = `srv_managed_live_variant_${variant}`;
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'variant-controller', installationId: 'variant-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now() })]);
        const finite = variant === 'modal' || variant === 'unavailable' || variant === 'different-launch' || variant === 'refresh-unavailable';
        const cloud = variant === 'aws' || variant === 'gcp' ? variant : 'modal';
        const provider = { pluginId: 'happier.machine.cua', localId: 'byoc' };
        const choices = PluginJsonValueV2Schema.parse({
            cloud, region: 'native-region', nativeImageId: 'native-image', nativeSizeId: 'native-size',
            nativeLifetime: cloud === 'modal' ? { kind: 'finite' as const, durationSeconds: 7200 } : { kind: 'no-native-ttl' as const },
        });
        if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new Error('Expected native BYOC launch choices');
        const launch: ManagedMachineFullV1['launch'] = { provider, schemaVersion: 1, name: 'Retained BYOC', choices };
        const machine: ManagedMachineFullV1 = { id: 'variant-resource', homeId, custodianAccountId: 'owner', launch, controller,
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            retention: finite ? { kind: 'unused', afterMs: 3_600_000, effect: 'delete' } : { kind: 'until-delete' },
            wakeOnAcceptedMessage: !finite,
            observation: { observedAt: 1_790_001_000_000, availability: 'present', nativeExpiry: 1_790_008_200_000 },
            // Deliberately opposite to today's native variant: historical review is not live capability authority.
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'billed' },
                prerequisites: [], retentionCapabilities: variant === 'unavailable' || variant === 'different-launch' || variant === 'refresh-unavailable'
                    ? { supportedIntents: ['delete'], finiteOnly: true } : finite ? { supportedIntents: ['start', 'stop', 'delete'] }
                    : { supportedIntents: ['delete'], finiteOnly: true }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                ...(cloud === 'modal' ? { nativeFacts: { duration: { id: '7200', title: '7200 s', afterMs: 7_200_000 } } } : {}) } };
        ManagedMachineV1Schema.parse(machine);
        const provisioner = { contribution: provider, occurrenceId: `variant-occurrence-${variant}`, acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: 'byoc', title: 'Cua BYOC', icon: 'server', resourceKind: 'cua-byoc-resource', schemaVersion: 1,
            launchSchema: { type: 'object', properties: { cloud: { type: 'string' }, region: { type: 'string' },
                nativeImageId: { type: 'string' }, nativeSizeId: { type: 'string' }, nativeLifetime: { type: 'object',
                    properties: { kind: { type: 'string' }, durationSeconds: { type: 'integer' } }, additionalProperties: false } }, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
            retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'byoc-check', options: 'byoc-options', acquire: 'byoc-acquire', bootstrap: 'byoc-bootstrap', inspect: 'byoc-inspect', power: 'byoc-power', destroy: 'byoc-destroy' } } };
        MachineProvisionersListResultV1Schema.parse({ provisioners: [provisioner] });
        operationRpcBoundary.schemaAnswer = { ok: true, inputSchema: { type: 'object', properties: {
            cloud: { type: 'string', enum: ['aws', 'gcp', 'modal'] } }, required: ['cloud'], additionalProperties: false } };
        const optionInputs: unknown[] = [];
        const policyWrites: unknown[] = [];
        let refreshFailed = false;
        const initialOptions = variant === 'unavailable' || variant === 'different-launch' ? createDeferred<void>() : null;
        const refreshOptions = variant === 'refresh-equal' ? createDeferred<void>() : null;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                machineRetentionDefaultsV1: { v: 1, 'stopped-billed': { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } },
            } }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (actionId === 'machines.provisioners.options') {
                    optionInputs.push(request.input);
                    await initialOptions?.promise;
                    if (optionInputs.length > 1) await refreshOptions?.promise;
                }
                if (actionId === 'machines.managed.retention.update') policyWrites.push(request.input);
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.options' ? MachineProvisionerOptionsResultV1Schema.parse(createMachineProvisionerOptionsFixture({ base: {
                        launch: variant === 'different-launch' ? { ...choices, nativeSizeId: 'other-native-size' } : launch.choices,
                        available: variant !== 'unavailable' && !refreshFailed, ...(variant === 'descriptor-fallback' ? {} : {
                            retention: finite ? { supportedIntents: ['delete'], finiteOnly: true } : { supportedIntents: ['start', 'stop', 'delete'], finiteOnly: false },
                        }) } })) : actionId === 'machines.managed.inspect' ? { machine } : { available: true };
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, requestId: request.requestId, actionId,
                    execution: { ok: true, result } }));
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ModalProvider><ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} /></ModalProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(optionInputs).toHaveLength(1);
        });
        if (initialOptions) {
            const loadingSection = screen.tree.findByType(ManagedMachinePolicySection);
            expect(loadingSection.props.keep.disabled).toBe(true);
            if (loadingSection.props.compactSummary) await act(async () => loadingSection.props.compactSummary.onPress());
            // The rule keeps its rows while it is read-only, so none of them can be chosen yet.
            expect(enabledKeepChoices(screen, ['until-delete', 'deadline'])).toEqual([]);
            await act(async () => initialOptions.resolve());
        }
        if (variant !== 'unavailable' && variant !== 'different-launch') await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        else await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep).toMatchObject({
                capabilitiesAvailable: false,
                unavailableReason: expect.any(String),
            });
        });
        if (variant === 'refresh-equal') {
            const settledPolicy = screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy;
            const check = screen.tree.findAllByType(RoundButton).find(button =>
                button.props.testID === 'managed-machine.progress:checkNow' || button.props.testID === 'managed-machine.observation-check');
            await act(async () => check!.props.onPress());
            await waitForHomeGovernance(() => expect(optionInputs).toHaveLength(2));
            try {
                expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.capabilitiesAvailable).toBe(true);
                expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBe(settledPolicy);
            } finally { refreshOptions?.resolve(); }
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBe(settledPolicy);
        }
        if (variant === 'refresh-unavailable') {
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
            refreshFailed = true;
            // A completed Action re-reads the parent: Check now is the real one that changes no state but observes.
            const check = screen.tree.findAllByType(RoundButton).find(button =>
                button.props.testID === 'managed-machine.progress:checkNow' || button.props.testID === 'managed-machine.observation-check');
            await act(async () => check!.props.onPress());
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep).toMatchObject({
                    capabilitiesAvailable: false,
                    unavailableReason: expect.any(String),
                });
            });
        }
        const keep = screen.tree.findByType(ManagedMachinePolicySection).props.keep;
        if (variant === 'unavailable' || variant === 'different-launch' || variant === 'refresh-unavailable') {
            expect(keep.defaultPolicy).toBeUndefined();
            expect(keep.disabled).toBe(true);
            const section = screen.tree.findByType(ManagedMachinePolicySection);
            if (section.props.compactSummary) await act(async () => section.props.compactSummary.onPress());
            expect(enabledKeepChoices(screen, ['until-delete', 'deadline'])).toEqual([]);
            await act(async () => keep.onChange({ retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true }));
            expect(policyWrites).toEqual([]);
            expect(screen.tree.findByType(MachineConfigurationReceipt).props.model.name).toBe('Retained BYOC');
            // One Check now: the state row owns it; the observation row only dates the facts.
            expect(screen.findByTestId('managed-machine.progress:checkNow')).not.toBeNull();
            expect(screen.findByTestId('managed-machine.observation-check')).toBeNull();
        } else {
            expect(keep.defaultPolicy).toBeDefined();
            expect(keep.finiteOnly === true).toBe(finite);
            expect(keep.effects).toEqual(finite ? ['delete'] : ['stop', 'delete']);
            expect(keep.canWake).toBe(!finite);
            // The observation reports no power: neither Start nor Stop is offered until Check now observes it.
            expect(screen.findByTestId('managed-machine.start')).toBeNull();
            expect(screen.findByTestId('managed-machine.stop')).toBeNull();
            expect(keep.defaultPolicy).toMatchObject({ retention: finite ? { kind: 'unused', effect: 'delete' }
                : { kind: 'until-delete' }, wakeOnAcceptedMessage: !finite });
            // A machine that kept its parent's rule is not "changed for" it: the parent is compared as a policy, not its resolution record.
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.description).toBe(t('managedRetention.policyDescription'));
            if (screen.tree.findByType(ManagedMachinePolicySection).props.compactSummary)
                await act(async () => screen.tree.findByType(ManagedMachinePolicySection).props.compactSummary.onPress());
            if (finite) {
                expect(screen.tree.findAllByType(Item).filter(item => item.props.title === t('managedRetention.ends'))).toHaveLength(1);
                expect(screen.tree.findByType(MachineConfigurationReceipt).props.model.facts.some((fact: { id: string }) => fact.id === 'duration')).toBe(false);
                expect(screen.getTextContent()).toContain(t('managedRetention.nativeExpiry', {
                    provider: 'Cua BYOC', time: formatAsOfTime(machine.observation!.nativeExpiry!),
                }));
                expect(screen.findByTestId('managed-machine.policy-sheet:choice:deadline')).toBeNull();
            }
        }
        expect(optionInputs).toContainEqual({ homeId, controller, contribution: provider, selectors: { cloud } });
        await screen.unmount();
    });
    // OWNER-RULINGS 2026-11-08: Ends uses configured native limits until a real expiry is observed.
    it.each([{ observed: true, configured: true }, { observed: false, configured: true }, { observed: false, configured: false }])(
      'discloses native Ends facts without offering creation-duration changes (observed: $observed, configured: $configured)', async ({ observed, configured }) => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-finite-detail.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_finite');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'finite-controller', installationId: 'finite-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now() })]);
        const provider = { pluginId: 'custom.finite', localId: 'guest' };
        let machine: ManagedMachineFullV1 = { id: 'finite-resource', homeId: 'srv_managed_finite', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Finite guest', choices: { duration: 'original-duration' } }, controller,
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'delete' }, wakeOnAcceptedMessage: false,
            ...(observed ? { observation: { observedAt: 1_790_001_000_000, availability: 'present' as const,
                nativeExpiry: 1_790_008_200_000 } } : {}) };
        if (configured) machine = { ...machine, reviewedFacts: {
            launch: machine.launch, controller, optionStatus: 'current', prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' },
            retentionCapabilities: { supportedIntents: ['delete'], finiteOnly: true },
            retention: machine.retention, wakeOnAcceptedMessage: false,
            nativeFacts: { duration: { id: '3600', title: '1 hour', afterMs: 3_600_000, idleAfterMs: 600_000 } },
        } };
        const provisioner = { contribution: provider, occurrenceId: 'finite-occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: 'guest', title: 'Finite guest', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: { duration: { type: 'string' } }, required: ['duration'], additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
            retention: { supportedIntents: ['delete'], finiteOnly: true, nativeExpiry: { kind: 'unused', afterMs: 7_200_000 } },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.options' ? createMachineProvisionerOptionsFixture({ base: { launch: machine.launch.choices } })
                        : { available: true };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.finiteOnly).toBe(true);
        });
        const keep = screen.tree.findByType(ManagedMachinePolicySection).props.keep;
        expect(keep.finiteOnly).toBe(true);
        expect(keep.nativeExpiry).toBe(observed ? t('managedRetention.nativeExpiry', {
            provider: 'Finite guest', time: formatAsOfTime(machine.observation!.nativeExpiry!),
        }) : configured ? t('managedRetention.configuredLimits', {
            provider: 'Finite guest', lifetime: formatRetentionDuration(3_600_000), idle: formatRetentionDuration(600_000),
        }) : undefined);
        if (observed) {
            expect(screen.getTextContent()).toContain(t('surfaceState.asOf', { time: formatAsOfTime(machine.observation!.observedAt) }));
            // One Check now: the state row owns it; the observation row only dates the facts.
            expect(screen.findByTestId('managed-machine.progress:checkNow')).not.toBeNull();
            expect(screen.findByTestId('managed-machine.observation-check')).toBeNull();
        }
        expect(keep.nativeDuration).toBeUndefined();
        expect(keep.policy.retention).toEqual(machine.retention);
    });
    it.each([
        { allocation: 'confirmed-absent', consoleUrl: undefined },
        { allocation: 'may-exist', consoleUrl: undefined },
        { allocation: 'may-exist', consoleUrl: undefined, noNativeRef: true },
        { allocation: 'bound', consoleUrl: undefined },
        { allocation: 'bound', consoleUrl: 'https://console.vendor.test/resources/exact-native-id' },
        { allocation: 'bound', consoleUrl: undefined, providerListed: true },
    ] as const)('reviews manual responsibility before removing a $allocation resource through Home admission while preserving its recovery record ($consoleUrl; provider listed: $providerListed)', async scenario => {
        const { allocation, consoleUrl } = scenario;
        const openConsole = vi.fn();
        vi.stubGlobal('open', openConsole);
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-retire-review.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_retire');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'retire-controller', installationId: 'retire-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })]);
        const provider = { pluginId: 'custom.compute', localId: 'guest' };
        const machine: ManagedMachineFullV1 = { id: 'ended-resource', homeId: 'srv_managed_retire', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Ended guest', choices: {} }, controller,
            allocation, creationState: 'canceled', desired: 'delete', desiredWhen: 'now', intentRevision: 7,
            ...(allocation === 'may-exist' ? {
                ...('noNativeRef' in scenario ? { cleanup: { disposition: 'pending' as const, reason: 'creation_canceled' } }
                    : { nativeOperationRef: { contributionRef: provider, schemaVersion: 1, value: { operationId: 'unknown-native-submission' } } }),
                recovery: { reference: 'original-native-recovery', reason: 'submission_result_unknown' },
            } : { resource: allocation === 'confirmed-absent' ? undefined : { contributionRef: provider, schemaVersion: 1,
                value: { nativeId: 'original-native-id', cloud: 'native-cloud', region: 'native-region' } },
                ...(allocation === 'bound' ? { cleanup: { disposition: 'unavailable' as const, reason: 'native_records_missing' },
                    recovery: { reference: 'original-native-id · native-cloud · native-region', reason: 'native_records_missing',
                        ...(consoleUrl ? { consoleUrl } : {}) } } : {}) }),
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const failedAcquire: ActionOperationSnapshotV1 = { version: 1, operationId: 'failed-before-cancel', revision: 2,
            actionId: 'machines.managed.acquire', state: 'failed', scope: { accountId: 'owner', machineId: controller.machineId },
            title: 'Create machine', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, ...(machine.resource ? { controller, resource: machine.resource } : {}) },
            error: { errorCode: 'action_failed', error: 'saved_secret_account_lifetime_changed' } };
        operationRpcBoundary.answer = { items: [failedAcquire], nextCursor: null };
        const archived = ManagedMachineFullV1Schema.parse({ ...machine, archivedAt: 10, intentRevision: 8,
            cleanup: { disposition: 'unavailable', reason: 'manual_responsibility' } });
        const retired: unknown[] = [];
        let settledDetailReads = 0;
        const realExecute = createFrontDoorActionExecute(createDefaultActionExecutor());
        const executeAction: typeof realExecute = Object.assign(async (...args: Parameters<typeof realExecute>) => {
            // Count read starts at the Action boundary. An aborted read can be canceled before HTTP.
            if (args[0] === 'machines.managed.get' && retired.length) settledDetailReads += 1;
            return realExecute(...args);
        }, { confirmed: realExecute.confirmed, prepare: realExecute.prepare });
        const nativeActions: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-retire-review.test');
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(retired.length ? archived : machine);
            if (url.pathname === '/v1/machines/managed/controller/admit-control') {
                const request = ManagedControlAdmissionInputV1Schema.parse(JSON.parse(String(init?.body)));
                expect(request.action).toBe('machines.managed.retire');
                retired.push(request.input);
                return Response.json(ManagedAdmissionOutputV1Schema.parse({ machine: archived, replayed: false }));
            }
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                nativeActions.push(actionId);
                const request = readNativeControllerRequest(init);
                if ('providerListed' in scenario) {
                    const qualification = staticRetentionQualification(machine, url, { ...init, body: JSON.stringify(request) });
                    if (qualification) return qualification;
                }
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [] }
                    : { kind: 'approval_request_created', artifactId: 'retire-approval', actionId };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={executeAction} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => ['managed-machine.progress:remove', 'managed-machine.remove'].includes(node.props?.testID)
                && typeof node.props.onPress === 'function'), JSON.stringify({
                    states: screen.tree.findAllByType(ManagedMachineStateRow).map(node => ({ state: node.props.state,
                        handlers: Object.keys(node.props.handlers ?? {}) })), nativeActions,
                })).not.toHaveLength(0);
        });
        // A current read has no header Retry; a canceled creation, like a resource confirmed gone, has no Keep or When unused left to set (UIR5c).
        expect(screen.findByTestId('managed-machine.refresh')).toBeNull();
        expect(screen.tree.findAllByType(ManagedMachinePolicySection)).toHaveLength(0);
        if (allocation === 'confirmed-absent') {
            // Canceled before any resource was bound: it never existed, so it reads as canceled, not "no longer exists" (VD E1).
            expect(screen.tree.findByType(ManagedMachineStateRow).props.state.kind).toBe('creationCanceled');
            expect(screen.getTextContent()).not.toContain(t('managedMachines.creation.installFailedTitle', { name: machine.launch.name }));
            expect(screen.tree.findAllByType(MachineConfigurationReceipt)).toHaveLength(1);
        }
        const consoleAction = screen.findByTestId('managed-machine.progress:openProvider');
        if (machine.recovery) expect(screen.getTextContent()).toContain(machine.recovery.reference);
        if (consoleUrl) {
            expect(consoleAction).not.toBeNull();
            await act(async () => screen.pressByTestId('managed-machine.progress:openProvider'));
            expect(openConsole).toHaveBeenCalledWith(consoleUrl, '_blank', 'noopener,noreferrer');
        } else {
            expect(consoleAction).toBeNull();
            // Where to look is the Recovery section's description, not a title-weight row (TH D-J).
            if (allocation === 'bound') expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.recovery'
                && node.props.description === t('managedCleanup.consoleHelp'))).not.toHaveLength(0);
        }
        expect(retired).toEqual([]);
        if ('noNativeRef' in scenario) expect(screen.findByTestId('managed-machine.progress:remove')).not.toBeNull();
        const remove = screen.tree.findAll(node => ['managed-machine.progress:remove', 'managed-machine.remove'].includes(node.props?.testID)
            && typeof node.props.onPress === 'function')[0];
        expect(remove).toBeDefined();
        await act(async () => remove!.props.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.remove-confirm' && typeof node.props.onPress === 'function')).not.toHaveLength(0);
        });
        expect(retired).toEqual([]);
        const confirm = screen.tree.findAll(node => node.props?.testID === 'managed-machine.remove-confirm' && typeof node.props.onPress === 'function')[0];
        expect(confirm).toBeDefined();
        expect(confirm!.props.title ?? confirm!.props.label).toBe(allocation === 'confirmed-absent'
            ? t('managedMachines.actions.remove') : t('managedCleanup.acceptManual'));
        await act(async () => confirm!.props.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(retired, JSON.stringify({ diagnosticCodes: screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error'
                && typeof node.props.diagnosticCode === 'string').map(node => node.props.diagnosticCode), httpFacts, nativeActions }))
                .toEqual([{ homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 7, manualResponsibility: true }]);
            expect(screen.findByTestId('managed-machine.control-error')).toBeNull();
            expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toEqual(archived);
        });
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.creationState).toBe('canceled');
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.recovery').length > 0).toBe(Boolean(machine.resource || machine.recovery));
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toEqual(archived);
        // The bill consequence is said once, in the state's own banner (TH D-J).
        if (allocation !== 'confirmed-absent') expect(screen.getTextContent().split(t('managedMachines.creation.mayBill')).length - 1).toBe(1);
        expect(nativeActions).not.toContain('machines.managed.delete');
        expect(nativeActions).not.toContain('machines.managed.inspect');
        expect(nativeActions).not.toContain('machines.managed.retire');
        expect(screen.findByTestId('managed-machine.approval')).toBeNull();
        expect(settledDetailReads).toBe(1);
    });
    it.each(['offline', 'missing', 'missing-local', 'missing-nonmanager'] as const)('offers Move only with current authority and a same-credential destination (%s)', async controllerState => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-move-candidates.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_move');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests(
            controllerState === 'missing-nonmanager' ? 'viewer' : 'owner', { currentAccount: true }) });
        const controller = { machineId: 'original', installationId: 'original-installation' };
        const next = { machineId: 'reachable', installationId: 'reachable-installation' };
        const blocked = { machineId: 'blocked', installationId: 'blocked-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        const location = controllerState === 'missing-local' ? 'local' : 'cloud';
        await publishMachineInventoryForTest({ serverId, accountId: controllerState === 'missing-nonmanager' ? 'viewer' : 'owner' },
            (controllerState === 'offline' ? [controller, next, blocked] : [next, blocked]).map(row => createMachineFixture({
                id: row.machineId, installationId: row.installationId, updatedAt: Date.now(),
                ...(row.machineId === controller.machineId ? { active: false, activeAt: 1 } : {}),
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })));
        const provider = { pluginId: 'custom.compute', localId: 'vm' };
        const credential = { purpose: { consumer: provider, purpose: 'native-compute' },
            account: { service: { pluginId: 'custom.credentials', localId: 'cloud' }, accountId: 'same-cloud-account' } };
        const launch: ManagedMachineFullV1['launch'] = { provider, credentials: [credential], schemaVersion: 1, name: 'Managed cloud', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'move-managed', homeId: 'srv_managed_move', custodianAccountId: 'owner', launch,
            controller, allocation: 'bound', creationState: 'active', resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            desired: 'start', desiredWhen: 'now', intentRevision: 9, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location, stoppedBilling: 'billed' },
                prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const provisioner = { contribution: provider, occurrenceId: 'occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location, stoppedBilling: 'billed' },
            retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        const checked: unknown[] = [];
        const moves: unknown[] = [];
        const moveTargets: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-move-candidates.test');
            const machines = managedControllerReadBatch(machine, url, init, [controller, next, blocked]);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init, [controller, next, blocked]);
            if (authorization) return authorization;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (request.target?.kind === 'machine' && request.target.machineId === controller.machineId) {
                    return Response.json({ error: 'target_unavailable', code: 'target_unavailable', requestId: request.requestId }, { status: 409 });
                }
                if (actionId === 'machines.provisioners.check') checked.push(request.input);
                if (actionId === 'machines.managed.controller.update') { moves.push(request.input); moveTargets.push(request.target); }
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.check' ? { available: request.target?.kind === 'machine' && request.target.machineId !== blocked.machineId }
                        : actionId === 'machines.provisioners.options' ? createMachineProvisionerOptionsFixture({ base: { launch: machine.launch.choices } })
                        : { kind: 'approval_request_created', artifactId: 'move-approval', actionId };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAllByType(MachineConfigurationReceipt)).toHaveLength(1);
        });
        if (controllerState === 'missing-local' || controllerState === 'missing-nonmanager') {
            expect(screen.findByTestId('managed-machine.controller-unavailable:move')).toBeNull();
            expect(screen.tree.findAllByType(ManagedControllerMoveList)).toHaveLength(0);
            expect(moves).toEqual([]);
            return;
        }
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            if (controllerState === 'missing') expect(screen.findByTestId('managed-machine.controller-unavailable:move')).not.toBeNull();
            else expect(screen.tree.findByType(ManagedMachineControllerSection).props.controller.move.kind).toBe('movable');
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
        });
        const move = controllerState === 'missing'
            ? { kind: 'movable', onPress: () => screen.pressByTestId('managed-machine.controller-unavailable:move') }
            : screen.tree.findByType(ManagedMachineControllerSection).props.controller.move;
        if (controllerState === 'missing') expect(screen.findByTestId('managed-machine.controller-unavailable:move')).not.toBeNull();
        expect(move.kind).toBe('movable');
        expect(checked).toContainEqual({ homeId: machine.homeId, controller: next, contribution: provider, credentials: [credential] });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
        await act(async () => move.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedControllerMoveList).props.candidates
                .find((candidate: { id: string; reachable: boolean }) => candidate.id === next.machineId)?.reachable).toBe(true);
        });
        const list = screen.tree.findByType(ManagedControllerMoveList);
        const reachable = list.props.candidates.find((candidate: { id: string; reachable: boolean }) => candidate.reachable && !candidate.id.includes('original'));
        expect(reachable).toBeDefined();
        expect(reachable.subtitle).not.toContain(credential.account.accountId);
        expect(reachable.subtitle).toContain(screen.tree.findByType(MachineConfigurationReceipt).props.model.facts
            .find((fact: { id: string; value: string }) => fact.id === 'credential:0').value);
        expect(list.props.candidates.find((candidate: { id: string; reachable: boolean }) => candidate.id.includes('blocked'))?.reachable).toBe(false);
        expect(checked).toContainEqual({ homeId: machine.homeId, controller: next, contribution: provider, credentials: [credential] });
        await act(async () => list.props.onMove(reachable.id));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(moves).toEqual([{ homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 9, controller: next, reviewedPendingEffects: true }]);
        });
        expect(moveTargets).toEqual([{ kind: 'machine', machineId: next.machineId }]);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.controller).toEqual(controller);
    });
    it.each(['controller', 'guest', 'cleanup-retry', 'canceled-no-native-ref', 'canceled-native-ref', 'canceled-bound', 'canceled-absent', 'creator-canceled', 'stalled-target', 'read-unavailable-after-review', 'controller-refusal', 'typed-controller-read-failure'] as const)('requires controller Manage or creation, and deletes only after a settled in-page review (%s)', async authority => {
        await sodium.ready;
        const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(11));
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-delete-review.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_delete');
        await upsertAndActivateServer({ serverUrl: 'https://other-managed-delete.test', scope: 'tab' });
        const token = createAccountTokenForTests('owner', { currentAccount: true });
        const authentication = readOriginalAccountActionAuthentication(token);
        expect(authentication).toEqual({ kind: 'account', tokenEpoch: 0 });
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token });
        const launch: ManagedMachineFullV1['launch'] = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Paid guest', choices: {} };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const canceled = authority.startsWith('canceled-') || authority === 'creator-canceled';
        const creatorOnly = authority === 'creator-canceled';
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'foreign-owner', displayName: 'Foreign owner' },
                role: authority === 'guest' || creatorOnly ? 'use' : 'manage', resourceMode: 'plain', accessState: 'ready' },
        }), ...(authority === 'guest' ? [createMachineFixture({ id: 'guest', installationId: 'guest-installation', updatedAt: Date.now(),
            access: { custodian: { accountId: 'foreign-owner', displayName: 'Foreign owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        })] : [])]);
        const machine: ManagedMachineFullV1 = { id: 'delete-reviewed', homeId: 'srv_managed_delete', custodianAccountId: 'foreign-owner', launch,
            controller, allocation: 'bound', creationState: 'active', enrolledMachineId: 'guest',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { resourceId: 'original-resource' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 8, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power: 'running', storage: 'retained' },
            ...(authority === 'cleanup-retry' ? { submittedNativeEffect: { intent: 'delete' as const, intentRevision: 8,
                requestId: 'original-cleanup', controller } } : {}),
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        if (canceled) {
            machine.creationState = 'canceled';
            machine.enrolledMachineId = undefined;
            machine.desired = 'delete';
            machine.cleanup = { disposition: 'pending', reason: 'creation_canceled' };
            if (authority !== 'canceled-bound') {
                machine.allocation = authority === 'canceled-absent' ? 'confirmed-absent' : 'may-exist';
                machine.resource = undefined;
            }
            if (authority === 'canceled-native-ref') machine.nativeOperationRef = {
                contributionRef: launch.provider, schemaVersion: 1, value: { resourceId: 'retained-acquisition' },
            };
            if (creatorOnly) {
                // Home projects the custodian's controller key to the member who created it (projectManagedMachineForActorInTx).
                machine.enrollmentAccountId = 'owner';
                machine.controllerAccess = { installationPublicKey: encodeBase64(installation.publicKey, 'base64url'),
                    custodian: { accountId: 'foreign-owner' } };
            }
        }
        const nativeRequests: unknown[] = [];
        const additionalConfirmations: string[] = [];
        const deleted: unknown[] = [];
        // The native HTTP hop is the boundary. Its receiving admission still
        // runs the real policy and executor against the actual private carrier.
        const nativeExecutor = createActionExecutor(createActionExecutorBoundaryFixture({
            presentUserActionConfirmation: async ({ actionId }) => { additionalConfirmations.push(actionId); return false; },
            managedMachineAction: async request => {
                deleted.push(request.input);
                return { kind: 'accepted', managedId: machine.id, intentRevision: machine.intentRevision + 1,
                    operation: { operationId: 'delete-operation' }, machineReferences: { homeId: machine.homeId,
                        machineId: machine.enrolledMachineId ?? null, coverage: 'complete', references: [], unavailable: [] } };
            },
        }));
        const minted: Array<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>> = [];
        const authorizations: Array<ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>> = [];
        const nativeCarriers: Array<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>> = [];
        let referenceInventoryReads = 0;
        let reviewingDelete = false;
        let confirmedDelete = false;
        const plainControllerRow = createPlainMachineRowFixture({ id: controller.machineId, accountId: 'foreign-owner' });
        const controllerRow = { ...plainControllerRow,
            access: { custodian: { accountId: 'foreign-owner', displayName: 'Foreign owner' },
                role: authority === 'guest' || creatorOnly ? 'use' : 'manage', resourceMode: 'plain', accessState: 'ready' },
            installationId: controller.installationId, installationPublicKey: encodeBase64(installation.publicKey, 'base64') };
        expect(readMachineInstallationPublicKey(controllerRow.installationPublicKey)).toEqual(installation.publicKey);
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-delete-review.test');
            if (url.pathname === '/v1/artifacts') referenceInventoryReads += 1;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines') return Response.json([controllerRow]);
            if (url.pathname === '/v1/machines/read-batch') {
                if (authority === 'typed-controller-read-failure' && confirmedDelete) {
                    throw Object.assign(new Error('Private transport text'), { code: 'MACHINE_RPC_TIMEOUT' });
                }
                return createMachineReadBatchResponseFixture(init?.body, id => id === controllerRow.id ? controllerRow : null);
            }
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (url.pathname === '/v1/machines/managed/actions/get') {
                if (authority === 'read-unavailable-after-review' && confirmedDelete) throw new TypeError('Managed row temporarily unavailable');
                if (authority === 'stalled-target' && reviewingDelete) {
                    // Deliver headers but leave the response body pending so the read owner can detect inactivity.
                    return new Response(new ReadableStream<Uint8Array>(), {
                        headers: { 'content-type': 'application/json' },
                    });
                }
                return Response.json(machine);
            }
            if (url.pathname === bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.delete')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                minted.push(request);
                const managedAdmission = request.envelope.v === 1
                    ? projectExternalActionManagedAdmissionV1('machines.managed.delete', request.envelope.input)
                    : request.envelope.managedAdmission;
                if (managedAdmission?.actionId !== 'machines.managed.delete') throw new Error('Expected managed Delete admission');
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'test-native-issuer-authorization', binding: {
                    accountId: 'owner', authentication, serverIdentityId: machine.homeId,
                    machineId: controller.machineId, custodianAccountId: 'foreign-owner', installationId: controller.installationId,
                    accountEncryptionMode: 'plain', actionId: 'machines.managed.delete', requestId: request.envelope.requestId,
                    target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                    managedAdmission: creatorOnly ? { ...managedAdmission, authority: 'creator_recovery' } : managedAdmission,
                } });
                authorizations.push(authorization);
                return Response.json(authorization);
            }
            if (url.pathname === '/v1/actions/machines.managed.delete') {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                nativeCarriers.push(request);
                nativeRequests.push(request.envelope);
                const envelope = request.envelope;
                if (authority === 'controller-refusal') return Response.json({ v: 1, requestId: envelope.requestId,
                    actionId: 'machines.managed.delete', execution: { ok: false, errorCode: 'managed_controller_request_failed',
                        error: 'managed_controller_request_failed', details: { kind: 'managedControllerRequest',
                            path: '/v1/machines/managed/controller/submit-intent', category: 'status', status: 409, code: 'intent_changed' } } });
                if (envelope.v !== 1 || envelope.target?.kind !== 'machine') throw new Error('Expected the plain controller request');
                const context = { authorization: request.executionAuthorization, machineId: controller.machineId,
                    installationId: controller.installationId, serverIdentityId: machine.homeId, installationPrivateKey: installation.privateKey };
                const codec = openManagedControllerActionCodecV1({ ...context, includeInvocation: true });
                expect(codec?.material.machineKey).toHaveLength(32);
                expect(openExternalActionRequesterAccountContextV1({ ...context, purpose: { kind: 'external_action' } })).toBeNull();
                const invocation = codec?.invocation;
                const execution = await nativeExecutor.execute('machines.managed.delete', envelope.input, {
                    surface: 'ui', authority: 'present_user', actionCaller: invocation?.caller ?? { kind: 'host' },
                    runtimeAccountId: 'owner', serverId: machine.homeId, actionRequestId: envelope.requestId,
                    externalActionTarget: envelope.target, presentUserConfirmation: invocation?.presentUserConfirmation,
                });
                return Response.json({ v: 1, requestId: request.envelope.requestId, actionId: 'machines.managed.delete', execution });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const account = await captureLazyActionAccountContext(target.id);
        try {
            account.assertCurrent();
            expect({ authority: account.credentialAuthorityKind, homeId: account.serverIdentityId, accountId: account.accountId,
                authentication: readOriginalAccountActionAuthentication(account.credentials.token) })
                .toEqual({ authority: 'account', homeId: machine.homeId, accountId: 'owner', authentication });
            expect(await readOriginalAccountActionMachine(account, controller.machineId)).toMatchObject({
                id: controller.machineId, kind: 'persistent', installationId: controller.installationId, installationPublicKey: installation.publicKey,
                revokedAt: null, replacedByMachineId: null,
                access: { custodian: { accountId: 'foreign-owner' }, accessState: 'ready', role: authority === 'guest' || creatorOnly ? 'use' : 'manage' },
            });
        } finally { account.dispose(); }
        const executeAction = createFrontDoorActionExecute(createDefaultActionExecutor());
        const screen = await renderScreen(canceled
            ? <ManagedMachineDetail managedId={machine.id} serverId={target.id} executeAction={executeAction} />
            : <ManagedEnrolledMachineSections enrolledMachineId="guest" serverId={target.id} executeAction={executeAction} />);
        // Owner ruling 2026-11-16: the member who created it deletes it through this same review
        // (creator-canceled); a Use member who did not create it still has no Delete.
        if (authority === 'guest' || authority === 'canceled-absent') {
            // OWNER-RULINGS 2026-10-31: Use has no Machine-wide resource controls.
            await flushHookEffects({ cycles: 30 });
            expect(screen.findByTestId('managed-machine.detail')).not.toBeNull();
            expect(screen.findByTestId('managed-machine.delete')).toBeNull();
            expect(screen.findByTestId('managed-machine.progress:deleteNow')).toBeNull();
            expect(nativeRequests).toEqual([]);
            expect(minted).toEqual([]);
            await screen.unmount();
            return;
        }
        const deleteButton = canceled ? 'managed-machine.progress:deleteNow' : 'managed-machine.delete';
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => node.props?.testID === deleteButton && typeof node.props.onPress === 'function')).not.toHaveLength(0);
        });
        const remove = screen.tree.findAll(node => node.props?.testID === deleteButton && typeof node.props.onPress === 'function')[0];
        expect(remove).toBeDefined();
        expect(remove?.props.disabled).not.toBe(true);
        reviewingDelete = true;
        if (authority === 'stalled-target') vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS', '50');
        if (authority === 'cleanup-retry') await screen.pressByTestId('managed-machine.progress:tryAgain');
        else await act(async () => remove!.props.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.delete-coverage' && node.props.diagnosticCode).length).toBeGreaterThan(0);
        });
        expect(nativeRequests).toEqual([]);
        const confirm = screen.tree.findAll(node => node.props?.testID === 'managed-machine.delete-confirm' && typeof node.props.onPress === 'function')[0];
        expect(confirm).toBeDefined();
        // The review opens in place under the receipt that holds Delete…, and names who has access and who is using it.
        const aside = screen.findByTestId('managed-machine.detail.receipt-aside');
        expect(aside?.findAll(node => node.props?.testID === 'managed-machine.delete-review').length).toBeGreaterThan(0);
        if (machine.enrolledMachineId) expect(aside?.findAll(node => node.props?.testID === 'managed-machine.delete-audience').length).toBeGreaterThan(0);
        // The decision is one closing button row: the button names it, so no row repeats "Delete machine".
        expect(screen.findByTestId('managed-machine.delete-decision')).not.toBeNull();
        expect(screen.findByTestId('managed-machine.delete-decision.cancel')).not.toBeNull();
        if (authority === 'stalled-target') {
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.delete-coverage')
                .some(node => node.props.diagnosticCode === 'target')).toBe(true);
            expect(screen.findByTestId('managed-machine.delete')?.props.loading).not.toBe(true);
            expect(deleted).toEqual([]);
            return;
        }
        expect(screen.tree.findAll(node => node.props?.title === t('managedMachines.actions.deleteMachine') && node.props?.mode === 'info')).toHaveLength(0);
        const referenceInventoryReadsAfterReview = referenceInventoryReads;
        confirmedDelete = true;
        await act(async () => confirm!.props.onPress());
        if (authority === 'controller-refusal' || authority === 'typed-controller-read-failure') {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error')
                    .some(node => node.props.title === t('common.requestFailed')
                        && node.props.diagnosticCode.includes(authority === 'controller-refusal' ? 'intent_changed' : 'MACHINE_RPC_TIMEOUT'))).toBe(true);
            });
            expect(deleted).toEqual([]);
            return;
        }
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(nativeRequests, JSON.stringify({
                errors: screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error')
                    .map(node => node.props.diagnosticCode),
                minted: minted.length, http: httpFacts.slice(-12),
            })).toHaveLength(1);
            // The custodian's controller consumes Home's creator decision without an Ask
            // (executeExternalAction approvedCreationRecovery, covered by memberContainerJourney);
            // this fake controller stops at that boundary for the member who created it.
            if (!creatorOnly) expect(deleted).toHaveLength(1);
        });
        if (creatorOnly) {
            expect(minted).toHaveLength(1);
            expect(nativeCarriers[0]?.executionAuthorization.binding).toMatchObject({ accountId: 'owner',
                custodianAccountId: 'foreign-owner', actionId: 'machines.managed.delete',
                managedAdmission: { actionId: 'machines.managed.delete', authority: 'creator_recovery' } });
            await screen.unmount();
            return;
        }
        expect(additionalConfirmations).toEqual([]);
        expect(screen.findByTestId('managed-machine.approval')).toBeNull();
        // Confirmation reuses its reviewed target and dependency census. The
        // receiving admission owns the expectedRevision conflict decision.
        expect(referenceInventoryReads).toBe(referenceInventoryReadsAfterReview);
        expect(minted).toHaveLength(1);
        expect(authorizations[0]?.binding).toMatchObject({ accountId: 'owner', serverIdentityId: machine.homeId, authentication,
            machineId: controller.machineId, installationId: controller.installationId, custodianAccountId: 'foreign-owner',
            target: { kind: 'machine', machineId: controller.machineId }, actionId: 'machines.managed.delete',
            requestId: minted[0]?.envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(minted[0]!.envelope) });
        expect(nativeCarriers[0]?.executionAuthorization).toMatchObject({ binding: authorizations[0]?.binding,
            requesterAccountContext: { kind: 'installation_sealed_v1', installationId: controller.installationId } });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error').map(node => node.props.diagnosticCode)).toEqual([]);
        expect(nativeRequests).toEqual([expect.objectContaining({ input: { homeId: machine.homeId, managedId: machine.id,
            when: 'now', expectedRevision: 8, intent: 'delete', reviewedDependencies: true } })]);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.observation.availability).toBe('present');
        expect(screen.findByTestId('managed-machine.delete')?.props.loading).not.toBe(true);
    });
    it.each(['approval-pending', 'saved'] as const)('resets live Keep from the fresh parent, clearing a failed proposal only on success (%s)', async outcome => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-reset-parent.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_reset');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'controller', installationId: 'installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now() })]);
        const launch: ManagedMachineFullV1['launch'] = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Old receipt', choices: {} };
        let machine: ManagedMachineFullV1 = { id: 'reset-managed', homeId: 'srv_managed_reset', custodianAccountId: 'owner', launch,
            controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} }, desired: 'start', desiredWhen: 'now',
            intentRevision: 6, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'billed' },
                prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const provisioner = { contribution: launch.provider, occurrenceId: 'fresh-occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
            retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        let afterMs = 3_600_000;
        let nativeAvailable = true;
        let optionReads = 0;
        const nativeRequests: unknown[] = [];
        const authored = { retention: { kind: 'deadline' as const, at: new Date(2099, 0, 2, 18, 30).getTime(),
            effect: 'delete' as const }, wakeOnAcceptedMessage: false };
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-reset-parent.test');
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                machineRetentionDefaultsV1: { v: 1, 'running-only': { retention: { kind: 'unused', effect: 'stop', afterMs }, wakeOnAcceptedMessage: true } },
            } }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname.startsWith('/v1/actions/')) {
                const request = readNativeControllerRequest(init);
                const actionId = url.pathname.slice('/v1/actions/'.length);
                if (actionId === 'machines.managed.retention.update') {
                    nativeRequests.push(request);
                    if (nativeRequests.length === 1) return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({
                        v: 1, actionId, requestId: request.requestId, execution: { ok: false, errorCode: 'intent_changed', error: 'intent_changed' },
                    }));
                    if (outcome === 'saved') {
                        machine = { ...machine, retention: { kind: 'unused', effect: 'stop', afterMs },
                            wakeOnAcceptedMessage: true, intentRevision: 7 };
                        return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                            requestId: request.requestId, execution: { ok: true, result: machine } }));
                    }
                }
                if (actionId === 'machines.provisioners.options') optionReads += 1;
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.check' ? { available: nativeAvailable }
                        : actionId === 'machines.provisioners.options' ? createMachineProvisionerOptionsFixture({ base: {
                            launch: machine.launch.choices, billing: { location: 'cloud', stoppedBilling: 'not-billed' },
                        } })
                        : { kind: 'approval_request_created', artifactId: 'reset-approval', actionId };
                return Response.json({ v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } });
            }
            if (url.pathname.startsWith('/v1/artifacts/')) return Response.json({ error: 'not_found' }, { status: 404 });
            expect(url.pathname).toBe('/v1/machines/managed/actions/get');
            return Response.json(machine);
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        const keep = screen.tree.findByType(ManagedMachinePolicySection).props.keep;
        expect(keep.defaultPolicy).toMatchObject({ retention: { kind: 'unused', afterMs }, wakeOnAcceptedMessage: true });
        expect(screen.tree.findByType(MachineConfigurationReceipt).props.model.cost).toEqual({ kind: 'unpriced', provider: 'Virtual machine' });
        await act(async () => keep.onChange(authored));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toEqual(authored);
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        afterMs = 7_200_000;
        await act(async () => { void screen.tree.findByType(ManagedMachinePolicySection).props.keep.onReset(); });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(nativeRequests).toHaveLength(2);
            if (outcome === 'saved') expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy.retention)
                .toEqual({ kind: 'unused', effect: 'stop', afterMs });
            else expect(screen.findByTestId('managed-machine.approval')).not.toBeNull();
        });
        expect(nativeRequests.at(-1)).toMatchObject({ input: { homeId: machine.homeId, managedId: machine.id,
            expectedIntentRevision: 6, retention: { kind: 'unused', effect: 'stop', afterMs }, wakeOnAcceptedMessage: true } });
        expect(nativeRequests).toHaveLength(2);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy.retention).toEqual(outcome === 'saved'
            ? { kind: 'unused', effect: 'stop', afterMs } : authored.retention);
        if (outcome === 'saved') {
            nativeAvailable = false;
            const scope = await renderHook(() => useServerCredentialAccountScopeBinding(target.id));
            await waitForHomeGovernance(() => expect(scope.getCurrent().binding?.isCurrent()).toBe(true));
            const binding = scope.getCurrent().binding;
            if (!binding) throw new Error('Expected the current Account binding');
            const before = optionReads;
            const { readManagedMachinePolicyParent } = await import('./managedMachinePolicyParent');
            expect(await readManagedMachinePolicyParent({ machine, binding, signal: new AbortController().signal,
                onApprovalPending: () => {} })).toEqual({ kind: 'failed', code: 'managed_parent_unavailable' });
            // Missing native runtime settles without reading choices for a Reset it cannot review.
            expect(optionReads).toBe(before);
            await scope.unmount();
        }
    });
    it.each(['enrolled-failure', 'enrolled-activation-failure', 'enrolled-retention-failure', 'controller-restart', 'enrolled-observation-unavailable',
        'enrolled-incomplete-retention', 'enrolled-incomplete-no-history', 'enrolled-review-required-no-history'] as const)('keeps one native Check now and same-resource recovery through Ask with %s operation history', async basis => {
        const incomplete = basis.startsWith('enrolled-incomplete') || basis === 'enrolled-review-required-no-history';
        const homeId = `srv_bootstrap_${basis}`;
        const target = await upsertAndActivateServer({ serverUrl: `https://managed-bootstrap-${basis}.test`, scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'boot-controller', installationId: 'boot-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        }), ...(basis === 'enrolled-activation-failure' || basis === 'enrolled-retention-failure' || incomplete ? [createMachineFixture({ id: 'enrolled-guest', installationId: 'guest-installation',
            active: incomplete, activeAt: 1, updatedAt: Date.now(),
            presenceProtocolVersion: 1,
            daemonState: { status: 'running', startupSource: 'background-service', serviceManaged: true },
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        })] : [])]);
        const enrolledGuest = storage.getState().machineListByServerId[serverId]?.find(candidate => candidate.id === 'enrolled-guest');
        if (enrolledGuest) publishMachineActivityForTest([enrolledGuest], { active: incomplete, activeAt: Date.now() });
        const provider = { pluginId: 'custom.native', localId: 'guest' };
        const machine: ManagedMachineFullV1 = { id: 'boot-managed', homeId, custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Enrolled guest', choices: {} }, controller,
            ...(incomplete ? { bootstrapInstalled: true } : {}),
            observation: incomplete ? { availability: 'unavailable', reason: basis === 'enrolled-review-required-no-history'
                ? 'bootstrap.action_interactive_review_required' : 'bootstrap.incomplete', observedAt: 4 }
                : basis === 'enrolled-observation-unavailable'
                ? { availability: 'unavailable', observedAt: 1 }
                : { availability: 'present', power: 'running', observedAt: 1 },
            ...(basis !== 'controller-restart' ? { enrolledMachineId: 'enrolled-guest' } : {
                preset: { id: 'admitted-preset', revision: 1, contentEncryptionMode: 'plain' },
                machineSetup: { setup: { scripts: [{ body: 'echo setup' }] }, state: 'pending' as const },
            }), allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { nativeId: 'same-paid-resource' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 4, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const failed: ActionOperationSnapshotV1 = { version: 1, operationId: 'boot-failure', revision: 2,
            actionId: incomplete ? 'machines.managed.acquire' : basis === 'enrolled-retention-failure' ? 'machines.managed.power.set' : 'machines.managed.bootstrap.retry', state: 'failed', scope: { accountId: 'owner', machineId: controller.machineId },
            title: 'Create managed machine', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported',
            ...(basis === 'enrolled-retention-failure' ? { progress: { kind: 'phase' as const,
                phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' } } : {}),
            error: incomplete ? { errorCode: 'database_transaction_timeout', error: 'database_transaction_timeout',
                details: { kind: 'managedControllerRequest', path: '/v1/machines/managed/controller/report', category: 'status',
                    status: 503, code: 'database_transaction_timeout' } } : basis === 'enrolled-retention-failure' ? { errorCode: 'managed_controller_request_failed', error: 'managed_controller_request_failed' }
                : basis === 'enrolled-activation-failure' ? { errorCode: 'action_failed',
                error: 'Background service install completed, but the expected background service did not become the active daemon for the selected Home within 30000ms. Run `happier service status` to inspect the active owner and system service state.' }
                : { errorCode: 'native_boot_unconfirmed', error: 'Native boot configuration was not confirmed' },
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller } };
        const retention: ActionOperationSnapshotV1 = { ...failed, operationId: 'later-retention', revision: 1,
            actionId: 'machines.managed.power.set', state: 'running', createdAt: 5, startedAt: 5, settledAt: undefined, error: undefined,
            progress: { kind: 'phase', phase: 'managed.intent.busy', label: 'Waiting for unused machine' } };
        const { ActionOperationListV1ResponseSchema, ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
        ActionOperationSnapshotV1Schema.parse(failed);
        operationRpcBoundary.answer = ActionOperationListV1ResponseSchema.parse({
            items: basis === 'enrolled-incomplete-retention' ? [failed, retention]
                : basis === 'enrolled-failure' || basis === 'enrolled-activation-failure' || basis === 'enrolled-retention-failure' ? [failed] : [],
            nextCursor: null,
        });
        const retries: unknown[] = [];
        const inspections: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe(target.serverUrl);
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (actionId === 'machines.managed.bootstrap.retry') retries.push(request.input);
                if (actionId === 'machines.managed.inspect') inspections.push(request.input);
                const readGuestLogs = actionId === 'machines.managed.inspect' && request.input !== null
                    && typeof request.input === 'object' && 'includeGuestDiagnostics' in request.input
                    && request.input.includeGuestDiagnostics === true;
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.provisioners.list' ? { provisioners: [] }
                        : actionId === 'machines.managed.get' ? machine
                        : actionId === 'machines.managed.list' ? { machines: [machine] }
                        : actionId === 'machines.managed.inspect' ? { machine, ...(readGuestLogs ? {
                            guestDiagnostics: { status: 'collected', snapshot: { daemonState: null,
                                sessionDiagnostics: { context: { sessionId: '', metadataStatus: 'unavailable' }, logs: [
                                    { kind: 'daemon', status: 'collected', artifact: { filename: 'daemon.log', sourceKind: 'daemon',
                                        contentType: 'text/plain', content: 'Read-only redacted guest daemon evidence' } },
                                ] } } },
                        } : {}) }
                        : { kind: 'approval_request_created', artifactId: 'boot-retry-approval', actionId } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(basis !== 'controller-restart'
            ? <ManagedEnrolledMachineSections enrolledMachineId="enrolled-guest" serverId={target.id}
                executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />
            : <ManagedMachineDetail managedId={machine.id} serverId={target.id}
                executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAllByType(ManagedCreationProgress), screen.getTextContent()).toHaveLength(1);
            expect(operationRpcBoundary.requests).toContainEqual({ serverId, accountId: 'owner', machineId: controller.machineId,
                method: ACTION_OPERATION_RPC_METHODS_V2.list });
            if (basis === 'enrolled-activation-failure' || basis === 'enrolled-retention-failure' || basis === 'enrolled-failure')
                expect(screen.findByTestId('managed-machine.installation-error')).not.toBeNull();
        });
        if (basis === 'enrolled-activation-failure' || basis === 'enrolled-retention-failure') {
            expect(screen.findByTestId('managed-machine.installation-error')).not.toBeNull();
            const guest = storage.getState().machineListByServerId[serverId]!.find(candidate => candidate.id === 'enrolled-guest')!;
            await act(async () => {
                publishMachineActivityForTest([guest], { active: true, activeAt: Date.now() });
            });
            await flushHookEffects({ cycles: 10 });
            expect(screen.findByTestId('managed-machine.installation-error'), JSON.stringify({ enrolled: screen.tree.findByType(ManagedCreationProgress).props.enrolledMachine,
                guest: storage.getState().machineListByServerId[serverId]?.find(candidate => candidate.id === 'enrolled-guest') })).toBeNull();
            expect(screen.findByTestId('managed-machine.installation-retry')).toBeNull();
            expect([...actionOperationStore.getSnapshot().operationsByKey.values()]
                .find(candidate => candidate.snapshot.operationId === failed.operationId)?.snapshot.state).toBe('failed');
            await screen.unmount();
            return;
        }
        if (basis === 'enrolled-incomplete-retention') await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect([...actionOperationStore.getSnapshot().operationsByKey.values()]
                .find(candidate => candidate.snapshot.operationId === failed.operationId)?.snapshot.error).toEqual(failed.error);
            expect(screen.tree.findByType(ManagedCreationProgress).props.operation?.snapshot.operationId).toBe(failed.operationId);
        });
        if (!incomplete) {
            // Failed operations use the shared banner's Details disclosure.
            if (screen.findByTestId('managed-machine.installation-error.details'))
                await screen.pressByTestIdAsync('managed-machine.installation-error.details');
            if (basis === 'enrolled-failure') {
                expect(screen.findByTestId('managed-machine.installation-error')).not.toBeNull();
                expect(screen.getTextContent()).toContain('native_boot_unconfirmed');
            } else expect(screen.getTextContent()).not.toContain('native_boot_unconfirmed');
            const checks = screen.tree.findAllByType(RoundButton).filter(button =>
                button.props.testID === 'managed-machine.progress:checkNow' || button.props.testID === 'managed-machine.observation-check');
            expect(checks).toHaveLength(1);
            await act(async () => checks[0]!.props.onPress());
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(inspections).toEqual([{ homeId: machine.homeId, managedId: machine.id }]);
                if (basis !== 'enrolled-observation-unavailable') expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry'
                    && typeof node.props.onPress === 'function')).not.toHaveLength(0);
            });
            if (basis === 'enrolled-failure') {
                const readLogs = screen.findByTestId('managed-machine.logs.read');
                expect(readLogs).not.toBeNull();
                await pressTestInstanceAsync(readLogs!);
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(inspections.at(-1)).toEqual({ homeId: machine.homeId, managedId: machine.id, includeGuestDiagnostics: true });
                    expect(screen.getTextContent()).toContain('Read-only redacted guest daemon evidence');
                });
            }
            if (basis === 'enrolled-observation-unavailable') {
                expect(screen.findByTestId('managed-machine.installation-retry')).toBeNull();
                await screen.unmount();
                return;
            }
        }
        const retry = screen.tree.findAllByType(RoundButton).filter(button => button.props.testID === 'managed-machine.installation-retry');
        expect(retry).toHaveLength(1);
        await act(async () => (retry[0]!.props.onPress ?? retry[0]!.props.action)());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(retries).toEqual([{ homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 4 }]);
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
        });
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toMatchObject({
            intentRevision: 4, resource: machine.resource, controller });
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.enrolledMachineId).toBe(machine.enrolledMachineId);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
    });
    it.each(['saved', 'enrolled'] as const)('says a failed re-read once, withdraws the native Check now it cannot dispatch, and restores it when Retry reads again (%s)', async surface => {
        const homeId = `srv_stale_${surface}`;
        const target = await upsertAndActivateServer({ serverUrl: `https://managed-stale-${surface}.test`, scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const launch: ManagedMachineFullV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'Stopped resource', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'stale-existing', homeId, custodianAccountId: 'owner', launch,
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            ...(surface === 'enrolled' ? { enrolledMachineId: 'stale-guest' } : {}),
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { resourceId: 'same-native' } },
            desired: 'stop', desiredWhen: 'now', intentRevision: 4, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            // ACCEPT-1109 puts Start on the joined stopped/retained row. Unknown storage still needs Check now.
            observation: { availability: 'present', observedAt: 2, power: 'stopped', storage: surface === 'enrolled' ? 'unknown' : 'retained' },
            reviewedFacts: { launch, controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
                billing: { location: 'cloud', stoppedBilling: 'not-billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
            id: 'controller', installationId: 'installation', updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        })]);
        const gate = { rereadFails: false, failAfterInspect: false };
        const inspections: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/machines/managed/actions/list' || url.pathname === '/v1/machines/managed/actions/get') {
                if (gate.rereadFails) return Response.json({ error: 'unavailable' }, { status: 503 });
                return Response.json(url.pathname.endsWith('/list') ? { machines: [machine] } : machine);
            }
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (actionId === 'machines.managed.inspect') { inspections.push(request.input); gate.rereadFails = gate.failAfterInspect; }
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.provisioners.list' ? { provisioners: [] } : { machine } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(surface === 'enrolled'
            ? <ManagedEnrolledMachineSections enrolledMachineId="stale-guest" serverId={target.id}
                executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />
            : <ManagedMachineDetail managedId={machine.id} serverId={target.id}
                executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        const checkIds = ['managed-machine.progress:checkNow', 'managed-machine.observation-check'];
        const checks = () => screen.tree.findAllByType(RoundButton).filter(button => checkIds.includes(button.props.testID));
        const retries = () => screen.tree.findAllByType(RoundButton).filter(button => button.props.testID === 'managed-machine.observation-retry');
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(checks(), screen.getTextContent()).toHaveLength(1);
        });
        expect(retries()).toHaveLength(0);
        gate.failAfterInspect = true;
        await act(async () => checks()[0]!.props.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(inspections).toHaveLength(1);
            expect(retries()).toHaveLength(1);
        });
        // The last answer stays; its one freshness carries Retry, and nothing offers a Check now that would silently refuse.
        expect(checks()).toHaveLength(0);
        expect(retries()).toHaveLength(1);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.freshness')).toHaveLength(0);
        expect(screen.getTextContent().split(t('managedMachines.detail.loadFailed')).length - 1).toBe(1);
        gate.failAfterInspect = false; gate.rereadFails = false;
        await act(async () => retries()[0]!.props.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(retries()).toHaveLength(0);
            expect(checks()).toHaveLength(1);
        });
        await act(async () => checks()[0]!.props.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(inspections).toHaveLength(2);
        });
        await screen.unmount();
    });
    it.each(['active', 'canceled'] as const)('retains a rejected requester acquisition diagnostic when nothing was created (%s)', async creationState => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://creator-rejected-acquisition.test', scope: 'tab' });
        const homeId = 'srv_creator_rejected_acquisition';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        const token = createAccountTokenForTests('requester', { currentAccount: true });
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token });
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
        const controller = { machineId: 'company-controller', installationId: 'company-installation' };
        await sodium.ready;
        const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(7));
        const machine: ManagedMachineFullV1 = { id: 'requester-rejected-resource', homeId, custodianAccountId: 'company', enrollmentAccountId: 'requester',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Team sandbox', choices: {} },
            controller, controllerAccess: { installationPublicKey: encodeBase64(installation.publicKey, 'base64url'), custodian: { accountId: 'company' } },
            allocation: 'confirmed-absent', creationState, desired: creationState === 'canceled' ? 'delete' : 'start',
            desiredWhen: 'now', intentRevision: creationState === 'canceled' ? 1 : 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'requester-rejected-acquisition', revision: 1,
            actionId: 'machines.managed.acquire', state: 'failed', scope: { accountId: 'requester', machineId: controller.machineId },
            title: 'Create Team sandbox', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id },
            error: { errorCode: 'provider_unavailable', error: 'provider_unavailable' } };
        const reads: { actionId: string; input: unknown }[] = [];
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (path.endsWith('/execution-authorization')) {
                const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                const actionId = path.slice('/v1/actions/'.length, -'/execution-authorization'.length);
                const managedAdmission = envelope.v === 1 ? projectExternalActionManagedAdmissionV1(actionId, envelope.input) : envelope.managedAdmission;
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-resource-root', binding: {
                    serverIdentityId: homeId, accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
                    machineId: controller.machineId, installationId: controller.installationId, custodianAccountId: 'company',
                    accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId, target: envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    ...(managedAdmission ? { managedAdmission } : {}),
                } }));
            }
            if (path.startsWith('/v1/actions/')) {
                const actionId = path.slice('/v1/actions/'.length);
                const body: unknown = JSON.parse(String(init?.body));
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body && typeof body === 'object' && 'envelope' in body ? body.envelope : body);
                reads.push({ actionId, input: envelope.input });
                return Response.json({ v: 1, requestId: envelope.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.managed.get' ? machine : actionId === 'action.operations.list' ? { items: [operation], nextCursor: null }
                        : actionId === 'action.operations.get' ? { kind: 'found', operation } : { machines: [machine] } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executeAction = createFrontDoorActionExecute(createDefaultActionExecutor());
        const managed = { homeId, managedId: machine.id };
        const receipt = await executeAction('action.operations.get', { serverId: target.id, machineId: controller.machineId,
            managed, operationId: operation.operationId }, { expectedAccountId: 'requester' });
        expect(receipt, JSON.stringify({ receipt, reads })).toMatchObject({ ok: true, result: { kind: 'found', operation: { error: operation.error } } });
        actionOperationStore.reset();
        expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(0);
        const navigation = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
        const screen = await renderScreen(<DestinationInstanceContext.Provider value={{ tabId: 'creator-rejection-test',
            ref: { kind: 'managedMachine', params: { id: machine.id, serverId: target.id } }, pathname: `/machines/managed/${machine.id}`,
            visible: true, focused: true, isFocused: () => true, navigation }}>
            <ManagedMachineDetail managedId={machine.id} serverId={target.id} executeAction={executeAction} />
        </DestinationInstanceContext.Provider>);
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(reads).toContainEqual({ actionId: 'action.operations.list', input: expect.objectContaining({ managed }) });
                expect([...actionOperationStore.getSnapshot().operationsByKey.values()]).toContainEqual(expect.objectContaining({
                    snapshot: expect.objectContaining({ operationId: operation.operationId, error: operation.error }),
                }));
                expect(screen.findByTestId('managed-machine.installation-error'), screen.getTextContent()).not.toBeNull();
            });
            expect(screen.getTextContent()).toContain(t(creationState === 'canceled'
                ? 'managedMachines.creation.canceledBeforeCreate' : 'managedMachines.inspect.notCreated'));
            await screen.pressByTestIdAsync('managed-machine.installation-error.details');
            expect(screen.getTextContent()).toContain('provider_unavailable');
            expect(operationRpcBoundary.requests).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    it.each(['retained', 'arriving', 'opaque-retained', 'manage-retained'] as const)('discovers the exact creator installation question and answers without a running creation continuation (%s)', async mode => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://creator-installation.test', scope: 'tab' });
        const homeId = 'srv_creator_installation';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        const token = createAccountTokenForTests('requester', { currentAccount: true });
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token });
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
        const controller = { machineId: 'company-controller', installationId: 'company-installation' };
        await sodium.ready;
        const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(7));
        const machine: ManagedMachineFullV1 = { id: 'requester-resource', homeId, custodianAccountId: 'company', enrollmentAccountId: 'requester',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Team sandbox', choices: {} },
            controller, controllerAccess: { installationPublicKey: encodeBase64(installation.publicKey, 'base64url'), custodian: { accountId: 'company' } },
            allocation: 'bound', creationState: 'active', resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: {} },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const { ManagedMachineReadV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        const { sealManagedMachinePresetContentV1, replaceManagedMachinePresetLaunchNameV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
        const authored = sealManagedMachinePresetContentV1({ presetId: 'requester-preset', mode: 'plain',
            content: { v: 1, name: machine.launch!.name, launch: machine.launch } });
        const sealed = replaceManagedMachinePresetLaunchNameV1({ presetId: 'requester-preset', mode: 'plain',
            content: authored.content, launchName: machine.launch!.name,
            nativeResult: { kind: 'bound', resource: machine.resource! } });
        if (!sealed) throw new Error('Expected admitted requester snapshot');
        const { launch: _launch, resource: _resource, ...structural } = machine;
        const read = mode === 'opaque-retained' ? ManagedMachineReadV1Schema.parse({
            machine: { ...structural, preset: { id: 'requester-preset', revision: 1, contentEncryptionMode: 'plain' } },
            presetContent: { content: sealed, recipientEnvelope: null },
        }) : machine;
        const prompt = { kind: 'auth.approveRemoteProvisioning' as const, message: 'Review requester enrollment' };
        const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'requester-installation', revision: 1,
            actionId: 'machines.managed.acquire', state: 'running', scope: { accountId: 'requester', machineId: controller.machineId },
            title: 'Create Team sandbox', createdAt: 1, startedAt: 2, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                bootstrapTask: { id: 'requester-task', taskKind: 'remote.ssh.bootstrapMachine.v1', prompt } } };
        const observed: unknown[] = [];
        const http: string[] = [];
        const awaitedQuestion = createDeferred<void>();
        let answered = false;
        let waitingSignal: AbortSignal | undefined;
        const { createHomeGovernanceHarness } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { installManagedInstallationResponseBoundary } = await import('@/dev/testkit/harness/managedInstallationResponseBoundary');
        const homes = createHomeGovernanceHarness();
        await homes.addHome({ name: 'Requester Home', serverUrl: target.serverUrl, serverIdentityId: homeId,
            accountId: 'requester', currentAccount: true, credentials: { token } });
        if (mode === 'manage-retained') {
            await publishMachineInventoryForTest({ serverId, accountId: 'requester' }, [createMachineFixture({
                id: controller.machineId, installationId: controller.installationId,
                active: true, activeAt: Date.now(), updatedAt: Date.now(),
                access: { custodian: { accountId: 'company', displayName: 'Company' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            })]);
        }
        const installationBoundary = installManagedInstallationResponseBoundary({ homes, serverId, serverUrl: target.serverUrl,
            homeId, token, enrollmentAccountId: 'requester', readMachine: () => read, onAnswer: () => { answered = true; } });
        const answers = installationBoundary.answers;
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            http.push(path);
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path.startsWith('/v1/auth/') || path.startsWith('/v1/features')) return homes.request(input, init);
            if (path === '/v1/machines/managed/actions/get') return Response.json(read);
            if (path.endsWith('/execution-authorization')) {
                const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                const actionId = path.slice('/v1/actions/'.length, -'/execution-authorization'.length);
                const managedAdmission = envelope.v === 1 ? projectExternalActionManagedAdmissionV1(actionId, envelope.input) : envelope.managedAdmission;
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'exact-resource-root', binding: {
                    serverIdentityId: homeId, accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
                    machineId: controller.machineId, installationId: controller.installationId, custodianAccountId: 'company',
                    accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId, target: envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    ...(managedAdmission ? { managedAdmission } : {}),
                } }));
            }
            if (path.startsWith('/v1/actions/')) {
                const actionId = path.slice('/v1/actions/'.length);
                const body: unknown = JSON.parse(String(init?.body));
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body && typeof body === 'object' && 'envelope' in body ? body.envelope : body);
                if (actionId === 'action.operations.list' || actionId === 'action.operations.get') observed.push(envelope.input);
                if (actionId === 'action.operations.get' && mode === 'arriving') {
                    waitingSignal = init?.signal ?? undefined;
                    return awaitedQuestion.promise.then(() => Response.json({ v: 1, requestId: envelope.requestId, actionId,
                        execution: { ok: true, result: { kind: 'found', operation: { ...operation, revision: 2 } } } }));
                }
                const listed = answered ? { ...operation, state: 'succeeded', settledAt: 3, revision: 3 }
                    : mode === 'arriving' ? { ...operation, domainRef: { kind: 'managedMachine', id: machine.id,
                        resource: machine.resource, controller, bootstrapTask: { id: 'requester-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } } } : operation;
                return Response.json({ v: 1, requestId: envelope.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.managed.get' ? read : actionId === 'action.operations.list' ? { items: [listed], nextCursor: null }
                        : actionId === 'action.operations.get' ? { kind: 'found', operation } : { machines: [read] } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executeAction = createFrontDoorActionExecute(createDefaultActionExecutor());
        const navigation = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
        let currentFocus = true;
        const page = (visible: boolean) => {
            currentFocus = visible;
            return <DestinationInstanceContext.Provider value={{ tabId: 'creator-test',
                ref: { kind: 'managedMachine', params: { id: machine.id, serverId: target.id } }, pathname: `/machines/managed/${machine.id}`,
                visible, focused: visible, isFocused: () => currentFocus, navigation }}><ManagedMachineDetail managedId={machine.id} serverId={target.id} executeAction={executeAction} /></DestinationInstanceContext.Provider>;
        };
        const screen = await renderScreen(page(true));
        try {
            // A fresh detail mount represents reloading during installation, with no configurator continuation.
            // The opaque Home carrier must open before installation matching is evaluated.
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(machine.launch!.name));
            if (mode === 'manage-retained') {
                expect(screen.tree.findByType(ManagedMachinePolicySection).props.readOnly).toBe(false);
            }
            if (mode === 'arriving') {
                await vi.waitFor(() => expect(observed).toContainEqual(expect.objectContaining({ managed: { homeId, managedId: machine.id },
                    operationId: operation.operationId, waitForTerminal: true, includeManagedPrompt: true })));
                expect(screen.findByTestId('managed-machine.installation-prompt-decline')).toBeNull();
                const firstWait = waitingSignal;
                await act(async () => screen.tree.update(page(false)));
                expect(firstWait?.aborted).toBe(true);
                const hiddenReads = observed.length;
                await flushHookEffects();
                expect(observed).toHaveLength(hiddenReads);
                await act(async () => screen.tree.update(page(true)));
                await vi.waitFor(() => expect(waitingSignal).not.toBe(firstWait));
                awaitedQuestion.resolve();
            }
            await vi.waitFor(() => expect(answers).toHaveLength(1));
            expect(answers).toContainEqual(expect.objectContaining({ managedId: machine.id, operationId: operation.operationId,
                taskId: 'requester-task', answer: { approved: true } }));
            expect(screen.findByTestId('managed-machine.installation-prompt-approve')).toBeNull();
            expect(screen.findByTestId('managed-machine.installation-prompt-decline')).toBeNull();
            expect(operationRpcBoundary.requests.filter(request => request.method === ACTION_OPERATION_RPC_METHODS_V2.list
                || request.method === ACTION_OPERATION_RPC_METHODS_V2.get)).toHaveLength(0);
        } finally { await screen.unmount(); installationBoundary.dispose(); }
    });
    it.each(['ssh.trustHost', 'ssh.replaceHostKey', 'daemon.replaceRemoteBackgroundServices', 'auth.approveRemoteProvisioning'] as const)(
        'renders the managed %s question and delivers both decisions through the real respond Action', async kind => {
        const enrollmentRetry = kind === 'auth.approveRemoteProvisioning';
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-trust.test', scope: 'tab' });
        const homeId = 'srv_managed_trust';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'trust-controller', installationId: 'trust-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, active: true, activeAt: Date.now(), updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })]);
        const machine: ManagedMachineFullV1 = { id: 'trust-managed', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Design sandbox', choices: {} },
            controller, allocation: 'bound', creationState: 'active',
            ...(enrollmentRetry ? { enrollmentAccountId: 'owner',
                observation: { availability: 'unavailable', reason: 'bootstrap.incomplete', observedAt: 1 } } : {}),
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'existing' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const prompt = kind === 'ssh.trustHost' || kind === 'ssh.replaceHostKey'
            ? { kind, message: 'Review this installation question', host: 'design-sandbox.example', keyType: 'ssh-ed25519',
                fingerprint: 'SHA256:design-sandbox', existingFingerprint: kind === 'ssh.replaceHostKey' ? 'SHA256:previous-key' : null }
            : { kind, message: enrollmentRetry ? 'Sign this managed machine into your Account for Account-wide automation?'
                : 'Review this installation question' };
        const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'trust-operation', revision: 1,
            actionId: enrollmentRetry ? 'machines.managed.bootstrap.retry' : 'machines.managed.acquire', state: 'running', scope: { accountId: 'owner', machineId: controller.machineId },
            title: 'Create Design sandbox', createdAt: 1, startedAt: 2, cancellation: 'supported',
            ...(!enrollmentRetry ? { progress: { kind: 'phase', phase: 'ssh.trust', label: 'Verifying SSH host trust' } } : {}),
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                bootstrapTask: { id: 'trust-task', taskKind: 'remote.ssh.bootstrapMachine.v1', prompt } } };
        const answers: unknown[] = [];
        const retries: unknown[] = [];
        const listOperations = () => ({ items: !enrollmentRetry || retries.length > 0 ? [operation] : [], nextCursor: null });
        operationRpcBoundary.handler = request => {
            if (request.method === ACTION_OPERATION_RPC_METHODS_V2.list) return listOperations();
            if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) return { kind: 'found', operation };
            if (request.method === RPC_METHODS.CAPABILITIES_INVOKE) { answers.push(request.payload); return { ok: true, result: {} }; }
            return undefined;
        };
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (actionId === 'machines.managed.bootstrap.retry') retries.push(request.input);
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.provisioners.list' ? { provisioners: [] }
                        : actionId === 'machines.managed.bootstrap.retry' ? { managedId: machine.id, operation: { operationId: operation.operationId } }
                        : actionId === 'action.operations.list' ? listOperations()
                        : actionId === 'machines.managed.get' ? machine : { machines: [machine] } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        // The trust sheet is a Modal: its answer is observed at the Modal boundary, as the sheet's own tests do.
        const sheets: { chrome?: { testID?: string }; props?: { request?: { fingerprint?: string; existingFingerprint?: string | null }; onResolve?: (trusted: boolean) => void } }[] = [];
        const show = vi.spyOn(Modal, 'show').mockImplementation(((config: (typeof sheets)[number]) => { sheets.push(config); return `sheet-${sheets.length}`; }) as never);
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        const hostKey = 'host' in prompt;
        try {
            if (enrollmentRetry) {
                // Recover the bound resource from its detail page, without mounting a creation continuation.
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(screen.findByTestId('managed-machine.installation-retry'), screen.getTextContent()).not.toBeNull();
                });
                await screen.pressByTestIdAsync('managed-machine.installation-retry');
                await waitForHomeGovernance(() => {
                    expect(retries).toEqual([{ homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision }]);
                    expect(screen.getTextContent()).toContain(prompt.message);
                });
            }
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.findByTestId(`managed-machine.installation-prompt-${hostKey ? 'review' : 'approve'}`), screen.getTextContent()).not.toBeNull();
            });
            if (prompt.host !== undefined) {
                // The row names the question; the key itself is the trust sheet's, never inline (lab af-ssh Kp).
                expect(screen.getTextContent()).toContain(kind === 'ssh.replaceHostKey'
                    ? t('addFlows.hostKeyChangedTitle', { host: prompt.host }) : t('addFlows.hostKeyTitle'));
                expect(screen.getTextContent()).not.toContain(prompt.fingerprint);
            }
            expect(answers).toEqual([]);
            for (const approved of [true, false]) {
                if ('host' in prompt) {
                    await screen.pressByTestId('managed-machine.installation-prompt-review');
                    const sheet = sheets.at(-1);
                    expect(sheet?.chrome?.testID).toBe('ssh-host-key-modal');
                    expect(sheet?.props?.request).toMatchObject({ fingerprint: prompt.fingerprint, existingFingerprint: prompt.existingFingerprint });
                    await act(async () => { sheet?.props?.onResolve?.(approved); });
                } else {
                    await screen.pressByTestId(`managed-machine.installation-prompt-${approved ? 'approve' : 'decline'}`);
                }
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(answers).toHaveLength(approved ? 1 : 2);
                });
            }
            const answerKey = kind === 'ssh.trustHost' || kind === 'ssh.replaceHostKey' ? 'trusted'
                : kind === 'daemon.replaceRemoteBackgroundServices' ? 'replaceExistingServices' : 'approved';
            expect(answers).toEqual([true, false].map(approved => ({ id: 'tool.systemTasks', method: 'respond',
                params: { taskId: 'trust-task', expectedPromptKind: kind, answer: { [answerKey]: approved } } })));
            expect(sheets).toHaveLength(hostKey ? 2 : 0);
        } finally { show.mockRestore(); await screen.unmount(); }
    });
    it('asks the administrator password on the detail page through the creation presenter and delivers it only as the exact prompt response', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-establish.test', scope: 'tab' });
        const homeId = 'srv_managed_establish';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'establish-controller', installationId: 'establish-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, active: true, activeAt: Date.now(), updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })]);
        const machine: ManagedMachineFullV1 = { id: 'establish-managed', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Design sandbox', choices: {} },
            controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'existing' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const prompt = { kind: 'administrator.establish' as const, promptId: 'administrator-prompt', administratorUsername: 'operator',
            message: 'Your new administrator password passes through setup.' };
        const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'establish-operation', revision: 1,
            actionId: 'machines.managed.acquire', state: 'running', scope: { accountId: 'owner', machineId: controller.machineId },
            title: 'Create Design sandbox', createdAt: 1, startedAt: 2, cancellation: 'supported',
            progress: { kind: 'phase', phase: 'administrator.establish', label: 'Waiting for the administrator password' },
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                bootstrapTask: { id: 'establish-task', taskKind: 'remote.ssh.bootstrapMachine.v1', prompt } } };
        const secret = 'correct-horse-battery-staple';
        const answers: unknown[] = [];
        const actionPaths: string[] = [];
        const cancelInputs: unknown[] = [];
        operationRpcBoundary.handler = request => {
            if (request.method === ACTION_OPERATION_RPC_METHODS_V2.list) return { items: [operation], nextCursor: null };
            if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) return { kind: 'found', operation };
            if (request.method === RPC_METHODS.CAPABILITIES_INVOKE) { answers.push(request.payload); return { ok: true, result: {} }; }
            return undefined;
        };
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            actionPaths.push(url.pathname);
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname === '/v1/machines/managed/actions/cancel') {
                cancelInputs.push(JSON.parse(String(init?.body)));
                return Response.json({ machine });
            }
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.provisioners.list' ? { provisioners: [] }
                        : actionId === 'machines.managed.get' ? machine : { machines: [machine] } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const consoleLines: string[] = [];
        for (const level of ['log', 'info', 'warn', 'error'] as const) {
            vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); });
        }
        const asked = vi.spyOn(Modal, 'prompt').mockResolvedValue(null);
        const additionalConfirmations: string[] = [];
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor({
                presentUserActionConfirmation: async ({ actionId }) => { additionalConfirmations.push(actionId); return false; },
            }))} />);
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.findByTestId('managed-machine.installation-prompt-approve'), screen.getTextContent()).not.toBeNull();
            });
            // The question is the installer's own, with the same two answers as every other installation question.
            expect(screen.getTextContent()).toContain(prompt.message);
            expect(asked).not.toHaveBeenCalled();

            // Closing the password dialog keeps the question open: only the row's own Cancel ends a paid creation.
            await screen.pressByTestId('managed-machine.installation-prompt-approve');
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(asked).toHaveBeenCalledTimes(1);
            });
            expect(asked.mock.calls[0]?.[2]).toMatchObject({ inputType: 'secure-text' });
            expect(answers).toEqual([]);
            expect(actionPaths).not.toContain('/v1/machines/managed/actions/cancel');

            asked.mockResolvedValue(secret);
            await screen.pressByTestId('managed-machine.installation-prompt-approve');
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(answers).toEqual([{ id: 'tool.systemTasks', method: 'respond',
                    params: { taskId: 'establish-task', expectedPromptKind: 'administrator.establish',
                        expectedPromptId: prompt.promptId, answer: { password: secret } } }]);
            });

            // Declining ends the creation through the existing Cancel Action, never through the respond path.
            await screen.pressByTestId('managed-machine.installation-prompt-decline');
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(cancelInputs).toEqual([expect.objectContaining({ managedId: machine.id, expectedIntentRevision: machine.intentRevision })]);
            });
            expect(answers).toHaveLength(1);
            expect(additionalConfirmations).toEqual([]);

            // The password reaches nothing but that one response, and no Controller access is added.
            const observable = JSON.stringify({ text: screen.getTextContent(), consoleLines, actionPaths, cancelInputs,
                operations: [...actionOperationStore.getSnapshot().operationsByKey.values()] });
            expect(observable).not.toContain(secret);
            expect(actionPaths.filter(path => /grant|controller/.test(path))).toEqual([]);
        } finally { await screen.unmount(); }
    });
    it('asks the installer task\'s pending service replacement on the waiting row and answers only through the user', async () => {
        const machine: ManagedMachineFullV1 = { id: 'consent-managed', homeId: 'consent-home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Design sandbox', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'existing' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const consent = { kind: 'daemon.replaceRemoteBackgroundServices' as const, message: 'Replace existing background services?' };
        const domainRef = { kind: 'managedMachine' as const, id: machine.id, resource: machine.resource, controller: machine.controller,
            bootstrapTask: { id: 'bootstrap', taskKind: 'remote.ssh.bootstrapMachine.v1' as const } };
        const snapshot: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'consent-operation', revision: 1, actionId: 'machines.managed.bootstrap.retry', state: 'running',
            scope: { accountId: 'owner', machineId: 'controller' }, title: 'Retry installation', createdAt: 1, startedAt: 2,
            progress: { kind: 'phase', phase: 'ssh.auth.wait', label: 'Waiting for pairing' }, cancellation: 'supported', domainRef,
        };
        const operation = { serverId: machine.homeId, snapshot, observation: 'available' as const, isUnavailableProjection: false };
        const answers: boolean[] = [];
        const answerPrompt = (approved: boolean) => { answers.push(approved); };
        const screen = await renderScreen(<ManagedCreationProgress {...{ machine, operation, answerPrompt }} />);
        // No open question: the row keeps reporting the task's stage and offers nothing to answer.
        expect(screen.findByTestId('managed-machine.installation-prompt-approve')).toBeNull();
        const asking = { ...operation, snapshot: { ...snapshot, revision: 2, domainRef: { ...domainRef,
            bootstrapTask: { ...domainRef.bootstrapTask, prompt: consent } } } };
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine, operation: asking, answerPrompt }} /></AccountNoticeInvestigationBoundary>));
        expect(answers).toEqual([]);
        const press = async (testID: string) => {
            const button = screen.tree.findAll(node => node.props?.testID === testID && typeof node.props.onPress === 'function')[0];
            expect(button).toBeDefined();
            await act(async () => button!.props.onPress());
        };
        await press('managed-machine.installation-prompt-approve');
        await press('managed-machine.installation-prompt-decline');
        expect(answers).toEqual([true, false]);
        // A settled task cannot be answered, even if its last projection still names the question.
        for (const state of ['failed', 'cancelled'] as const) {
            await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine, answerPrompt, operation: { ...asking,
                snapshot: { ...asking.snapshot, revision: 3, state, settledAt: 3,
                    ...(state === 'failed' ? { error: { errorCode: 'approval_declined', error: 'Remote machine pairing was not approved' } } : {}) } } }} /></AccountNoticeInvestigationBoundary>));
            expect(screen.findByTestId('managed-machine.installation-prompt-approve')).toBeNull();
            expect(screen.findByTestId('managed-machine.installation-prompt-decline')).toBeNull();
            if (state === 'cancelled') expect(screen.findByTestId('managed-machine.installation-error')).toBeNull();
        }
        await screen.unmount();
    });
    it('shows Home recovery for a retained bootstrap failure without operation history', async () => {
        const machine: ManagedMachineFullV1 = { id: 'home-unreachable-managed', homeId: 'home-unreachable', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Local guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'existing' } },
            observation: { observedAt: 4, availability: 'unavailable', reason: 'bootstrap.home_not_guest_reachable' },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} />);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-error'
            && node.props.title === t('managedMachines.creation.homeNotGuestReachable')).length).toBeGreaterThan(0);
        await screen.unmount();
    });
    it.each([
        { kind: 'retryInstallation', enrolled: false, online: false, stale: false,
            title: () => t('managedMachines.creation.install'), action: () => t('managedMachines.creation.retryInstall') },
        { kind: 'update', enrolled: true, online: true, stale: true,
            title: () => t('machineDetailPage.recovery.updateAvailable'), action: () => t('common.update') },
        { kind: 'restartDaemon', enrolled: true, online: false, stale: false,
            title: () => t('machineDetailPage.recovery.daemonDown'), action: () => t('machineDetailPage.recovery.restartDaemon') },
    ] as const)('names the $kind recovery on its one attention row with one action', async ({ enrolled, online, stale, title, action }) => {
        const machine: ManagedMachineFullV1 = { id: 'recovery-managed', homeId: 'recovery-home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build box', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'existing' } },
            ...(enrolled ? { enrolledMachineId: 'guest', observation: { observedAt: 4, availability: 'present' as const, power: 'running' as const,
                storage: 'retained' as const } } : {}),
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const pressed: string[] = [];
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} guestPayloadStale={stale}
            {...(enrolled ? { enrolledMachine: { machineId: 'guest', installationId: 'guest-installation', online, serviceManaged: true } } : {})}
            handlers={{ reinstall: () => pressed.push('recovery') }} />);
        const rows = screen.tree.findAllByType(Item).filter(node => node.props.testID === 'managed-machine.installation');
        expect(rows.map(row => row.props.title)).toEqual([title()]);
        if (enrolled) {
            // One row (TH N6): what the press does and when it was seen join the line; no separate freshness row.
            expect(rows[0]!.props.subtitle).toContain(t(online ? 'machineDetailPage.recovery.updateHelp' : 'machineDetailPage.recovery.daemonDownHelp'));
            expect(screen.findByTestId('managed-machine.observation')).toBeNull();
        }
        const buttons = screen.tree.findAllByType(RoundButton).filter(button => button.props.testID === 'managed-machine.installation-retry');
        expect(buttons.map(button => button.props.title)).toEqual([action()]);
        await act(async () => buttons[0]!.props.onPress());
        expect(pressed).toEqual(['recovery']);
        await screen.unmount();
    });
    it('shows only the observed installer stage and offers retry only for an explicit failed installation task', async () => {
        const machine: ManagedMachineFullV1 = { id: 'installer-managed', homeId: 'installer-home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Installing guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'existing' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const snapshot: import('@happier-dev/protocol/actions/operations/v1').ActionOperationSnapshotV1 = {
            version: 1, operationId: 'installer-operation', revision: 1, actionId: 'machines.managed.acquire', state: 'running',
            scope: { accountId: 'owner', machineId: 'controller' }, title: 'Create managed machine', createdAt: 1, startedAt: 2,
            progress: { kind: 'phase', phase: 'ssh_installing', label: 'Installing Happier' }, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller,
                bootstrapTask: { id: 'bootstrap', taskKind: 'remote.ssh.bootstrapMachine.v1' } },
        };
        const retried: unknown[] = [];
        const operation = { serverId: machine.homeId, snapshot, observation: 'available' as const, isUnavailableProjection: false };
        const recovered = await renderScreen(<ManagedCreationProgress machine={machine}
            handlers={{ reinstall: () => retried.push(machine.resource?.value) }} />);
        expect(recovered.findByTestId('managed-machine.installation-retry')).not.toBeNull();
        expect(recovered.findByTestId('managed-machine.installation-error')).toBeNull();
        await recovered.unmount();
        const screen = await renderScreen(<ManagedCreationProgress {...{ machine, operation,
            handlers: { reinstall: () => retried.push(machine.resource?.value) } }} />);
        const installing = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation' && node.props.subtitle)[0];
        expect(installing?.props.subtitle).toBe('Installing Happier');
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine,
            operation: { ...operation, snapshot: { ...snapshot, revision: 2, state: 'failed' as const, settledAt: 3,
                error: { errorCode: 'bootstrap_failed', error: 'Installer exited without completing' } } },
            handlers: { reinstall: () => retried.push(machine.resource?.value) } }} /></AccountNoticeInvestigationBoundary>));
        const retry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry' && typeof node.props.onPress === 'function')[0];
        expect(retry).toBeDefined();
        await act(async () => retry!.props.onPress());
        expect(retried).toEqual([{ resourceId: 'existing' }]);
        const failed = { ...operation, snapshot: { ...snapshot, revision: 2, state: 'failed' as const, settledAt: 3,
            error: { errorCode: 'bootstrap_failed', error: 'Installer exited without completing' } } };
        const enrolled = { ...machine, enrolledMachineId: 'installed-guest' };
        // A rejected native purchase has no resource to bind and is confirmed absent, as in CLOUD1.
        const rejectedMachine: ManagedMachineFullV1 = { ...machine, allocation: 'confirmed-absent', resource: undefined };
        for (const [nativeCause, diagnostic] of [
            [{ httpStatusClass: '4xx', code: 'resource_limit_exceeded' }, 'HTTP 4xx · resource_limit_exceeded'],
            [{ httpStatusClass: '4xx', code: 'invalid_input', fields: ['image', 'public_net'] }, 'HTTP 4xx · invalid_input · image, public_net'],
            [{ grpcStatusCode: 8 }, 'gRPC 8'],
            [{ sdkError: 'ResourceExhaustedError' }, 'ResourceExhaustedError'],
            [{ localCause: 'native_options_changed' }, 'native_options_changed'],
            [{ localCause: 'native_delete_refused', httpStatus: 400 }, 'HTTP 400 · native_delete_refused'],
            [{ localCause: 'native_route_unavailable' }, 'native_route_unavailable'],
            [{ localCause: 'native_lease_ended' }, 'native_lease_ended'],
        ] satisfies ReadonlyArray<readonly [MachineProvisionerNativeCauseV1, string]>) {
            await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine: rejectedMachine,
                operation: { ...failed, snapshot: { ...failed.snapshot,
                    domainRef: { kind: 'managedMachine', id: machine.id }, progress: undefined,
                    error: { errorCode: 'provider_unavailable', error: 'Untrusted native response content',
                        details: { kind: 'managedNative', nativeCause } } } } }} /></AccountNoticeInvestigationBoundary>));
            if (!screen.findByTestId('managed-machine.installation-error.detailsContent'))
                await screen.pressByTestIdAsync('managed-machine.installation-error.details');
            expect(screen.getTextContent()).toContain(`provider_unavailable · ${diagnostic}`);
            expect(screen.getTextContent()).not.toContain('Untrusted native response content');
        }
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine,
            operation: { ...failed, snapshot: { ...failed.snapshot,
                progress: { kind: 'phase', phase: 'ssh.auth.wait', label: 'Waiting for pairing' },
                error: { errorCode: 'provider_unavailable', error: 'provider_unavailable' } } } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-error'
            && node.props.title === t('managedMachines.creation.enrollmentUnavailable')).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('provider_unavailable');
        for (const errorCode of ['database_connection_unavailable', 'database_transaction_conflict_exhausted', 'internal_error']) {
            await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine,
                operation: { ...failed, snapshot: { ...failed.snapshot,
                    progress: { kind: 'phase', phase: 'ssh.installCli', label: 'Installing Happier' },
                    error: { errorCode, error: errorCode, details: { kind: 'managedControllerRequest',
                        path: '/v1/machines/managed/controller/current', category: 'status',
                        status: errorCode === 'internal_error' ? 500 : 503, code: errorCode } } } },
                handlers: { reinstall: () => retried.push('same-resource-after-home-failure') } }} /></AccountNoticeInvestigationBoundary>));
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-error'
                && node.props.title === t('managedMachines.creation.homeRequestFailed')).length).toBeGreaterThan(0);
            expect(screen.getTextContent()).toContain(errorCode);
            const homeRetry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry'
                && typeof node.props.onPress === 'function')[0];
            expect(homeRetry).toBeDefined();
        }
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine,
            operation: { ...failed, snapshot: { ...failed.snapshot,
                error: { errorCode: 'remote_cli_update_required', error: 'legacy daemon diagnostic' } } } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-error'
            && node.props.title === t('setupOnboarding.remoteSshChecklist.remoteCliUpdateRequired')).length).toBeGreaterThan(0);
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine: enrolled,
            operation: { ...failed, snapshot: { ...failed.snapshot,
                error: { errorCode: 'native_boot_unconfirmed', error: 'Native boot configuration failed after enrollment' } } },
            handlers: { reinstall: () => retried.push('same-enrolled-resource') } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.findByTestId('managed-machine.installation-error')).not.toBeNull();
        expect(screen.getTextContent()).toContain('native_boot_unconfirmed');
        const enrolledRetry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry'
            && typeof node.props.onPress === 'function')[0];
        expect(enrolledRetry).toBeDefined();
        await act(async () => enrolledRetry!.props.onPress());
        expect(retried).toEqual([{ resourceId: 'existing' }, 'same-enrolled-resource']);
        const bootRetry = { ...failed, snapshot: { ...failed.snapshot, operationId: 'boot-retry',
            actionId: 'machines.managed.bootstrap.retry' as const,
            domainRef: { kind: 'managedMachine' as const, id: machine.id, controller: machine.controller, resource: machine.resource },
            error: { errorCode: 'native_boot_unconfirmed', error: 'Native boot configuration remains unconfirmed' } } };
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine: enrolled, operation: bootRetry,
            handlers: { reinstall: () => retried.push('same-boot-retry-resource') } }} /></AccountNoticeInvestigationBoundary>));
        const repeatedRetry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry'
            && typeof node.props.onPress === 'function')[0];
        expect(repeatedRetry).toBeDefined();
        await act(async () => repeatedRetry!.props.onPress());
        expect(retried).toEqual([{ resourceId: 'existing' }, 'same-enrolled-resource', 'same-boot-retry-resource']);
        const { error: _bootError, ...successfulBoot } = bootRetry.snapshot;
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine: enrolled,
            operation: { ...bootRetry, snapshot: { ...successfulBoot, revision: 3, state: 'succeeded' as const } },
            handlers: { reinstall: () => retried.push('after-boot-success') } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-error').length).toBe(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine: { ...machine,
            submittedNativeEffect: { intentRevision: 2, requestId: 'delete-current', intent: 'delete', controller: machine.controller } }, operation: failed,
            handlers: { reinstall: () => retried.push('while-deleting') } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine: { ...machine,
            observation: { observedAt: 4, availability: 'absent' } }, operation: failed,
            handlers: { reinstall: () => retried.push('after-absence') } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine: { ...machine,
            resource: { ...machine.resource!, value: { resourceId: 'replacement' } } }, operation: failed,
            handlers: { reinstall: () => retried.push('wrong-resource') } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation').length).toBe(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine: { ...machine,
            controller: { ...machine.controller!, installationId: 'replacement-installation' } }, operation: failed,
            handlers: { reinstall: () => retried.push('wrong-installation') } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation').length).toBe(0);
        await act(async () => screen.tree.update(<AccountNoticeInvestigationBoundary><ManagedCreationProgress {...{ machine,
            operation: { ...operation, snapshot: { ...snapshot, revision: 2, state: 'failed' as const, settledAt: 3,
                domainRef: { kind: 'managedMachine' as const, id: machine.id },
                error: { errorCode: 'allocation_failed', error: 'Resource creation failed' } } },
            handlers: { reinstall: () => retried.push('wrong') } }} /></AccountNoticeInvestigationBoundary>));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
    });
    it.each([
        { power: 'stopped', online: false, intent: 'start' },
        { power: 'suspended', online: false, intent: 'resume' },
        { power: 'stopped', online: true, intent: 'start' },
    ] as const)('offers $intent only with an available assigned controller ($power, online=$online)', async ({ power, online, intent }) => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-power-availability.test', scope: 'tab' });
        const homeId = 'srv_managed_power_availability';
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id },
            { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'controller', installationId: 'installation' };
        const launch = { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Asleep guest', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'asleep-managed', homeId, custodianAccountId: 'owner', launch, controller,
            allocation: 'bound', creationState: 'active', resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native' } },
            desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power, storage: 'retained' },
            reviewedFacts: { launch, controller, optionStatus: 'current', prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['start', 'resume', 'stop'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        const controllerMachine = createMachineFixture({ id: controller.machineId, installationId: controller.installationId,
            active: online, activeAt: Date.now(), updatedAt: Date.now(), presenceProtocolVersion: 1 });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [controllerMachine]);
        const published = storage.getState().machineListByServerId[serverId]!.find(row => row.id === controller.machineId)!;
        publishMachineActivityForTest([published], { active: online, activeAt: Date.now() });
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => id === controller.machineId
                ? { ...createPlainMachineRowFixture({ id, accountId: 'owner', machine: controllerMachine }),
                    installationId: controller.installationId, installationPublicKey: controllerInstallationPublicKey } : null);
            const qualification = staticRetentionQualification(machine, url, init, ['start', 'resume', 'stop']);
            if (qualification) return qualification;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAllByType(ManagedCreationProgress).length).toBeGreaterThan(0);
        });
        // Native sleep is still the displayed fact even when immediate power is unavailable.
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.observation.power).toBe(power);
        const actions = screen.tree.findAll(node => node.props?.testID === `managed-machine.${intent}`);
        if (online) {
            const progress = screen.tree.findByType(ManagedCreationProgress);
            expect(actions.some(node => node.props.disabled !== true) || typeof progress.props.handlers.start === 'function').toBe(true);
        } else {
            expect(actions.every(node => node.props.disabled === true)).toBe(true);
            expect(screen.tree.findByType(ManagedCreationProgress).props.handlers.start).toBeUndefined();
        }
    });
    it.each(['stop', 'start'] as const)('reviews power on the same stopped resource with desired %s in the saved Home before native dispatch', async desired => {
        const intent = desired === 'start' ? 'stop' : 'start';
        const realExecute = createFrontDoorActionExecute(createDefaultActionExecutor());
        const actionCompleted = createDeferred<Awaited<ReturnType<typeof realExecute>>>();
        const executeAction: typeof realExecute = Object.assign(async (...args: Parameters<typeof realExecute>) => {
            try {
                const result = await realExecute(...args);
                if (args[0] === 'machines.managed.power.set') actionCompleted.resolve(result);
                return result;
            } catch (error) {
                if (args[0] === 'machines.managed.power.set') actionCompleted.reject(error);
                throw error;
            }
        }, { confirmed: realExecute.confirmed, prepare: realExecute.prepare });
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-start-approval.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_start');
        await upsertAndActivateServer({ serverUrl: 'https://other-managed-start.test', scope: 'tab' });
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const launch: ManagedMachineFullV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'Stopped resource', choices: {} };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const machine: ManagedMachineFullV1 = { id: 'start-existing', homeId: 'srv_managed_start', custodianAccountId: 'owner', launch,
            controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { resourceId: 'same-native' } },
            desired, desiredWhen: 'now', intentRevision: 4, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            ...(desired === 'start' ? { submittedNativeEffect: { intentRevision: 4, requestId: 'submitted-start', intent: 'start' as const,
                controller: { machineId: 'controller', installationId: 'installation' } } } : {}),
            observation: { availability: 'present', observedAt: 2, power: 'stopped', storage: 'retained' },
            reviewedFacts: { launch, controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
                billing: { location: 'cloud', stoppedBilling: 'not-billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now(),
        })]);
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const nativeRequests: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-start-approval.test');
            const machines = managedControllerReadBatch(machine, url, init);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/actions/machines.managed.power.set') {
                const request = readNativeControllerRequest(init);
                nativeRequests.push(request);
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, requestId: request.requestId,
                    actionId: 'machines.managed.power.set', execution: { ok: true,
                        result: { kind: 'approval_request_created', artifactId: 'controller-start-approval', actionId: 'machines.managed.power.set' } } }));
            }
            expect(url.pathname).toBe('/v1/machines/managed/actions/get');
            return Response.json(machine);
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={executeAction} />);
        // A stopped, retained resource offers Start on its state row; the receipt keeps the other power verbs.
        const powerTestID = intent === 'start' ? 'managed-machine.progress:start' : `managed-machine.${intent}`;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => node.props?.testID === powerTestID
                && typeof node.props.onPress === 'function' && node.props.disabled !== true)).not.toHaveLength(0);
        });
        const start = screen.tree.findAll(node => node.props?.testID === powerTestID && typeof node.props.onPress === 'function')[0];
        expect(start).toBeDefined();
        expect(start!.props.disabled).not.toBe(true);
        let outcome: Awaited<ReturnType<typeof realExecute>> | undefined;
        await act(async () => {
            start!.props.onPress();
            outcome = await actionCompleted.promise;
        });
        const actionDiagnostics = screen.tree.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode);
        expect(nativeRequests, JSON.stringify({ outcome, actionDiagnostics })).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'controller' },
            input: { homeId: machine.homeId, managedId: machine.id, when: 'now', expectedRevision: 4, intent } })]);
        expect(artifacts.list()).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
        expect(screen.tree.findAll(node => node.props?.testID === `managed-machine.${intent}` && node.props.disabled === true).length).toBeGreaterThan(0);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.observation.power).toBe('stopped');
    });
    it.each(['online', 'offline', 'replaced', 'missing-schema'] as const)('reviews fresh Devcontainer effects only on the same reachable controller (%s)', async controllerState => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-rebuild.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_rebuild');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const provider = { pluginId: 'custom.container', localId: 'native' };
        const selectors = { workspaceFolder: '/source', configPath: '/source/.devcontainer/devcontainer.json' };
        const launch: ManagedMachineFullV1['launch'] = { provider, schemaVersion: 1, name: 'Existing child',
            choices: { ...selectors, reviewedEffectDigest: 'a'.repeat(64) } };
        const machine: ManagedMachineFullV1 = { id: 'rebuild-existing', homeId: 'srv_managed_rebuild', custodianAccountId: 'owner', launch,
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { resourceId: 'same-native-child' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 4, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
                billing: { location: 'local', stoppedBilling: 'not-billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete', 'rebuild'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const descriptor = { id: 'native', title: 'Devcontainer', icon: 'cube', resourceKind: 'devcontainer', schemaVersion: 1,
            launchSchema: { type: 'object', properties: { workspaceFolder: { type: 'string' }, configPath: { type: 'string' },
                reviewedEffectDigest: { type: 'string' } }, required: ['workspaceFolder', 'configPath', 'reviewedEffectDigest'], additionalProperties: false },
            resourceSchema: { type: 'object', properties: { resourceId: { type: 'string' } }, required: ['resourceId'], additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
            retention: { supportedIntents: ['start', 'stop', 'delete', 'rebuild'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect',
                power: 'power', destroy: 'destroy', rebuild: 'rebuild' } };
        operationRpcBoundary.schemaAnswer = controllerState === 'missing-schema' ? { ok: true } : { ok: true, inputSchema: { type: 'object', properties: {
            workspaceFolder: { type: 'string' }, configPath: { type: 'string' } },
            required: ['workspaceFolder', 'configPath'], additionalProperties: false } };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        const controllerActivity = { active: controllerState !== 'offline', activeAt: Date.now() };
        const controllerMachine = createMachineFixture({ id: 'controller',
            installationId: controllerState === 'replaced' ? 'replacement' : 'installation',
            ...controllerActivity, updatedAt: controllerActivity.activeAt, presenceProtocolVersion: 1 });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [controllerMachine]);
        const publishedController = storage.getState().machineListByServerId[serverId]?.find(candidate => candidate.id === controllerMachine.id);
        if (!publishedController) throw new Error('Expected the published controller');
        publishMachineActivityForTest([publishedController], controllerActivity);
        const rebuilds: unknown[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-rebuild.test');
            // Exact reads and inventory describe the same controller, including its offline/replaced state.
            if (url.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id =>
                id === controllerMachine.id ? { ...createPlainMachineRowFixture({ id, accountId: 'owner', machine: controllerMachine }),
                    installationId: controllerMachine.installationId, installationPublicKey: controllerInstallationPublicKey } : null);
            const authorization = managedControllerAuthorization(machine, url, init);
            if (authorization) return authorization;
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (actionId === 'machines.managed.rebuild') rebuilds.push(request);
                if (actionId === 'machines.provisioners.options') expect(request.input).toMatchObject({ selectors });
                const result = actionId === 'machines.provisioners.list' ? MachineProvisionersListResultV1Schema.parse({
                    provisioners: [{ contribution: provider, occurrenceId: 'container-occurrence', acquireExecutionTarget: 'daemon' as const, descriptor }] })
                    : actionId === 'machines.provisioners.options' ? MachineProvisionerOptionsResultV1Schema.parse(createMachineProvisionerOptionsFixture({ base: {
                        available: true,
                        launch: { ...selectors, reviewedEffectDigest: 'b'.repeat(64) }, effectReview: { kind: 'devcontainer',
                            reviewedEffectDigest: 'b'.repeat(64), effects: [
                                { scope: 'host', kind: 'initialize', title: 'Initialize on controller', details: ['touch /source/ready'] },
                                { scope: 'child', kind: 'lifecycle', title: 'Set up child', details: ['make setup'] },
                            ] } } })) : actionId === 'machines.managed.rebuild' ? {
                        kind: 'approval_request_created', artifactId: 'rebuild-approval', actionId,
                    } : { available: true };
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, requestId: request.requestId,
                    actionId, execution: { ok: true, result } }));
            }
            expect(url.pathname).toBe('/v1/machines/managed/actions/get');
            return Response.json(machine);
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.rebuild' && typeof node.props.onPress === 'function')).not.toHaveLength(0);
        });
        const rebuild = screen.tree.findAll(node => node.props?.testID === 'managed-machine.rebuild' && typeof node.props.onPress === 'function')[0];
        expect(rebuild).toBeDefined();
        if (controllerState === 'offline' || controllerState === 'replaced') {
            expect(rebuild!.props.disabled).toBe(true);
            await act(async () => rebuild!.props.onPress());
            await flushHookEffects({ cycles: 10 });
            expect(rebuilds).toEqual([]);
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.rebuild-confirm').length).toBe(0);
            return;
        }
        expect(rebuild!.props.disabled).not.toBe(true);
        await act(async () => rebuild!.props.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            if (controllerState === 'missing-schema') expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error')
                .map(node => node.props.diagnosticCode)).toContain('managed_parent_unavailable');
            else expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.rebuild-effect.host:0').length).toBeGreaterThan(0);
        });
        expect(rebuilds).toEqual([]);
        if (controllerState === 'missing-schema') {
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error')
                .map(node => node.props.diagnosticCode)).toContain('managed_parent_unavailable');
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.rebuild-confirm')).toEqual([]);
            return;
        }
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.rebuild-effect.host:0').length,
            JSON.stringify(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error').map(node => node.props.diagnosticCode))).toBeGreaterThan(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.rebuild-effect.child:1').length).toBeGreaterThan(0);
        const confirm = screen.tree.findAll(node => node.props?.testID === 'managed-machine.rebuild-confirm' && typeof node.props.onPress === 'function')[0];
        await act(async () => confirm!.props.onPress());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(rebuilds).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'controller' }, input: {
                homeId: machine.homeId, managedMachineId: machine.id, expectedRevision: 4, kind: 'rebuild', reviewedEffectDigest: 'b'.repeat(64),
            } })]);
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
        });
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.resource).toEqual(machine.resource);
    });
    it('keeps an Ask-first policy Action pending in the ordinary approval owner without applying its policy', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-policy-approval.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_policy_approval');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const machine = { id: 'ask-policy', homeId: 'srv_managed_policy_approval', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Ask resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } satisfies ManagedMachineReadSnapshotV1;
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const nativeRequests: unknown[] = [];
        await publishMachineInventoryForTest({ serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'owner' }, [
            createMachineFixture({ id: machine.controller.machineId, installationId: machine.controller.installationId, updatedAt: Date.now() }),
        ]);
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-policy-approval.test');
            const qualification = staticRetentionQualification(machine, url, init);
            if (qualification) return qualification;
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'machines.managed.retention.update': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/actions/machines.managed.retention.update') {
                const request = readNativeControllerRequest(init);
                nativeRequests.push(request);
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, requestId: request.requestId,
                    actionId: 'machines.managed.retention.update', execution: { ok: true,
                        result: { kind: 'approval_request_created', artifactId: 'controller-policy-approval', actionId: 'machines.managed.retention.update' } } }));
            }
            expect(url.pathname).toBe('/v1/machines/managed/actions/get');
            return Response.json(machine);
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(false);
        });
        await act(async () => { void screen.tree.findByType(ManagedMachinePolicySection).props.keep.onChange({
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true,
        }); });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
        });
        expect(nativeRequests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'controller' },
            input: { homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 1,
                retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true } })]);
        expect(artifacts.list()).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject({
            retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage,
        });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(true);
    });
    it('settles a failed Keep parent read into the existing unavailable state', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-keep-timeout.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_keep_timeout');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const launch: ManagedMachineFullV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'Timeout resource', choices: {} };
        const machine = { id: 'managed-keep-timeout', homeId: 'srv_managed_keep_timeout', custodianAccountId: 'owner', launch,
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'ordinary-enrolled',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} }, allocation: 'bound', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } satisfies ManagedMachineReadSnapshotV1;
        await publishMachineInventoryForTest({ serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'owner' }, [
            createMachineFixture({ id: machine.controller.machineId, installationId: machine.controller.installationId, activeAt: Date.now() }),
        ]);
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/actions/machines.provisioners.list')
                return Response.json({ code: 'target_unavailable' }, { status: 503 });
            const qualification = staticRetentionQualification(machine, url, init);
            if (qualification) return qualification;
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedEnrolledMachineSections enrolledMachineId={machine.enrolledMachineId!} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep).toMatchObject({
                capabilitiesAvailable: false,
                unavailableReason: t('managedRetention.waitsForProvider', { provider: t('common.machine') }),
            });
        });
        await screen.unmount();
    });
    it('keeps one Keep parent read running across a Home change that revalidates the same resource', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-keep-revalidate.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_keep_revalidate');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const launch: ManagedMachineFullV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'Revalidated resource', choices: {} };
        const machine = { id: 'managed-keep-revalidate', homeId: 'srv_managed_keep_revalidate', custodianAccountId: 'owner', launch,
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'ordinary-enrolled',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} }, allocation: 'bound', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } satisfies ManagedMachineReadSnapshotV1;
        await publishMachineInventoryForTest({ serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'owner' }, [
            createMachineFixture({ id: machine.controller.machineId, installationId: machine.controller.installationId, activeAt: Date.now() }),
        ]);
        const revalidation = createDeferred<Response>();
        const revalidationEntered = createDeferred<void>();
        const nativeCatalog = createDeferred<Response>();
        let inventoryReads = 0;
        let parentReads = 0;
        let parentSignal: AbortSignal | null | undefined;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/actions/machines.provisioners.list') {
                parentReads++;
                parentSignal = init?.signal;
                return nativeCatalog.promise;
            }
            if (url.pathname === '/v1/machines/managed/actions/list') {
                if (inventoryReads++ === 0) return Response.json({ machines: [machine] });
                revalidationEntered.resolve();
                return revalidation.promise;
            }
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedEnrolledMachineSections enrolledMachineId={machine.enrolledMachineId!} serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(parentReads).toBe(1);
            expect(screen.tree.findAllByType(ManagedCreationProgress)[0]?.props.handlers?.checkNow).toBeTypeOf('function');
        });
        const operationReads = () => operationRpcBoundary.requests.filter(request => request.method === ACTION_OPERATION_RPC_METHODS_V2.list).length;
        const readsBeforeRevalidation = operationReads();
        const checkNow = () => screen.tree.findAllByType(ManagedCreationProgress)[0]?.props.handlers?.checkNow;
        expect(checkNow()).toBeTypeOf('function');
        // Busy Homes publish changes constantly; a revalidation of the same row must not abort and restart the read.
        await act(async () => {
            publishHomeAccountChange(target.id);
            await revalidationEntered.promise;
        });
        expect(inventoryReads).toBe(2);
        expect(parentReads).toBe(1);
        expect(parentSignal?.aborted).toBe(false);
        expect(operationReads()).toBe(readsBeforeRevalidation);
        expect(checkNow()).toBeTypeOf('function');
        await act(async () => revalidation.resolve(Response.json({ machines: [machine] })));
        await flushHookEffects({ cycles: 20 });
        expect(operationReads()).toBe(readsBeforeRevalidation);
        expect(checkNow()).toBeTypeOf('function');
        await screen.unmount();
        expect(parentSignal?.aborted).toBe(true);
    });
    it('mounts the enrolled association with the immutable receipt and removes it on read refusal', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://enrolled-managed-detail.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_enrolled_detail');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner') });
        const launch: ManagedMachineFullV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'Original recipe', choices: { cpu: 4, image: 'captured-image' } };
        const machine = { id: 'managed-enrolled', homeId: 'srv_enrolled_detail', custodianAccountId: 'owner', launch,
            controller: { machineId: 'new-controller', installationId: 'new-installation' }, enrolledMachineId: 'ordinary-enrolled',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { resourceId: 'original-native' } },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 3,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            reviewedFacts: { launch, controller: { machineId: 'original-controller', installationId: 'original-installation' },
                optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'not-billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                nativeFacts: { size: { id: 'captured-size', title: 'Four-core guest', cpuCores: 4 },
                    image: { id: 'captured-image', title: 'Original Linux image', description: 'Long-term support' },
                    location: { id: 'captured-location', title: 'Original region', countryCode: 'DE' } },
                prices: [{ amount: '0.125', currency: 'USD', unit: 'hour', source: 'captured-price', observedAt: 5 }] } } satisfies ManagedMachineReadSnapshotV1;
        const receiptController = createMachineFixture({ id: 'original-controller', installationId: 'original-installation',
            metadata: { ...createMachineFixture().metadata!, displayName: 'Original controller computer' } });
        const machineScope = { serverId: resolveServerProfileScopeIdForIdentifier(target.id), accountId: 'owner' };
        await publishMachineInventoryForTest(machineScope, [receiptController]);
        let denied = false;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://enrolled-managed-detail.test');
            const qualification = staticRetentionQualification(machine, url, init);
            if (qualification) return qualification;
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            expect(url.pathname).toBe('/v1/machines/managed/actions/list');
            return denied ? Response.json({ code: 'permission_denied' }, { status: 403 }) : Response.json({ machines: [machine] });
        });
        const screen = await renderScreen(<ManagedEnrolledMachineSections enrolledMachineId="ordinary-enrolled" serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(MachineConfigurationReceipt).props.model)
                .toMatchObject({ name: 'Original recipe', cost: { kind: 'price', prices: machine.reviewedFacts!.prices } });
        });
        const receipt = screen.tree.findByType(MachineConfigurationReceipt);
        expect(receipt.props.model).toMatchObject({ name: 'Original recipe', cost: { kind: 'price', prices: machine.reviewedFacts!.prices } });
        expect(receipt.props.model.facts).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'controller', value: 'Original controller computer' }),
        ]));
        // The live Keep it sits beside the receipt; a creation-time policy row there would contradict it.
        expect(receipt.props.model.facts.map((fact: { id: string }) => fact.id)).not.toContain('retention');
        expect(receipt.props.model.keep).toBeUndefined();
        // The size and its labelled native dimensions are the receipt's spec line (RV-C F13).
        expect(receipt.props.model.spec).toBe(`Four-core guest · ${t('managedMachines.receipt.cores', { count: 4 }).replace(/ /g, '\u00a0')}`);
        // Delete sits at the receipt's foot. Power is not observed yet, so no Start beside Stop: Check now reads it first.
        expect(receipt.props.model.secondary?.map((action: { testID?: string }) => action.testID))
            .toEqual(['managed-machine.resize', 'managed-machine.delete']);
        // What it was made with is the receipt alone: no second "Size, image and place" section repeats it.
        expect(screen.findByTestId('managed-machine.launch')).toBeNull();
        expect(receipt.props.model.facts.map((fact: { id: string }) => fact.id)).toEqual(expect.arrayContaining(['image', 'location']));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.policy').length).toBeGreaterThan(0);
        const controller = createMachineFixture({ id: machine.controller.machineId,
            installationId: machine.controller.installationId, activeAt: Date.now() });
        await act(async () => { await publishMachineInventoryForTest(machineScope, [controller]); });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.controller').length).toBeGreaterThan(0);
        await act(async () => { await publishMachineInventoryForTest(machineScope, [{ ...controller, installationId: 'replacement-installation',
            seq: controller.seq + 1, updatedAt: controller.updatedAt + 1 }]); });
        // Online presence for a same-id replacement does not prove the required installation is available.
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.controller')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.controller-unavailable').length).toBeGreaterThan(0);
        await flushHookEffects({ cycles: 25 });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.capabilitiesAvailable).toBe(false);
        let saved: unknown;
        await act(async () => { saved = await screen.tree.findByType(ManagedMachinePolicySection).props.keep.onChange({
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        }); });
        await flushHookEffects({ cycles: 20 });
        // A replaced installation cannot qualify editing; the retained policy stays readable.
        expect(saved).toBe(false);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject({
            retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage,
        });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeUndefined();
        // Read-only, Reset keeps its place but cannot be pressed.
        expect(screen.findByTestId('managed-machine.policy.keep:reset')?.props.disabled ?? true).toBe(true);
        denied = true;
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(() => {
            expect(httpFacts, 'The Home wake must settle the enrolled association read refusal')
                .toContainEqual({ path: '/v1/machines/managed/actions/list', status: 403 });
            expect(screen.tree.findAllByType(MachineConfigurationReceipt)).toHaveLength(0);
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.policy')).toHaveLength(0);
        });
        await act(async () => { await publishMachineInventoryForTest(machineScope, []); });
    });
    it.each([390, 1440])('names a created machine in its header by where it came from and its observed power at %i px', async width => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-header-identity.test', scope: 'tab' });
        setRuntimeFetch(async () => Response.json({ error: 'not_found' }, { status: 404 }));
        const launch: ManagedMachineFullV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'hz-build-2', choices: {} };
        const machine: ManagedMachineFullV1 = { id: 'managed-identity', homeId: 'srv_identity', custodianAccountId: 'owner', launch,
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'enrolled',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} }, allocation: 'bound', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power: 'running' },
            reviewedFacts: { launch, controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
                billing: { location: 'cloud', stoppedBilling: 'billed' }, prerequisites: [], retentionCapabilities: { supportedIntents: ['stop'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, preset: { id: 'build', revision: 3, name: 'Build box' } } };
        const seen: Array<ManagedMachineHeaderIdentity | null> = [];
        const { MachinePageHeader } = await import('@/components/machines/page/MachinePageHeader');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const enrolled = createMachineFixture({ id: 'enrolled', metadata: { ...createMachineFixture().metadata!, host: 'lima-native-generated-id', platform: 'linux' } });
        function Probe(props: Readonly<{ machine?: ManagedMachineReadSnapshotV1 }>) {
            const identity = useManagedMachineHeaderIdentity(props.machine, target.id);
            seen.push(identity);
            return <MachinePageHeader target={{ machineId: enrolled.id, requestedServerId: target.id, serverId: target.id,
                activeServerId: target.id, machine: enrolled, machineName: 'lima-native-generated-id', machineSentenceName: 'lima-native-generated-id',
                isServerSwitching: false, isHydratingMachine: false, switchReady: true }}
                managedIdentity={identity} renaming={false} onRename={() => {}} />;
        }
        const screen = await renderScreen(<Probe machine={machine} />);
        expect(screen.tree.findByType(PageHeader).props.title).toBe('hz-build-2');
        expect(seen.at(-1)?.description).toBe(t('managedMachines.detail.madeFromPreset', { preset: 'Build box' }));
        expect(seen.at(-1)?.meta.some(fact => fact.key === 'managed-power')).toBe(false);
        // Unknown power says nothing rather than "Running" on a guess.
        await screen.update(<Probe machine={{ ...machine, observation: { availability: 'unavailable', observedAt: 2 } }} />);
        expect(seen.at(-1)?.meta.some(fact => fact.key === 'managed-power')).toBe(false);
        await screen.update(<Probe />);
        expect(seen.at(-1)).toBeNull();
    });
    it('says an offline created machine\'s state in the same word as the Machines rail', async () => {
        const { managedMachineHeaderPresence } = await import('./ManagedMachineSections');
        const { describeMachinePresenceLine } = await import('@/utils/sessions/machinePresenceLine');
        const { resolveManagedMachineWorkStatus } = await import('@/components/work/status/resolveWorkStatusTone');
        const asleep = { id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Lima', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: {} },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'after-idle', intentRevision: 1,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            observation: { availability: 'present', observedAt: 1, power: 'stopped', storage: 'retained' } } satisfies ManagedMachineReadSnapshotV1;
        const rail = resolveManagedMachineWorkStatus({ online: false, managedMachine: asleep, machineId: 'guest' })?.word;
        expect(rail).toBeTruthy();
        const offlineGuest = createMachineFixture({ id: 'guest', active: false, activeAt: 1 });
        expect(describeMachinePresenceLine(offlineGuest, 10_000_000, managedMachineHeaderPresence(asleep)).label).toBe(rail);
        // Nothing observed yet: still the rail's word, never a second vocabulary.
        const unobserved = { ...asleep, observation: undefined };
        expect(describeMachinePresenceLine(offlineGuest, 10_000_000, managedMachineHeaderPresence(unobserved)).label)
            .toBe(resolveManagedMachineWorkStatus({ online: false, managedMachine: unobserved, machineId: 'guest' })?.word);
    });
    it('does not imply continuing billing after confirmed absence, even with a retained cleanup marker', async () => {
        const screen = await renderScreen(<ManagedCreationProgress machine={{ id: 'absent', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Ended resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'confirmed-absent', creationState: 'canceled',
            cleanup: { disposition: 'pending', reason: 'previous_cleanup' }, desired: 'delete', desiredWhen: 'now', intentRevision: 2,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }} />);
        expect(screen.getTextContent()).not.toContain(t('managedMachines.creation.mayBill'));
    });
    it('shows Check now working while its check runs', async () => {
        const stopped = { id: 'checking', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Lima', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' },
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: {} },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power: 'stopped', storage: 'retained' } } satisfies ManagedMachineReadSnapshotV1;
        const check = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.tree.findAll(node =>
            node.props?.testID === 'managed-machine.observation-check' && typeof node.props?.onPress === 'function')[0];
        const idle = await renderScreen(<ManagedCreationProgress machine={stopped} handlers={{ checkNow: () => {} }} />);
        expect(check(idle)?.props.loading).toBeFalsy();
        await idle.unmount();
        const checking = await renderScreen(<ManagedCreationProgress machine={stopped} handlers={{ checkNow: () => {} }} checking />);
        expect(check(checking)?.props.loading).toBe(true);
    });
    it.each(['approval', 'retired', 'plan-failed', 'effects-changed'] as const)('prepares a retained setup retry from exact preset revision and current source references before Apply (%s)', async outcome => {
        const target = await upsertAndActivateServer({ serverUrl: `https://retained-setup-${outcome}.test`, scope: 'tab' });
        const homeId = `srv_retained_setup_${outcome}`;
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'controller', installationId: 'controller-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }),
        createMachineFixture({ id: 'joined-machine', installationId: 'joined-installation', updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })]);
        const machine = ManagedMachineFullV1Schema.parse({ id: 'setup-retry', homeId, custodianAccountId: 'owner', controller,
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build guest', choices: {} },
            enrolledMachineId: 'joined-machine', allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'existing' } },
            preset: { id: 'admitted-preset', revision: 2, contentEncryptionMode: 'plain' }, machineSetup: { state: 'failed', errorCode: 'setup_failed',
                setup: { toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' }, scripts: [{ body: 'echo retained snapshot', affects: 'none' }] } },
            desired: 'start', desiredWhen: 'now', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 9, exclusions: [], support: [], sources: [
            { kind: 'bundledPreset', ref: { pluginId: 'com.example.recipes', localId: 'base', revision: '1' },
                setup: { scripts: [{ body: 'echo other retained copy' }] } },
            { kind: 'accountPresetOpaque', presetId: machine.preset!.id, presetRevision: 1, contentEncryptionMode: 'plain' },
            { kind: 'direct', setup: { toolchain: { adapterId: 'mise', config: '[tools]\npython = "3.13"' },
                scripts: [{ body: 'echo direct', affects: 'none' }] } },
        ], sourceFacts: {
            'bundled:com.example.recipes/base': { firstPresence: { shared: 'present' } },
            [`account:${machine.preset!.id}`]: { firstPresence: { package: 'absent' } },
            direct: { firstPresence: { direct: 'present' } },
        } });
        const sources = [
            current.sources[0], { ...current.sources[1], presetRevision: machine.preset!.revision },
            current.sources[2],
        ];
        const expected = MachineSetupApplyInputV1Schema.parse({ homeId, machineId: machine.enrolledMachineId,
            targets: [{ homeId, machineId: machine.enrolledMachineId, sources, desiredRevision: current.desiredRevision,
                preset: { id: machine.preset!.id, revision: machine.preset!.revision }, recipePlans: [], exclusions: [] }],
        });
        const releasePlan = createDeferred<void>();
        const plans: unknown[] = [];
        const applies: unknown[] = [];
        const savedPresetReads: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe(target.serverUrl);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            const nativeTargets = [controller, { machineId: machine.enrolledMachineId!, installationId: 'joined-installation' }];
            const machines = managedControllerReadBatch(machine, url, init, nativeTargets);
            if (machines) return machines;
            const authorization = managedControllerAuthorization(machine, url, init, nativeTargets);
            if (authorization) return authorization;
            if (url.pathname.includes('/presets/')) {
                savedPresetReads.push(url.pathname);
                // Reset's mounted policy owner reads today's Preset, independently of the retained Setup copy.
                if (url.pathname === '/v1/machines/presets/get') {
                    expect(JSON.parse(String(init?.body))).toEqual({ homeId, id: machine.preset!.id });
                    return Response.json(ManagedMachinePresetGetResultV1Schema.parse({ kind: 'found', preset: createPlainManagedMachinePresetFixture({
                        id: machine.preset!.id, homeId, revision: 99, name: 'Current policy parent',
                        owner: { kind: 'account', accountId: 'owner' }, launch: machine.launch, controller,
                        setup: { scripts: [{ body: 'echo live preset must not replace retained setup' }] },
                    }) }));
                }
            }
            const qualification = staticRetentionQualification(machine, url, init);
            if (qualification) return qualification;
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = readNativeControllerRequest(init);
                if (actionId === 'machines.setup.plan') {
                    plans.push(request.input);
                    await releasePlan.promise;
                    const effects = MachineSetupPlanInputV1Schema.parse(request.input).mode === 'effects';
                    return Response.json({ v: 1, requestId: request.requestId, actionId, execution: outcome === 'plan-failed'
                        ? { ok: false, errorCode: 'unavailable', error: 'unavailable' }
                        : effects && outcome === 'effects-changed' ? { ok: false, errorCode: 'plan_changed', error: 'plan_changed' }
                        : { ok: true, result: effects ? { ...current, sources, recipePlans: [] } : current } });
                }
                if (actionId === 'machines.setup.apply') applies.push(request.input);
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.managed.get' ? machine : actionId === 'machines.managed.list' ? { machines: [machine] }
                        : { kind: 'approval_request_created', artifactId: 'retained-setup-review', actionId } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedEnrolledMachineSections enrolledMachineId="joined-machine" serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        let unmounted = false;
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(savedPresetReads).toEqual(['/v1/machines/presets/get']);
                expect(screen.findByTestId('managed-machine.setup-retry')).not.toBeNull();
            });
            const retry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.setup-retry' && typeof node.props.onPress === 'function')[0]!.props.onPress;
            await act(async () => { retry(); retry(); });
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(plans, JSON.stringify({ applies, diagnostics: screen.tree.findAllByType(SurfaceStateCard)
                    .map(node => ({ id: node.props.testID, code: node.props.diagnosticCode })) })).toEqual([{ homeId, machineId: machine.enrolledMachineId }]);
            });
            expect(applies).toEqual([]);
            if (outcome === 'retired') { await screen.unmount(); unmounted = true; }
            releasePlan.resolve();
            await flushHookEffects({ cycles: 30 });
            if (outcome === 'approval') {
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(applies).toEqual([expected]);
                    expect(screen.findByTestId('managed-machine.approval')).not.toBeNull();
                });
                await act(async () => retry());
                expect(applies).toEqual([expected]);
                expect(plans).toEqual([{ homeId, machineId: machine.enrolledMachineId },
                    { homeId, machineId: machine.enrolledMachineId, sources, mode: 'effects' }]);
            } else {
                expect(applies).toEqual([]);
                if (outcome === 'plan-failed') await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(screen.tree.findAllByType(SurfaceStateCard).filter(node => node.props.testID === 'managed-machine.control-error')
                        .map(node => node.props.diagnosticCode)).toContainEqual(expect.stringMatching(/^unavailable(?: · |$)/u));
                });
                if (outcome === 'effects-changed') {
                    await waitForHomeGovernance(async () => {
                        await flushHookEffects();
                        expect(screen.tree.findAllByType(SurfaceStateCard).filter(node => node.props.testID === 'managed-machine.control-error')
                            .map(node => node.props.diagnosticCode)).toContainEqual(expect.stringMatching(/^plan_changed(?: · |$)/u));
                    });
                    expect(plans).toEqual([{ homeId, machineId: machine.enrolledMachineId },
                        { homeId, machineId: machine.enrolledMachineId, sources, mode: 'effects' }]);
                }
            }
            expect(savedPresetReads).toEqual(['/v1/machines/presets/get']);
        } finally {
            releasePlan.resolve();
            if (!unmounted) await screen.unmount();
        }
    });
    it('offers Retry setup and Continue without setup on a failed Set up of this same joined machine (D53)', async () => {
        const machine: ManagedMachineFullV1 = { id: 'setup-failed', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'ordinary-machine',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native' } },
            preset: { id: 'preset', revision: 2, contentEncryptionMode: 'plain' }, machineSetup: { setup: { scripts: [{ body: 'npm ci' }] }, state: 'failed', errorCode: 'setup_failed' },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const retry = vi.fn();
        const skip = vi.fn();
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} setupRecovery={{ retry, skip }} />);
        for (const testID of ['managed-machine.setup-retry', 'managed-machine.setup-skip']) {
            await act(async () => screen.tree.findAll(node => node.props?.testID === testID && typeof node.props.onPress === 'function')[0]!.props.onPress());
        }
        expect(retry).toHaveBeenCalledTimes(1);
        expect(skip).toHaveBeenCalledTimes(1);
        const succeeded = await renderScreen(<ManagedCreationProgress machine={{ ...machine,
            machineSetup: { setup: { scripts: [{ body: 'npm ci' }] }, state: 'succeeded' } }} setupRecovery={{ retry, skip }} />);
        expect(succeeded.tree.findAll(node => node.props?.testID === 'managed-machine.setup')).toHaveLength(0);
    });
    it.each([false, true])('distinguishes an allocation recovery reference from native identity (resource known: %s)', async resourceKnown => {
        const provider = { pluginId: 'happier.machine.boat', localId: 'boat' };
        const machine: ManagedMachineFullV1 = { id: 'managed-correlation', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Boat', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' },
            ...(resourceKnown ? { resource: { contributionRef: provider, schemaVersion: 1, value: { sandboxId: 'boat-native-sandbox' } } } : {}),
            allocation: resourceKnown ? 'bound' : 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            recovery: { reference: 'managed-correlation', reason: 'native_acquisition_unconfirmed' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} />);
        // An uncertain allocation retains its lookup reference without claiming that it is a vendor-issued sandbox ID.
        expect(screen.getTextContent()).toContain(machine.recovery!.reference);
        expect(screen.tree.findAllByType(Item).filter(node => node.props.title === t('managedMachines.detail.happierTag'))).toHaveLength(1);
        const nativeRows = screen.tree.findAllByType(Item).filter(node => node.props.title === t('managedMachines.detail.nativeIdentity'));
        expect(nativeRows).toHaveLength(resourceKnown ? 1 : 0);
        if (resourceKnown) expect(screen.getTextContent()).toContain('boat-native-sandbox');
    });
    it('labels a provider recovery reference without calling it a Happier tag or native identity', async () => {
        const machine: ManagedMachineFullV1 = { id: 'managed-correlation', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'happier.machine.modal', localId: 'modal' }, schemaVersion: 1, name: 'Modal', choices: {} },
            allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            recovery: { reference: 'workspace/sandbox-app', reason: 'provider_unavailable' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} />);
        expect(screen.getTextContent()).toContain(machine.recovery!.reference);
        const titles = screen.tree.findAllByType(Item).map(node => node.props.title);
        expect(titles).toContain(t('managedMachines.detail.recoveryReference'));
        expect(titles).not.toContain(t('managedMachines.detail.happierTag'));
        expect(titles).not.toContain(t('managedMachines.detail.nativeIdentity'));
    });
    it.each([false, true])('presents a rejected acquisition as nothing created with its actual diagnostic (absence observed: %s)', async absenceObserved => {
        const code = 'native_trial_auto_stop_required';
        const machine: ManagedMachineFullV1 = { id: 'rejected-allocation', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'happier.machine.boat', localId: 'boat' }, schemaVersion: 1, name: 'Boat', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' },
            allocation: 'confirmed-absent', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            ...(absenceObserved ? { observation: { observedAt: 4, availability: 'absent' as const, reason: code } } : {}),
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} handlers={{ checkNow: vi.fn(), reinstall: vi.fn() }}
            operation={{ serverId: 'home', observation: 'available', isUnavailableProjection: false,
                snapshot: { version: 1, operationId: 'rejected-create', revision: 2, actionId: 'machines.managed.acquire',
                    state: 'failed', scope: { accountId: 'owner', machineId: 'controller' }, title: 'Create Boat',
                    createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
                    domainRef: { kind: 'managedMachine', id: machine.id }, error: { errorCode: code, error: code } } }} />);
        expect(screen.findByTestId('managed-machine.installation-error')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('managedMachines.inspect.notCreated'));
        await screen.pressByTestIdAsync(absenceObserved
            ? 'managed-machine.installation-error-details-toggle' : 'managed-machine.installation-error.details');
        expect(screen.getTextContent()).toContain(code);
        expect(screen.getTextContent()).not.toContain(t('managedMachines.creation.installFailedTitle', { name: machine.launch.name }));
        expect(screen.getTextContent()).not.toContain(t('managedPower.resourceAbsent'));
        expect(screen.getTextContent()).not.toContain(t('managedMachines.creation.mayBill'));
        expect(screen.tree.findAllByType(RoundButton).filter(node => node.props.title === t('managedMachines.inspect.checkNow'))).toHaveLength(0);
    });
    it('does not present an enrolled healthy Machine as still awaiting its Happier connection', async () => {
        const machine: ManagedMachineFullV1 = { id: 'enrolled-healthy', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Enrolled resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'ordinary-machine',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native' } },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 5, availability: 'present', power: 'running', storage: 'retained' } };
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} />);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.progress')).toHaveLength(0);
        // A healthy created machine is named by its size and image; native identity is only for recovery.
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.recovery')).toHaveLength(0);
        const start = vi.fn();
        const stopped = await renderScreen(<ManagedCreationProgress machine={{ ...machine,
            observation: { ...machine.observation!, power: 'stopped' } }} handlers={{ start }} />);
        expect(stopped.tree.findAll(node => node.props?.testID === 'managed-machine.progress').length).toBeGreaterThan(0);
        await stopped.pressByTestIdAsync('managed-machine.progress:start');
        expect(start).toHaveBeenCalledOnce();
    });
    it('reads the saved Home, clears refused content, and hands verified enrollment to the ordinary Machine route', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-detail.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_detail');
        await upsertAndActivateServer({ serverUrl: 'https://other-focused.test', scope: 'tab' });
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner') });
        const machine = { id: 'pending', homeId: 'srv_detail', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Retained resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        let state: 'pending' | 'denied' | 'enrolled' = 'pending';
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-detail.test');
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            expect(JSON.parse(String(init?.body))).toEqual({ homeId: 'srv_detail', managedId: 'pending' });
            if (state === 'denied') return Response.json({ code: 'permission_denied' }, { status: 403 });
            return Response.json({ ...machine, ...(state === 'enrolled' ? { enrolledMachineId: 'machine-joined' } : {}) });
        });
        const executeAction = createFrontDoorActionExecute(createDefaultActionExecutor());
        const screen = await renderScreen(<ManagedMachineDetail managedId="pending" serverId={target.id} executeAction={executeAction} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.progress').length).toBeGreaterThan(0);
        });
        // A bound unenrolled row alone is not evidence that installation failed or is retryable.
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.retry-install')).toHaveLength(0);
        // An unpriced retained resource still has a creation receipt; absence of a price does not hide its launch.
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.detail.receipt:cost').length).toBeGreaterThan(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.detail.receipt:keep')).toHaveLength(0);
        state = 'denied';
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.progress')).toHaveLength(0);
            expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.cancel')).toHaveLength(0);
            // The unread page names what it is about (a created machine), not the Machines list it came from.
            expect(screen.tree.findByType(ManagedReceiptPageLayout).props.header.title).toBe(t('managedMachines.detail.unreadTitle'));
        });
        state = 'enrolled';
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.findByType(ManagedCreationProgress).props.machine.enrolledMachineId).toBe('machine-joined');
        });
        // Enrollment may precede the ordinary Machine projection: keep its retained receipt reachable.
        expect(screen.tree.findAllByType('Redirect' as never)).toHaveLength(0);
        await act(async () => publishMachineInventoryForTest({ serverId: target.id, accountId: 'owner' }, [
            createMachineFixture({ id: 'machine-joined' }),
        ]));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            const redirect = screen.tree.findByType('Redirect' as never);
            // Rendered inside Settings (no door set), the enrolled machine opens in the Settings door.
            expect(resolveHref(redirect.props.href)).toBe(`/settings/machines/machine-joined?serverId=${encodeURIComponent(target.id)}`);
        });
    });
    it('keeps an already admitted inventory identity in the header without listing for a saved-resource read', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-detail-identity.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_detail_identity');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner') });
        let machine = ManagedMachineFullV1Schema.parse({ id: 'pending-identity', homeId: 'srv_detail_identity', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Known Cua resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const detail = createDeferred<Response>();
        let listReads = 0;
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines/managed/actions/list') { listReads++; return Response.json({ machines: [machine] }); }
            if (path === '/v1/machines/managed/actions/get') return detail.promise;
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        // Exercise the actual collection/detail defaults, including their shared read owner.
        const collection = await renderHook(() => useManagedMachineInventory([target.id]));
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(collection.getCurrent().entries[serverId]?.status).toBe('ready');
            expect(listReads).toBe(1);
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id} />);
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.tree.findByType(ManagedReceiptPageLayout).props.header.title).toBe(machine.launch.name);
                expect(screen.findByTestId('managed-machine.read-state')).not.toBeNull();
                expect(listReads).toBe(1);
            });
            machine = { ...machine, launch: { ...machine.launch, name: 'Current known resource' } };
            await act(async () => collection.getCurrent().refresh());
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.tree.findByType(ManagedReceiptPageLayout).props.header.title).toBe(machine.launch.name);
                expect(screen.findByTestId('managed-machine.read-state')).not.toBeNull();
                expect(listReads).toBe(2);
            });
        } finally {
            detail.resolve(Response.json(machine));
            await flushHookEffects({ cycles: 20 });
            await screen.unmount();
            await collection.unmount();
        }
    });
    it('opens on a neutral header that claims no state while the exact read is pending', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-detail-pending-header.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_detail_pending_header');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner') });
        const detail = createDeferred<Response>();
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines/managed/actions/get') return detail.promise;
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId="pending-header" serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        try {
            await flushHookEffects({ cycles: 20 });
            const header = screen.tree.findByType(ManagedReceiptPageLayout).props.header;
            expect(header.title).toBe(t('machineDetailPage.placeholderTitle'));
            expect(header.description).toBeUndefined();
            expect(screen.getTextContent()).not.toContain(t('managedMachines.detail.creationDescription'));
        } finally {
            detail.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
            await flushHookEffects({ cycles: 20 });
        }
    });
    it.each(['managed_not_found', 'not_found', 'unavailable'] as const)('uses exact get as absence authority and never lists for a cold retained archived resource (%s)', async code => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-detail-deleted.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_detail_deleted');
        await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: createAccountTokenForTests('owner') });
        let listReads = 0;
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            // The ordinary list excludes retained archived resources. It cannot establish their absence.
            if (path === '/v1/machines/managed/actions/list') { listReads++; return Response.json({ machines: [] }); }
            if (path === '/v1/machines/managed/actions/get') return Response.json({ code }, { status: code === 'unavailable' ? 503 : 404 });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId="deleted" serverId={target.id}
            executeAction={createFrontDoorActionExecute(createDefaultActionExecutor())} />);
        await flushHookEffects({ cycles: 25 });
        expect(screen.getTextContent()).toContain(t(code === 'managed_not_found' ? 'managedMachines.detail.missing' : 'managedMachines.detail.loadFailed'));
        expect(screen.getTextContent()).not.toContain(t(code === 'managed_not_found' ? 'managedMachines.detail.loadFailed' : 'managedMachines.detail.missing'));
        // MB-3: a confirmed-gone machine names itself gone and leads back to Machines; a Retry can't bring it back.
        const header = screen.tree.findByType(ManagedReceiptPageLayout).props.header;
        const state = screen.tree.findAll(node => node.props.testID === 'managed-machine.read-state' && 'action' in node.props)[0];
        if (code === 'managed_not_found') {
            expect(header.title).toBe(t('managedMachines.detail.goneTitle'));
            expect(header.description).toBeUndefined();
            expect(state?.props.action?.label).toBe(t('managedMachines.detail.backToMachines'));
        } else {
            expect(state?.props.action?.label).toBe(t('common.retry'));
        }
        expect(listReads).toBe(0);
        await screen.unmount();
    });
});

/** Keep choices a person could press now, inline or in the phone sheet; a read-only rule draws them disabled. */
function enabledKeepChoices(screen: { tree: { findAll: (predicate: (node: { props: Record<string, unknown> }) => boolean) => { props: Record<string, unknown> }[] } },
    choices: readonly string[]) {
    const ids = choices.flatMap(choice => [`managed-machine.policy.keep:choice:${choice}`, `managed-machine.policy-sheet.keep:choice:${choice}`]);
    return screen.tree.findAll(node => ids.includes(node.props?.testID as string) && typeof node.props.onPress === 'function' && node.props.disabled !== true)
        .map(node => node.props.testID);
}
