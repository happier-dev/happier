import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { CollectionDraftTitleScope, useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { CollectionDraftRow } from '@/components/ui/lists/collection/CollectionList';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { QualifiedAccountDetailView } from './QualifiedAccountDetailView';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { MachineReadBatchRequestV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import * as machineInventoryProjection from '@/sync/domains/machines/machineInventorySnapshots';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import {
    configureConnectedServerSocketBoundary,
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { Modal, ModalProvider } from '@/modal';
import { t } from '@/text';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope, captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection,
    getAccountConnectedServiceConfigurationMode, getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readConnectedAccountCatalog } from '@/sync/api/account/apiConnectedAccountCatalog';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
import { QualifiedConnectedAccountCredentialDeleteV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot, primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import {
    ConnectedAccountAuthenticationCommandRequestSchema,
    ConnectedAccountAttemptResponseSchema,
    ConnectedAccountControlCommandRequestSchema,
    type ConnectedAccountAuthenticationCommandRequest,
    type ConnectedAccountControlCommandRequest,
    type ConnectedAccountDaemonControlResponse,
    CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
    ConnectedAccountDaemonControlResponseSchema} from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import {
    type PluginConnectedAccountAuthenticationModeV2,
    PluginConnectedAccountAuthenticationModeV2Schema,
    PluginConnectedAccountAuthenticationV2Schema} from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import {
    QualifiedConnectedAccountCredentialMutationV4Schema,
    type QualifiedConnectedAccountProfileV4,
    QualifiedConnectedAccountQuotaResponseV4Schema,
    openQualifiedConnectedAccountQuotaResponseV4} from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import {
    type BuiltInLegacyConnectedAccountCompatibility,
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID} from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import {
    buildProviderAccountUsageRecordId} from '@happier-dev/protocol/connect/account-usage-primitives';
import {
    QualifiedConnectedAccountRefSchema} from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import {
    QualifiedConnectedAccountProfileV4Schema,
    QualifiedConnectedAccountGroupV4Schema,
    QualifiedConnectedAccountGroupListResponseV4Schema} from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import {
    parseQualifiedConnectedAccountV4StructuredQueryValue} from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import {
    ConnectedServiceAuthGroupPolicyV2Schema} from '@happier-dev/protocol/connect/connected-service-schemas';
import {
    ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import {
    type QualifiedConnectedAccountPurposeBindingTargetV1} from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import {
    SharedSavedSecretPromoteInputV1Schema} from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import {
    formatSharedSavedSecretRefV1,
} from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { ConnectedAccountSetupController, ConnectedAccountServiceView } from './ConnectedAccountServiceView';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
    ConnectedPresentationRowMutationV1Schema, type ConnectedPresentationRecordV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowMutationV1Schema,
    type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ANTHROPIC_API_KEY_INPUT_SCHEMA } from '../../../../../../../packages/plugins/claude/src/connectedAccounts/anthropicRuntime';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { parseQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { ConnectedServiceSetupPanel, type ConnectedServiceSetupCatalogEntry, type ConnectedServiceSetupTarget } from '../setup/ConnectedServiceSetupPanel';
import { ConnectedServicesConnectMore } from '../setup/ConnectedServicesConnectMore';
import { ConnectSheetContent } from '../setup/ConnectSheetContent';
import { presentConnectSheet } from '../setup/ConnectedServiceSetupModal';
import { ConnectedServicesSettingsView } from '../ConnectedServicesSettingsView';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { AppShellPluginUiProjectionProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { getActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { PoolMemberRow } from '../pools/PoolMemberRow';
import { QualifiedConnectedAccountGroupMemberMutationV4Schema, QualifiedConnectedAccountGroupMemberDeleteV4Schema,
    QualifiedConnectedAccountGroupPatchV4Schema, QualifiedConnectedAccountGroupActiveAccountV4Schema,
    QualifiedConnectedAccountGroupCreateV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';

const platform = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>,
    confirm: vi.fn(async () => true),
    navigate: vi.fn(),
    replace: vi.fn(),
    dismissTo: vi.fn(),
}));

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// The controller imports the scoped socket owner eagerly; replace its external
// SDK factory before those imports, then configure each real cold socket below.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
// Keep the real machine picker beneath a deterministic portal/window measurement boundary.
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('expo-router', async () => {
    const mocked = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => platform.params }).module;
    const router = { ...mocked.router, canGoBack: () => false, push: platform.navigate, replace: platform.replace, dismissTo: platform.dismissTo };
    return { ...mocked, router, useRouter: () => router };
});
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm: platform.confirm }, renderCustomModals: true }).module);
// Account authentication executes its real compiled artifact through native asset IO.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({
    localUri: `file:///public-auth-fixture/${asset}`, downloadAsync: async () => {},
}) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    async bytes() {
        const bytes = packaged.files.get(Number(this.uri.split('/').at(-1)));
        if (!bytes) throw new Error('Missing packaged authentication fixture asset');
        return bytes;
    }
} }));
vi.mock('expo-crypto', async original => ({ ...await original<typeof import('expo-crypto')>(),
    randomUUID: (await import('node:crypto')).randomUUID }));
// No Markdown is rendered in this controller journey. Fail if this absent third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in account setup'); },
}));
installDisconnectedServerSocketBoundary();

const { PLUGIN_MANIFEST: codexManifest } = await import('../../../../../../../packages/plugins/codex/src/manifest');
const codexAuthentication = PluginConnectedAccountAuthenticationV2Schema.parse(
    codexManifest.contributes.connectedAccountDescriptors?.find(row => row.id === 'openai-codex')?.authentication,
).account;
if (!codexAuthentication) throw new Error('Codex Account authentication declaration missing');
await (await import('@/dev/testkit/fixtures/connectedAccountAuthentication')).prepareAuthenticationInventory(packaged, {
    manifest: codexManifest, target: codexAuthentication, projectPath: 'packages/plugins/codex',
    entryPath: 'packages/plugins/codex/src/connectedAccounts/account.ts', packageName: '@happier-dev/plugins-codex',
});

const service = { pluginId: 'acme.accounts', localId: 'work' };
const authentication = {
    defaultModeId: 'manual',
    modes: [{
        id: 'manual', kind: 'manual' as const, outcomeReconciliation: 'none' as const,
        fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' as const, minLength: 1 } }],
    }],
};
const described: Extract<ConnectedAccountDaemonControlResponse, { status: 'described' }> = {
    status: 'described', service,
    descriptor: { id: 'work', title: 'Acme Work', authentication },
    occurrenceId: 'occurrence-1',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'npm' },
    accounts: [], operationTransport: { kind: 'v4' },
};

type AuthenticationCommand = ConnectedAccountAuthenticationCommandRequest['command'];
type ControlCommand = ConnectedAccountControlCommandRequest['command'];
type WireHandler<T> = (command: T) => unknown | Promise<unknown>;
function deferredReply() {
    let resolve!: (response: unknown) => void;
    const promise = new Promise<unknown>((done) => { resolve = done; });
    return { promise, resolve };
}
const configuredMode: PluginConnectedAccountAuthenticationModeV2 = {
    id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck',
    configuration: {
        scope: 'account', changeBehavior: 'reconnect', fields: [
            { id: 'endpoint', title: 'Endpoint', secret: false, required: true, schema: { type: 'string', minLength: 1 } },
            { id: 'secret', title: 'Secret', secret: true, schema: { type: 'string' } },
        ],
    },
};
const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';

/** The real companion row consumes the mounted editor's public draft-title store. */
function DraftRailRow(props: Readonly<{ placeholder?: string }>) {
    return <CollectionDraftRow testID="p8-draft-row" titles={useCollectionDraftTitle()} placeholder={props.placeholder ?? 'Draft'} />;
}
const configurationTarget = { kind: 'attempt' as const, attemptId: 'attempt-1', service, modeId: 'oauth' };
const configurationReply: Extract<ConnectedAccountDaemonControlResponse, { status: 'configuration' }> = {
    status: 'configuration', target: configurationTarget, mode: configuredMode,
    occurrenceId: described.occurrenceId, sourceCustody: described.sourceCustody,
    configuration: {
        status: 'configurationRequired', revision: 'config-1', values: { endpoint: 'https://old.example' },
        configuredSecretFieldIds: ['secret'], missingFieldIds: [],
    },
};

describe('ConnectedAccountSetupController real ownership', () => {
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let selection: MachineAdministrationTargetSelectionV1;
    const authenticationCommands: AuthenticationCommand[] = [];
    const authenticationRequestIds: string[] = [];
    const controlRequestIds: string[] = [];
    const controlCommands: ControlCommand[] = [];
    const machineRequestStacks: string[] = [];
    let description: typeof described;
    let handleAuthentication: WireHandler<AuthenticationCommand>;
    let handleControl: WireHandler<ControlCommand>;
    let handleHttp: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']>;
    let purposeBoundary: ReturnType<typeof installPurposeBoundary> | null;
    let machineRows: ReturnType<typeof createPlainMachineRowFixture>[];
    let handleMachineRead: (() => Promise<Response>) | undefined;
    let handleMachineReadId: string;
    const httpRequests: URL[] = [];
    const onConnected = vi.fn();
    const onCancel = vi.fn();

    async function answerConnectedCommand(machineId: string, method: string, payload: unknown): Promise<unknown> {
        const control = ConnectedAccountControlCommandRequestSchema.safeParse(payload);
        if (control.success) {
            expect(method).toBe(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD);
            expect(control.data.machineId).toBe(machineId);
            controlCommands.push(control.data.command);
            return await handleControl(control.data.command);
        }
        expect(method).toBe(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD);
        const request = ConnectedAccountAuthenticationCommandRequestSchema.parse(payload);
        expect(request.machineId).toBe(machineId);
        authenticationCommands.push(request.command);
        return await handleAuthentication(request.command);
    }

    // The Home publishes V4 pools on the Account profile from the same reader as its
    // group list (C1). This server fake pushes that profile after each group change.
    async function publishServedPoolGroups(): Promise<void> {
        const response = await handleHttp('https://connected-account-setup.example.test/v4/connect/qualified/groups', { method: 'GET' });
        if (!response?.ok) return;
        const body: unknown = await response.json();
        const groups = QualifiedConnectedAccountGroupListResponseV4Schema.safeParse(body);
        if (!groups.success) return;
        await act(async () => {
            storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountGroupsV4: groups.data.groups });
        });
    }

    // These native-flow cases choose a declared method explicitly. A bare Add
    // request presents its declaration without admitting native work.
    const element = (selected = selection, requestedService = service,
        modeId: string | null | undefined = description.descriptor.authentication.defaultModeId) => <InjectedAuthProvider credentials={null}>
        <ConnectedAccountSetupController service={requestedService} targetSelection={selected}
            panel={{ intent: { kind: 'add' }, onConnected, onCancel, ...(modeId ? { modeId } : {}) }} />
    </InjectedAuthProvider>;

    /** A fresh method's own Ready action begins authentication; the panel never starts a sign-in by itself. */
    async function pressReadyAction(screen: Awaited<ReturnType<typeof renderScreen>>, id = 'connected-account-oauth:start') {
        await vi.waitFor(() => {
            const action = screen.findHostByTestId(id);
            expect(action).not.toBeNull();
            expect(action!.props.disabled).not.toBe(true);
        });
        await screen.pressByTestIdAsync(id);
    }

    function installDescription(next: typeof described, serviceId = 'acme-work') {
        ConnectedAccountDaemonControlResponseSchema.parse(next);
        description = next;
        installConnectedAccountDescriptorProjection({
            scopeKey: getActiveServerSnapshot().serverId, status: 'ready', conflicts: [], errorReason: null,
            descriptors: [{
                id: next.service.localId, serviceId, pluginId: next.service.pluginId,
                title: 'Acme Work', provenance: 'external', sourceKind: 'installed',
                authentication: next.descriptor.authentication, capabilities: [],
                availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
            }],
        }, captureActiveServerAccountScopeLifetime());
    }

    async function manualScreen() {
        const screen = await renderScreen(element(selection, service, 'manual'));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), JSON.stringify({
            rendered: screen.getTextContent(),
            controlCommands,
            authenticationCommands,
            httpPaths: httpRequests.map(request => request.pathname),
        })).not.toBeNull());
        return screen;
    }

    /** Native RPC replies publish their finite address at the real HTTP boundary. */
    async function installNativeConfigurationAttemptBoundary(machineId = selection.selectedTarget!.machineId) {
        const [{ captureLazyActionAccountContext }, { createNativeAttemptAddressBoundary, answerAttemptTransaction }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
        ]);
        const captured = await captureLazyActionAccountContext(account.home.id);
        const address = await createNativeAttemptAddressBoundary(captured, machineId);
        const { createUiConnectedAccountAttemptTransactionApi } = await import('@/sync/ops/connectedAccounts/connectedAccountAttemptTransactions');
        const { createUiConnectedAccountContent } = await import('@/sync/ops/connectedAccounts/connectedAccountContent');
        const nativeTransactions = createUiConnectedAccountAttemptTransactionApi(captured);
        const nativeContent = createUiConnectedAccountContent(captured);
        const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
        const previousHttp = handleHttp;
        handleHttp = async (input, init) => await answerAttemptTransaction(new URL(String(input)), init, transactions)
            ?? previousHttp(input, init);
        const nativeControl = handleControl;
        handleControl = async command => {
            const response = ConnectedAccountDaemonControlResponseSchema.parse(await nativeControl(command));
            if (response.status === 'pendingAttempts') for (const attempt of response.attempts) {
                if (!transactions.has(attempt.attemptId)) await nativeTransactions.create({
                    attemptId: attempt.attemptId, kind: attempt.kind,
                    content: await nativeContent.seal('attempt', await nativeContent.resolveAccountMode('fresh-authority'), null),
                    scope: { machineId, phase: attempt.phase, createdAtMs: attempt.createdAtMs,
                        intent: attempt.intent, service: description.service, modeId: attempt.modeId },
                });
            }
            return response;
        };
        const nativeAuthentication = handleAuthentication;
        handleAuthentication = async command => {
            const response = ConnectedAccountAttemptResponseSchema.parse(await nativeAuthentication(command));
            if ((response.status === 'configurationRequired' || response.status === 'awaitingManual') && response.attemptId) {
                const modeId = response.status === 'configurationRequired' ? response.target.modeId
                    : command.operation === 'beginConnect' ? command.modeId : description.descriptor.authentication.defaultModeId;
                const mode = description.descriptor.authentication.modes.find(candidate => candidate.id === modeId);
                if (!mode) throw new Error('Native fixture requires its declared authentication mode');
                await address.acknowledge({ attemptId: response.attemptId,
                    kind: mode.kind === 'oauthAuthorizationCode' ? 'oauth' : mode.kind === 'oauthDeviceCode' ? 'device' : 'manual', phase: response.status,
                    createdAtMs: Date.now(),
                    intent: command.operation === 'beginReconnect' || response.status === 'configurationRequired' && response.target.kind === 'account'
                        ? 'reconnect' : 'connect',
                    service: description.service, modeId: mode.id });
            } else if (response.status === 'awaitingOAuth' || response.status === 'awaitingDeviceAuthorization'
                || response.status === 'outcomeUnknown') {
                const modeId = command.operation === 'beginConnect' ? command.modeId : description.descriptor.authentication.defaultModeId;
                const mode = description.descriptor.authentication.modes.find(candidate => candidate.id === modeId);
                if (!mode) throw new Error('Native fixture requires its declared authentication mode');
                if (!transactions.has(response.attemptId)) await nativeTransactions.create({
                    attemptId: response.attemptId, kind: mode.kind === 'oauthDeviceCode' ? 'device' : 'oauth',
                    content: await nativeContent.seal('attempt', await nativeContent.resolveAccountMode('fresh-authority'), null),
                    scope: { machineId, phase: response.status, createdAtMs: Date.now(),
                        intent: command.operation === 'beginReconnect' ? 'reconnect' : 'connect',
                        service: description.service, modeId: mode.id },
                });
            } else if (response.status === 'connected' || response.status === 'cancelled') {
                await address.clear(response.attemptId);
            }
            return response;
        };
        return address;
    }

    async function seedConnectedServicesPage() {
        // These capabilities belong to All services, now pushed from the phone's collection root.
        platform.params = { view: 'all' };
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'existing' },
            status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'legacy_unfenced',
            credentialRevision: null, configurationReady: true, configurationRevision: null });
        installDescription({ ...described, accounts: [saved] });
        const profile = { ...profileDefaults, id: 'account-a', connectedAccountsV4: [saved] };
        storage.getState().applyProfile(profile);
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } },
        } });
        const previousHttp = handleHttp;
        handleHttp = async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/profile') return Response.json(profile);
            return previousHttp(url, init);
        };
        // Cold restoration can still be finishing its first feature probe. Let
        // that request settle before the fixture publishes its V4 Home answer.
        await getServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId });
        primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features } });
    }

    async function seedServicesOverview() {
        await seedConnectedServicesPage();
        const saved = (accountId: string, status: 'connected' | 'needs_reauth') => QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service, accountId }, status, authenticationModeId: 'manual', revisionSemantics: 'legacy_unfenced',
            credentialRevision: null, configurationReady: true, configurationRevision: null,
            providerIdentity: { email: `${accountId}@example.com` },
        });
        const profile = { ...storage.getState().profile, connectedAccountsV4: [saved('work', 'connected'), saved('personal', 'needs_reauth')] };
        storage.getState().applyProfile(profile);
        const previousHttp = handleHttp;
        handleHttp = async (url, init) => new URL(String(url)).pathname === '/v1/account/profile'
            ? Response.json(profile) : previousHttp(url, init);
        const descriptor = getConnectedServiceRegistrySnapshot().entries.find(entry => entry.service?.pluginId === service.pluginId
            && entry.service.localId === service.localId)?.projectedDescriptor;
        if (!descriptor) throw new Error('Expected the real overview descriptor');
        const unconnected = { pluginId: descriptor.pluginId, localId: 'vault' };
        installConnectedAccountDescriptorProjection({ scopeKey: getActiveServerSnapshot().serverId,
            status: 'ready', conflicts: [], errorReason: null,
            descriptors: [descriptor, { ...descriptor, id: unconnected.localId, serviceId: 'acme-vault', title: 'Acme Vault' }],
        }, captureActiveServerAccountScopeLifetime());
        return unconnected;
    }

    it('lists an account needing sign-in first and offers an unconnected service in the real Connect catalog', async () => {
        const unconnected = await seedServicesOverview();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ModalProvider>
            <ConnectedServicesSettingsView />
        </ModalProvider></InjectedAuthProvider>);
        try {
            const personal = `connected-services-account:${service.pluginId}/${service.localId}:personal`;
            const work = `connected-services-account:${service.pluginId}/${service.localId}:work`;
            await vi.waitFor(() => expect(screen.findHostByTestId(personal), screen.getTextContent()).not.toBeNull());
            const needsYou = screen.tree.findByTestId('connected-services-index:needs-you');
            expect(needsYou?.findAll(node => typeof node.type === 'string' && node.props.testID === personal)).toHaveLength(1);
            expect(needsYou?.findAll(node => typeof node.type === 'string' && node.props.testID === work)).toHaveLength(0);
            expect(screen.findHostByTestId(work)).not.toBeNull();
            await screen.pressByTestIdAsync('connected-services-connect-more:browse.action');
            await screen.pressByTestIdAsync('connected-service-setup:group:plugins');
            await vi.waitFor(() => expect(screen.findHostByTestId(
                `connected-service-setup:connect:${unconnected.pluginId}/${unconnected.localId}`), screen.getTextContent()).not.toBeNull());
            expect(authenticationCommands).toEqual([]);
        } finally { await screen.unmount(); }
    });

    it('keeps saved accounts visible when no online machine publishes their service', async () => {
        await seedServicesOverview();
        installConnectedAccountDescriptorProjection({ scopeKey: getActiveServerSnapshot().serverId,
            status: 'ready', conflicts: [], errorReason: null, descriptors: [],
        }, captureActiveServerAccountScopeLifetime());
        machineRows = [];
        storage.getState().applyMachines([], true, { sourceServerId: getActiveServerSnapshot().serverId });
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedServicesSettingsView /></InjectedAuthProvider>);
        try {
            for (const accountId of ['personal', 'work']) await vi.waitFor(() => expect(screen.findHostByTestId(
                `connected-services-account:${service.pluginId}/${service.localId}:${accountId}`), screen.getTextContent()).not.toBeNull());
            expect(authenticationCommands).toEqual([]);
        } finally { await screen.unmount(); }
    });

    it('opens the Connect sheet for the exact overview account that needs to sign in again', async () => {
        await seedServicesOverview();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedServicesSettingsView /></InjectedAuthProvider>);
        try {
            const signIn = `connected-services-account:${service.pluginId}/${service.localId}:personal:sign-in-again`;
            await vi.waitFor(() => expect(screen.findHostByTestId(signIn), screen.getTextContent()).not.toBeNull());
            vi.mocked(Modal.show).mockClear();
            await screen.pressByTestIdAsync(signIn);
            // OWNER-RULINGS 2026-10-31: Sign in again opens the one in-place Connect sheet.
            expect(Modal.show).toHaveBeenCalledOnce();
            expect(vi.mocked(Modal.show).mock.calls[0]?.[0]).toMatchObject({ props: { request: {
                intent: 'reconnect', service, account: { service, accountId: 'personal' },
            } } });
            expect(platform.navigate).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it('uses an admitted native description without an Account artifact as native-only mode proof', async () => {
        const [{ captureLazyActionAccountContext }, { createUiConnectedAccountAuthenticationHost }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/sync/ops/connectedAccounts/connectedAccountAuthenticationHost'),
        ]);
        const captured = await captureLazyActionAccountContext(account.home.id);
        try {
            const result = await createUiConnectedAccountAuthenticationHost(captured)
                .describeService(service, selection.selectedTarget!.machineId);
            expect(result.description).toMatchObject({ status: 'described', service });
            if (result.description?.status !== 'described') throw new Error('Expected the real native description');
            expect(result.description.descriptor.authentication.account).toBeUndefined();
            expect(result.accountAuthenticationModes).toEqual({ status: 'available', modeIds: [] });
            expect(controlCommands.filter(command => command.operation === 'describeService')).toHaveLength(1);
        } finally { captured.dispose(); }
    });

    it('does not revive passive methods without native proof after the canonical declaration owner refuses conflicting suppliers', async () => {
        const { advanceConnectedAccountDescriptorProjectionState, createConnectedAccountDescriptorProjectionLoadingState,
            mergeConnectedAccountDescriptorProjections } = await import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection');
        const descriptor = getConnectedServiceRegistrySnapshot().entries.find(entry =>
            entry.service?.pluginId === service.pluginId && entry.service.localId === service.localId)?.projectedDescriptor;
        if (!descriptor) throw new Error('Expected the actual projected fixture descriptor');
        const candidate = { ...descriptor, authentication: { ...authentication, modes: [...authentication.modes,
            { id: 'device', kind: 'oauthDeviceCode' as const, outcomeReconciliation: 'none' as const }] } };
        const merged = mergeConnectedAccountDescriptorProjections([
            { kind: 'ready', descriptors: [candidate] },
            { kind: 'ready', descriptors: [{ ...candidate, title: 'Different supplier' }] },
        ]);
        expect(merged.kind).toBe('conflict');
        installConnectedAccountDescriptorProjection(advanceConnectedAccountDescriptorProjectionState(
            createConnectedAccountDescriptorProjectionLoadingState(getActiveServerSnapshot().serverId), merged),
            captureActiveServerAccountScopeLifetime());
        const screen = await renderScreen(element({ ...selection, selectedTarget: null,
            resolveExecutionTarget: () => null }, service, null));
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
            expect(screen.findHostByTestId('connected-service-setup:method:manual')).toBeNull();
            expect(screen.findHostByTestId('connected-service-setup:method:device')).toBeNull();
            expect(controlCommands).toEqual([]);
            expect(authenticationCommands).toEqual([]);
        } finally { await screen.unmount(); }
    });

    it('keeps an undeclared service load and Retry Account-scoped until an explicit method is available', async () => {
        const requestedService = { pluginId: 'external.unanswered', localId: 'mail' };
        const registry = { ...getConnectedServiceRegistrySnapshot(), status: 'error' as const, entries: [],
            errorReason: 'transport' as const };
        handleControl = () => ({ status: 'unavailable', code: 'connected_account_service_unavailable' });
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
            <ConnectedAccountSetupController service={requestedService}
                targetSelection={selection} registry={registry} panel={{ intent: { kind: 'add' }, onConnected, onCancel }} />
        </InjectedAuthProvider>);
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
            expect(controlCommands).toEqual([]);
            expect(screen.findHostByTestId('connected-service-setup:preparing')).toBeNull();
            expect(screen.findHostByTestId('connected-service-setup:unknown-service')).toBeNull();
            expect(authenticationCommands).toEqual([]);
            await screen.pressByTestIdAsync('connected-account:error:retry');
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')?.props.disabled).toBe(false));
            expect(controlCommands).toEqual([]);
            expect(authenticationCommands).toEqual([]);
            expect(onConnected).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it.each(['response', 'transport', 'unrecognized'] as const)('preserves a typed setup load refusal from %s on initial load and Retry', async failureSource => {
        handleControl = () => {
            if (failureSource === 'transport') throw new RpcError('private transport diagnostics', 'connected_account_service_unavailable');
            if (failureSource === 'unrecognized') throw new RpcError('private transport diagnostics', 'plugin_setup_unavailable');
            return { status: 'unavailable', code: 'connected_account_service_unavailable' };
        };
        const expectedMessage = failureSource === 'unrecognized'
            ? t('connectedServices.errors.signInLoadFailed', { service: 'Acme Work' })
            : t('connectedServices.errors.accountServiceUnavailable');
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
            expect(JSON.stringify(screen.tree.toJSON())).toContain(expectedMessage);
            expect(JSON.stringify(screen.tree.toJSON())).not.toContain('private transport diagnostics');
            await screen.pressByTestIdAsync('connected-account:error:retry');
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')?.props.disabled).toBe(false));
            expect(JSON.stringify(screen.tree.toJSON())).toContain(expectedMessage);
            expect(authenticationCommands).toEqual([]);
            expect(onConnected).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it.each(['response', 'transport', 'unrecognized'] as const)('preserves the typed beginConnect refusal from %s when the manual draft is submitted', async failureSource => {
        handleAuthentication = () => {
            if (failureSource !== 'response') throw new RpcError('private authentication transport diagnostics',
                failureSource === 'transport' ? 'connected_account_v4_contract_violation' : 'plugin_setup_unavailable');
            return { status: 'unavailable', code: 'plugin_setup_unavailable' };
        };
        const expectedMessage = failureSource === 'unrecognized'
            ? t('connectedServices.errors.signInLoadFailed', { service: 'Acme Work' })
            : t(failureSource === 'transport'
                ? 'connectedServices.errors.accountOperationUnsupported' : 'connectedServices.errors.accountServiceUnavailable');
        const screen = await renderScreen(element());
        try {
            // 58c-u1: choosing a manual method prepares its draft; submitting it admits native work.
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
            expect(authenticationCommands).toEqual([]);
            await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'secret-token'));
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
            expect(authenticationCommands).toContainEqual({ operation: 'beginConnect', service, modeId: 'manual' });
            expect(JSON.stringify(screen.tree.toJSON())).toContain(expectedMessage);
            expect(JSON.stringify(screen.tree.toJSON())).not.toContain('private authentication transport diagnostics');
            expect(onConnected).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it.each(['unavailable', 'outcomeUnknown'] as const)('keeps failure diagnostics collapsed and reveals selectable code and request identity on request for %s', async status => {
        const attemptId = 'attempt-1';
        const code = status === 'unavailable' ? 'connected_account_daemon_unavailable' : 'provider_response_lost';
        handleAuthentication = command => command.operation === 'submitManual'
            ? status === 'outcomeUnknown' ? { status, attemptId, diagnostic: { code } } : { status, attemptId, code }
            : { status: 'awaitingManual', attemptId };
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
            await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'dummy-test-value'));
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
            if (status === 'outcomeUnknown') {
                const { t } = await import('@/text');
                expect(screen.getTextContent()).toContain(t('connectedServices.errors.accountStateUncertain'));
            }
            expect(screen.findByTestId('connected-account:error-details-code')).toBeNull();
            await screen.pressByTestIdAsync('connected-account:error-details-toggle');
            const details = screen.findHostByTestId('connected-account:error-details-code');
            expect(details).not.toBeNull();
            expect(screen.getTextContent()).toContain(code);
            expect(authenticationRequestIds.at(-1)).toEqual(expect.any(String));
            expect(screen.getTextContent()).toContain(authenticationRequestIds.at(-1)!);
            expect(details?.props.selectable).toBe(true);
        } finally { await screen.unmount(); }
    });

    it('retains the Action request identity in typed failure details before an attempt exists', async () => {
        handleAuthentication = () => ({ status: 'unavailable', code: 'connected_account_daemon_response_invalid' });
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
            await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'dummy-test-value'));
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
            expect(authenticationRequestIds.at(-1)).toEqual(expect.any(String));
            expect(screen.findByTestId('connected-account:error-details-code')).toBeNull();
            await screen.pressByTestIdAsync('connected-account:error-details-toggle');
            expect(screen.getTextContent()).toContain('connected_account_daemon_response_invalid');
            expect(screen.getTextContent()).toContain(authenticationRequestIds.at(-1)!);
        } finally { await screen.unmount(); }
    });

    it('retains the description request identity in typed failure details before an attempt exists', async () => {
        handleControl = () => ({ status: 'unavailable', code: 'connected_account_daemon_response_invalid' });
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
            expect(controlRequestIds.at(-1)).toEqual(expect.any(String));
            await screen.pressByTestIdAsync('connected-account:error-details-toggle');
            expect(screen.getTextContent()).toContain('connected_account_daemon_response_invalid');
            expect(screen.getTextContent()).toContain(controlRequestIds.at(-1)!);
            expect(authenticationCommands).toEqual([]);
        } finally { await screen.unmount(); }
    });

    it('retains the pending discovery request identity in typed failure details before an attempt exists', async () => {
        handleControl = command => command.operation === 'listPendingAttempts'
            ? { status: 'unavailable', code: 'connected_account_daemon_response_invalid' }
            : description;
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
            expect(controlRequestIds.at(-1)).toEqual(expect.any(String));
            await screen.pressByTestIdAsync('connected-account:error-details-toggle');
            expect(screen.getTextContent()).toContain('connected_account_daemon_response_invalid');
            expect(screen.getTextContent()).toContain(controlRequestIds.at(-1)!);
            expect(authenticationCommands).toEqual([]);
        } finally { await screen.unmount(); }
    });

    it('explains a native Connect permission refusal and retains its request identity before an attempt exists', async () => {
        let requestId: string | undefined;
        vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async <R, A>(machineId: string, method: string, payload: A,
            options?: Parameters<typeof apiSocket.machineRPC>[3]): Promise<R> => {
            if (method === CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD) {
                requestId = options?.requestId;
                throw new RpcError('private permission diagnostics', RPC_ERROR_CODES.FORBIDDEN);
            }
            return await answerConnectedCommand(machineId, method, payload) as R;
        });
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
            expect(screen.getTextContent()).toContain(t('connectedServices.errors.accountSharedMachineUnavailable'));
            expect(requestId).toEqual(expect.any(String));
            await screen.pressByTestIdAsync('connected-account:error-details-toggle');
            expect(screen.getTextContent()).toContain(requestId!);
            expect(screen.getTextContent()).toContain(RPC_ERROR_CODES.FORBIDDEN);
            expect(screen.getTextContent()).not.toContain('private permission diagnostics');
        } finally { await screen.unmount(); }
    });

    it('retains the connect request identity in transport failure details before an attempt exists', async () => {
        let requestId: string | undefined;
        vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async <R, A>(machineId: string, method: string, payload: A,
            options?: Parameters<typeof apiSocket.machineRPC>[3]): Promise<R> => {
            if (method === CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD) {
                requestId = options?.requestId;
                throw new RpcError('private transport diagnostics', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
            }
            return await answerConnectedCommand(machineId, method, payload) as R;
        });
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
            await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'dummy-test-value'));
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
            expect(requestId).toEqual(expect.any(String));
            await screen.pressByTestIdAsync('connected-account:error-details-toggle');
            expect(screen.getTextContent()).toContain(requestId!);
            expect(screen.getTextContent()).toContain(RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
            expect(screen.getTextContent()).not.toContain('private transport diagnostics');
        } finally { await screen.unmount(); }
    });

    it('reads the exact native Email setup description without waiting for unrelated passive UI sections', async () => {
        const email = { pluginId: 'happier.channel.email', localId: 'email-imap-smtp' };
        const nativeDescription = { ...described, service: email,
            descriptor: { ...described.descriptor, id: email.localId } };
        // The loaded target already answers its native descriptor; the passive
        // UI registry is still establishing unrelated renderer sections.
        const pending = deferredReply();
        handleControl = command => command.operation === 'describeService' ? pending.promise
            : { status: 'pendingAttempts', attempts: [] };
        const registry = { ...getConnectedServiceRegistrySnapshot(), status: 'loading' as const, entries: [] };
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
            <ConnectedAccountSetupController service={email} targetSelection={selection} registry={registry}
                panel={{ intent: { kind: 'add' }, modeId: 'manual', onConnected, onCancel }} />
        </InjectedAuthProvider>);
        try {
            await vi.waitFor(() => expect(controlCommands).toContainEqual({
                operation: 'describeService', service: email, requiredOperation: 'account_list',
            }));
            expect(authenticationCommands).toEqual([]);
            await act(async () => { pending.resolve(nativeDescription); });
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
            expect(authenticationCommands).toEqual([]);
            expect(screen.findHostByTestId('connected-service-setup:preparing')).toBeNull();
            expect(onConnected).not.toHaveBeenCalled();
        } finally { pending.resolve(nativeDescription); await screen.unmount(); }
    });

    it('P8 capability checklist · service Add account opens one in-place Connect sheet', async () => {
        await seedConnectedServicesPage();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedServicesSettingsView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-index.view:grid')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-services-index.view:grid');
        const add = `connected-services-service:${service.pluginId}/${service.localId}:add-account`;
        await vi.waitFor(() => expect(screen.findHostByTestId(add), screen.getTextContent()).not.toBeNull());
        vi.mocked(Modal.show).mockClear();
        await screen.pressByTestIdAsync(add);
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledOnce());
        expect(vi.mocked(Modal.show).mock.calls[0]?.[0]).toMatchObject({ props: { request: { service, intent: 'add' } } });
        expect(platform.navigate).not.toHaveBeenCalled();
        expect(authenticationCommands.filter(command => command.operation === 'beginConnect')).toEqual([]);
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
        await screen.unmount();
    });

    it.each(['collection view round-trip', 'saved account without a Machine'] as const)(
        'P8 capability preservation checklist · %s', async capability => {
            await seedConnectedServicesPage();
            if (capability === 'saved account without a Machine') {
                machineRows = [];
                storage.getState().applyMachines([], true, { sourceServerId: getActiveServerSnapshot().serverId });
                storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: {} });
            }
            const page = <InjectedAuthProvider credentials={account.credentials}><ConnectedServicesSettingsView /></InjectedAuthProvider>;
            let screen = await renderScreen(page);
            if (capability === 'collection view round-trip') {
                await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-index.view:grid')).not.toBeNull());
                await screen.pressByTestIdAsync('connected-services-index.view:grid');
                await vi.waitFor(() => expect(storage.getState().localSettings.connectedServicesIndexViewV1).toBe('grid'));
                await screen.unmount();
                screen = await renderScreen(page);
                await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-index.view:grid')?.props.accessibilityState?.selected).toBe(true));
                await screen.pressByTestIdAsync('connected-services-index.view:list');
                await vi.waitFor(() => expect(storage.getState().localSettings.connectedServicesIndexViewV1).toBe('list'));
            } else {
                const row = `connected-services-account:${service.pluginId}/${service.localId}:existing`;
                await vi.waitFor(() => expect(screen.findHostByTestId(row), screen.getTextContent()).not.toBeNull());
                await screen.pressByTestIdAsync(row);
                expect(platform.navigate).toHaveBeenCalledWith(buildConnectedAccountSettingsRoute(service, { kind: 'account', accountId: 'existing' }));
            }
            expect(authenticationCommands).toEqual([]);
            await screen.unmount();
        },
    );

    it('retains the real Connect sheet sign-in lifetime and draft while the collection page is hidden', async () => {
        const native = await import('react-native');
        vi.spyOn(native, 'useWindowDimensions').mockReturnValue({ width: 1440, height: 900, scale: 1, fontScale: 1 });
        await seedConnectedServicesPage();
        const content = <InjectedAuthProvider credentials={account.credentials}><ModalProvider><ConnectedServicesSettingsView /></ModalProvider></InjectedAuthProvider>;
        const page = (visible: boolean) => <PluginSurfaceFocusEligibilityProvider active={visible} presentationActive={visible}>
            {content}
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(page(true));
        const browse = 'connected-services-connect-more:browse.action';
        await vi.waitFor(() => expect(screen.findHostByTestId(browse), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync(browse);
        await screen.pressByTestIdAsync('connected-service-setup:group:plugins');
        const connect = `connected-service-setup:connect:${service.pluginId}/${service.localId}`;
        await vi.waitFor(() => expect(screen.findHostByTestId(connect), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync(connect);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'retained-inline-draft'));
        const began = authenticationCommands.filter(command => command.operation === 'beginConnect').length;
        expect(began).toBe(0);
        await screen.update(page(false));
        await act(async () => { storage.getState().applyProfile({ ...storage.getState().profile, firstName: 'Unrelated arrival' }); });
        await screen.update(page(true));
        expect(screen.findHostByTestId('connected-account-manual:token')?.props.value).toBe('retained-inline-draft');
        expect(authenticationCommands.filter(command => command.operation === 'cancel')).toEqual([]);
        handleAuthentication = command => command.operation === 'submitManual'
            ? { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'new-inline-account' } }
            : { status: 'awaitingManual', attemptId: 'attempt-1' };
        await installNativeConfigurationAttemptBoundary();
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull());
        expect(authenticationCommands).toContainEqual({ operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'retained-inline-draft' } });
        expect(authenticationCommands.filter(command => command.operation === 'beginConnect')).toHaveLength(began + 1);
        await screen.unmount();
    });

    it.each(['queued native attempt', 'Account-direct save'] as const)('submits manual Saved Secret references through the real Action and %s', async path => {
        const { SavedSecretCatalogEntryV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
        const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
        const ref = formatSharedSavedSecretRefV1('manual-key');
        const entry = SavedSecretCatalogEntryV1Schema.parse({
            ref, source: 'shared_resource', relationship: 'owner', name: 'Build service key', kind: 'apiKey',
            encryptionMode: 'plain', ownerAccountId: 'account-a', revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
            audience: { accounts: [], teams: [], groups: [] },
        });
        let materialReads = 0;
        let saved: ReturnType<typeof QualifiedConnectedAccountCredentialMutationV4Schema.parse> | undefined;
        const previousHttp = handleHttp;
        handleHttp = async (url, init) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v1/account/saved-secrets/resources') return Response.json({ resources: [entry] });
            if (pathname === '/v1/account/saved-secrets/resources/materials') {
                materialReads += 1;
                return new Response('{}', { status: 503 });
            }
            if (pathname === '/v4/connect/qualified/credential' && init?.method === 'POST') {
                saved = QualifiedConnectedAccountCredentialMutationV4Schema.parse(JSON.parse(String(init.body)));
                return Response.json({ success: true, credentialRevision, configurationRevision: null });
            }
            return previousHttp(url, init);
        };
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected active Account lifetime');
        await refreshSavedSecretCatalog(lifetime.scope, { includeMaterial: false });
        if (path === 'Account-direct save') {
            installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
                defaultModeId: 'manual', modes: [{ ...authentication.modes[0], accountDirectSave: true }],
            } } });
            const features = createRootLayoutFeaturesResponse({ features: { connectedServices: { enabled: true } },
                capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } } });
            primeServerFeaturesSnapshot({ serverId: account.home.id, snapshot: { status: 'ready', features } });
        } else {
            handleAuthentication = command => command.operation === 'submitManual'
                ? { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'saved-secret-account' } }
                : { status: 'awaitingManual', attemptId: 'attempt-1' };
            await installNativeConfigurationAttemptBoundary();
        }
        const machineDemand = vi.fn();
        const screen = await renderScreen(<ModalProvider><InjectedAuthProvider credentials={null}>
            <ConnectedAccountSetupController service={service} targetSelection={selection}
                panel={{ intent: { kind: 'add' }, modeId: 'manual', onConnected, onCancel,
                    onMachineRequirementChange: machineDemand }} />
        </InjectedAuthProvider></ModalProvider>);
        if (path === 'queued native attempt') {
            await vi.waitFor(() => expect(machineDemand.mock.lastCall?.[0]).toBe(true));
        }
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findAllByTestId('connected-account-manual:token:choose')
            .find(node => typeof node.props.title === 'string')?.props.disabled, screen.getTextContent()).toBe(false));
        await screen.pressByTestIdAsync('connected-account-manual:token:choose');
        await vi.waitFor(() => expect(screen.findAllByTestId(`saved-secret:${ref}`)
            .find(node => typeof node.props.title === 'string')?.props.disabled, screen.getTextContent()).toBe(false));
        await screen.pressByTestIdAsync(`saved-secret:${ref}`);
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        if (path === 'Account-direct save') {
            await vi.waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
            expect(saved?.savedSecretResourceIds).toEqual(['manual-key']);
            expect(saved?.savedSecretRevisions).toEqual([{ resourceId: 'manual-key', expectedRevision: 1 }]);
            if (!saved || saved.content.t !== 'plain') throw new Error('Expected reference-only plain credential');
            expect(parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: saved.ref,
                authenticationModeId: saved.authenticationModeId, plaintext: saved.content.v }))
                .toEqual({ v: 1, values: {}, secretRefs: { token: ref } });
            expect(authenticationCommands).toEqual([]);
            expect(httpRequests.some(request => request.pathname.endsWith('/promote'))).toBe(false);
        } else {
            await vi.waitFor(() => expect(authenticationCommands).toContainEqual({
                operation: 'submitManual', attemptId: 'attempt-1', fields: {},
                selectedSecrets: { token: { ref, resourceRevision: 1 } },
            }));
        }
        expect(materialReads).toBe(0);
    });

    it('does not rerender Account detail for an unrelated Profile publication', async () => {
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null,
        });
        installDescription({ ...described, accounts: [saved] });
        installAccountLabelBoundary(saved);
        platform.params = { ...description.service, accountId: 'account-1' };
        let commits = 0;
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
            <React.Profiler id="account-detail" onRender={() => { commits += 1; }}><ConnectedAccountServiceView /></React.Profiler>
        </InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull());
        // The saved Profile renders the detail before its description and catalog mount effects settle.
        await flushHookEffects({ cycles: 8, turns: 8 });
        const before = commits;
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(commits - before).toBe(0);
        await act(async () => { storage.getState().applyProfile({ ...storage.getState().profile, firstName: 'Unrelated name' }); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(commits - before).toBe(0);
        await screen.unmount();
    });

    async function focusedScreen(withAccountCredentials = false) {
        platform.params = { ...description.service, accountId: 'account-1' };
        return renderScreen(<InjectedAuthProvider credentials={withAccountCredentials ? account.credentials : null}><ConnectedAccountServiceView /></InjectedAuthProvider>);
    }

    it.each([
        { pluginId: 'happier.machine.digitalocean', localId: 'digitalocean-account' },
        { pluginId: 'happier.machine.hetzner', localId: 'hetzner-account' },
        { pluginId: 'external.cloud', localId: 'account' },
    ])('opens and removes the exact $pluginId account through its canonical custody transport', async savedService => {
        const descriptor = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[`${savedService.pluginId}/${savedService.localId}`]?.descriptor
            ?? { ...described.descriptor, id: savedService.localId };
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service: savedService, accountId: 'account-1' }, status: 'connected',
            authenticationModeId: descriptor.authentication.defaultModeId, revisionSemantics: 'revisioned', credentialRevision,
            configurationReady: true, configurationRevision: null, scopes: [],
        });
        // The purpose-scoped controller has described the account; the passive
        // AppShell registry has no Machine descriptor for this service.
        description = { ...described, service: savedService, descriptor, accounts: [saved] };
        installAccountLabelBoundary(saved);
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'connectedServices.accounts.revoke': ['ui'] } });
        await seedPurposeDefaults({ kind: 'account', account: saved.ref }, actionsSettingsV1);
        installConnectedAccountDescriptorProjection({ scopeKey: getActiveServerSnapshot().serverId,
            status: 'ready', descriptors: [], conflicts: [], errorReason: null }, captureActiveServerAccountScopeLifetime());
        const removals: unknown[] = [];
        handleControl = command => {
            if (command.operation === 'revokeAccount') {
                removals.push({ account: command.account, expectedCredentialRevision: command.expectedCredentialRevision,
                    cleanupGroupReferences: command.cleanupGroupReferences });
                return { status: 'revoked', account: saved.ref, remoteStatus: 'remoteUnsupported' };
            }
            return command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] } : description;
        };
        const previousHttp = handleHttp;
        handleHttp = async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v4/connect/qualified/credential' && init?.method === 'DELETE') {
                removals.push({ account: parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema,
                    url.searchParams.get('ref')!), expectedCredentialRevision: url.searchParams.get('expectedCredentialRevision'),
                    cleanupGroupReferences: url.searchParams.get('cleanupGroupReferences') === 'true' });
                return Response.json({ success: true });
            }
            return previousHttp(input, init);
        };
        await transferPurposeDefaults();
        const screen = await focusedScreen(true);
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:disconnect'),
            screen.getTextContent()).not.toBeNull());
        expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull();
        expect(controlCommands.filter(command => command.operation === 'describeService')).toContainEqual({
            operation: 'describeService', service: savedService, requiredOperation: 'account_list',
        });
        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        await vi.waitFor(() => expect(removals).toEqual([{
            account: saved.ref, expectedCredentialRevision: credentialRevision,
            cleanupGroupReferences: false,
        }]));
        await vi.waitFor(() => expect(platform.replace, JSON.stringify({ rendered: screen.getTextContent(),
            commands: controlCommands, paths: httpRequests.map(url => url.pathname),
            bindings: purposeBoundary!.readBindings() })).toHaveBeenCalledWith(buildConnectedAccountSettingsRoute(savedService)));
        expect(authenticationCommands).toEqual([]);
        await screen.unmount();
    });

    function leaveMachineChoiceUnselected() {
        // A sole online candidate is selected by the real administration owner.
        // Two current candidates model an Account whose user has made no choice.
        const other = createMachineFixture({ id: 'machine-other', activeAt: Date.now() });
        machineRows.push(createPlainMachineRowFixture({ id: other.id, accountId: 'account-a' }));
        storage.getState().applyMachines([...Object.values(storage.getState().machines), other], true,
            { sourceServerId: getActiveServerSnapshot().serverId });
        storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: {} });
    }

    function waiveConfigurationConfirmation() {
        // These cases exercise native configuration settlement/recovery. The
        // real policy owner must admit their effect; no caller bypass is used.
        storage.getState().applySettings({ ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'connectedServices.configuration.replace': ['ui'] } }),
        }, 2);
    }

    function installApprovalBoundary() {
        const approvals: ApprovalRequestV2[] = [];
        handleHttp = async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/artifacts' && init?.method === 'POST') {
                // The real executor and Artifact owner produce the request; HTTP is the boundary.
                const create = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                const content = decodePlainArtifactStoredContent(create.body);
                if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Missing approval Artifact body');
                const request = StoredApprovalRequestSchema.parse(JSON.parse(content.body));
                if (request.v !== 2) throw new Error('Missing current approval authority');
                approvals.push(request);
                return Response.json({ ...create, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            }
            if (url.pathname === '/v1/artifacts') return Response.json([]);
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        return approvals;
    }

    function installAccountLabelBoundary(targetAccount: QualifiedConnectedAccountProfileV4, beforeWrite?: () => Promise<void>) {
        let savedProfile = { ...profileDefaults, id: 'account-a', connectedAccountsV4: [targetAccount] };
        storage.getState().applyProfile(savedProfile);
        let presentation: ConnectedPresentationRecordV1 = { v: 1, entries: [] };
        let revision = 1;
        let writeSignal: AbortSignal | null | undefined;
        handleHttp = async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/profile') return Response.json(savedProfile);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = ConnectedPresentationRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(mutation.expectedRevision).toBe(revision);
                    if (mutation.content?.t !== 'plain') throw new Error('Expected plain Account label');
                    writeSignal = init.signal;
                    await beforeWrite?.();
                    presentation = mutation.content.v;
                    return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
                }
                return Response.json({ status: 'present', revision, content: { t: 'plain', v: presentation } });
            }
            if (path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json({
                status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } },
            });
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        return { readPresentation: () => presentation, readWriteSignal: () => writeSignal,
            publishAccount: (account: QualifiedConnectedAccountProfileV4) => {
                savedProfile = { ...savedProfile, connectedAccountsV4: [account] };
                storage.getState().applyProfile(savedProfile);
            } };
    }

    function installPurposeBoundary(bindings: Extract<ConnectedAccountCatalogRecordV1, { key: 'purposes' }>['value']['bindings'],
        actionsSettingsV1: ReturnType<typeof ActionsSettingsV1Schema.parse>) {
        let record: Extract<ConnectedAccountCatalogRecordV1, { key: 'purposes' }> | null = null;
        let revision = 0;
        let settingsVersion = 3;
        let raw: Readonly<Record<string, unknown>> | null = null;
        const rowWrites: Array<Extract<ConnectedAccountCatalogRecordV1, { key: 'purposes' }>> = [];
        // The Home stores Settings sparsely: only what the person set. A full defaults document would make the
        // Sync engine's storage normalization rewrite it (a Settings POST) between the source read and the row write.
        const source = () => raw ??= { actionsSettingsV1, connectedAccountPurposeBindingsV1: { v: 1, bindings } };
        return {
            readBindings: () => record?.value.bindings,
            readSource: source,
            rowWrites,
            request(path: string, init?: RequestInit): Response | null {
                if (path === '/v2/account/settings') {
                    if (init?.method === 'POST') {
                        const mutation = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                        expect(mutation.expectedVersion).toBe(settingsVersion);
                        if (mutation.content?.t !== 'plain') throw new Error('Expected plain predecessor Settings');
                        raw = mutation.content.v;
                        return Response.json({ success: true, version: ++settingsVersion });
                    }
                    return Response.json({ content: { t: 'plain', v: source() }, version: settingsVersion });
                }
                if (path !== `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return null;
                if (init?.method !== 'POST') return Response.json(record
                    ? { status: 'present', revision, content: { t: 'plain', v: record } } : { status: 'absent' });
                const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                expect(mutation.expectedRevision).toBe(record ? revision : 'absent');
                if (mutation.sourceSettingsVersion !== undefined) expect(mutation.sourceSettingsVersion).toBe(settingsVersion);
                if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'purposes') throw new Error('Expected plain purposes row');
                record = mutation.content.v;
                rowWrites.push(record);
                if (mutation.settingsMutation) {
                    expect(mutation.settingsMutation.expectedSettingsVersion).toBe(settingsVersion);
                    if (mutation.settingsMutation.content?.t !== 'plain') throw new Error('Expected plain Settings retirement');
                    raw = mutation.settingsMutation.content.v;
                    settingsVersion += 1;
                }
                return Response.json({ status: 'updated', revision: ++revision, cursor: revision,
                    ...(mutation.settingsMutation ? { settingsVersion } : {}) });
            },
        };
    }

    async function seedPurposeDefaults(target: QualifiedConnectedAccountPurposeBindingTargetV1,
        actionsSettingsV1 = storage.getState().settings.actionsSettingsV1) {
        const bindings = [
            { purpose: { consumer: { pluginId: 'custom.agent', localId: 'one' }, purpose: 'model' }, target },
            { purpose: { consumer: { pluginId: 'custom.agent', localId: 'two' }, purpose: 'model' }, target },
            { purpose: { consumer: { pluginId: 'custom.agent', localId: 'other' }, purpose: 'model' },
                target: { kind: 'account' as const, account: { service, accountId: 'account-2' } } },
        ];
        const predecessorSettings = { ...storage.getState().settings,
            actionsSettingsV1,
            connectedAccountPurposeBindingsV1: { v: 1, bindings },
        };
        storage.getState().applySettings(predecessorSettings, 2);
        purposeBoundary = installPurposeBoundary(bindings, actionsSettingsV1);
        return bindings;
    }

    async function transferPurposeDefaults() {
        const result = await readConnectedAccountCatalog({ serverId: account.home.id, accountId: 'account-a' }, 'purposes');
        expect(result, JSON.stringify({ result, requests: httpRequests.map(url => url.pathname) })).toMatchObject({ status: 'ready' });
        expect(purposeBoundary!.readSource()).not.toHaveProperty('connectedAccountPurposeBindingsV1');
    }

    beforeEach(async () => {
        await loadSyncSingletonForTests();
        // IndexedDB is the genuine browser persistence boundary; domain record owners remain real.
        vi.stubGlobal('indexedDB', indexedDB);
        vi.stubGlobal('IDBKeyRange', IDBKeyRange);
        onConnected.mockClear();
        onCancel.mockClear();
        platform.params = {};
        platform.navigate.mockClear();
        platform.replace.mockClear();
        platform.dismissTo.mockClear();
        platform.confirm.mockReset().mockResolvedValue(true);
        vi.mocked(Modal.confirm).mockImplementation(platform.confirm);
        authenticationCommands.length = 0;
        authenticationRequestIds.length = 0;
        controlRequestIds.length = 0;
        controlCommands.length = 0;
        httpRequests.length = 0;
        machineRequestStacks.length = 0;
        purposeBoundary = null;
        machineRows = [createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' })];
        handleMachineRead = undefined;
        handleMachineReadId = 'machine-1';
        handleHttp = async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            // Cold restoration captures the real encryption observation before
            // a case installs its domain routes. Seed the plain Account then,
            // rather than retaining a 404 observation for the whole journey.
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/connect/connected-account-attempt-transactions/pending') return Response.json({ attempts: [] });
            return new Response('{}', { status: 404 });
        };
        handleAuthentication = (command) => command.operation === 'submitManual'
            ? { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'new-account' } }
            : command.operation === 'cancel'
                ? { status: 'cancelled', attemptId: command.attemptId }
                : { status: 'awaitingManual', attemptId: 'attempt-1' };
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : description;
        // Captured Account authentication uses the exact scoped socket, while diagnostic
        // controls may use the active socket. Both are genuine transport boundaries.
        installDisconnectedServerSocketBoundary(socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'timeout').mockReturnValue(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, payload: SocketRpcRequestPayload) => {
                if (payload.method.endsWith(`:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`) && payload.requestId) {
                    authenticationRequestIds.push(payload.requestId);
                }
                if (payload.method.endsWith(`:${CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD}`) && payload.requestId) {
                    controlRequestIds.push(payload.requestId);
                }
                const separator = payload.method.indexOf(':');
                if (separator < 0) throw new Error('Expected exact machine RPC address');
                return { ok: true, result: await answerConnectedCommand(payload.method.slice(0, separator),
                    payload.method.slice(separator + 1), payload.params) };
            });
        });
        await adoptHomeProfile({ descriptor: { serverUrl: 'https://connected-account-setup.example.test',
            homeServerIdentityId: 'srv_connected_account_setup' }, source: 'manual' });
        account = await restoreServerAccountForTest({
            serverUrl: 'https://connected-account-setup.example.test', accountId: 'account-a',
            request: async (url, init) => {
                const parsed = new URL(String(url));
                httpRequests.push(parsed);
                if (parsed.pathname.startsWith('/v1/machines')) {
                    const stackLimit = Error.stackTraceLimit;
                    Error.stackTraceLimit = 35;
                    machineRequestStacks.push(new Error('Machine HTTP origin').stack ?? 'unavailable');
                    Error.stackTraceLimit = stackLimit;
                }
                if (parsed.pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
                    const demand = MachineReadBatchRequestV1Schema.parse(typeof init.body === 'string' ? JSON.parse(init.body) : init.body);
                    if (handleMachineRead && demand.machineIds.includes(handleMachineReadId)) {
                        // This exact HTTP oracle owns the delayed read and whole-request refusals.
                        const response = await handleMachineRead();
                        if (!response.ok && response.status !== 404) return response;
                        const body: unknown = response.status === 404 ? null : await response.json();
                        const machine = body && typeof body === 'object' && 'machine' in body ? body.machine : null;
                        return createMachineReadBatchResponseFixture(demand, id => id === handleMachineReadId
                            ? machine : machineRows.find(row => row.id === id) ?? null);
                    }
                    return createMachineReadBatchResponseFixture(demand, id => machineRows.find(row => row.id === id) ?? null);
                }
                if (parsed.pathname === `/v1/machines/${handleMachineReadId}` && handleMachineRead) return handleMachineRead();
                if (parsed.pathname === '/v1/machines/machine-1') {
                    if (handleMachineRead) return handleMachineRead();
                    return machineRows[0] ? Response.json({ machine: machineRows[0] }) : new Response('{}', { status: 404 });
                }
                if (parsed.pathname === '/v1/machines') return Response.json(parsed.searchParams.get('includeRevoked') === 'true' ? machineRows : { machines: machineRows });
                const response = purposeBoundary?.request(parsed.pathname, init) ?? await handleHttp(url, init);
                if (parsed.pathname.startsWith('/v4/connect/qualified/group') && init?.method && init.method !== 'GET' && response?.ok) {
                    await publishServedPoolGroups();
                }
                if (parsed.pathname === '/v2/account/settings' && (!init?.method || init.method === 'GET') && response?.status === 404) {
                    return Response.json({ content: null, version: 0 });
                }
                return response;
            },
        });
        // The real cold bootstrap pins Settings before admitting peripheral
        // inventory. Serve and settle that boundary before seeding each draft.
        await (await import('@/sync/sync')).sync.awaitBootstrapForegroundAcquisition();
        const active = getActiveServerSnapshot();
        storage.getState().activateProfileScope({ serverId: active.serverId, accountId: 'account-a' });
        await storage.getState().activateSettingsScope({ serverId: active.serverId, accountId: 'account-a' });
        expect(getActiveServerAccountScope()).toEqual({ serverId: active.serverId, accountId: 'account-a' });
        const machine = createMachineFixture({ activeAt: Date.now() });
        expect(account.home.serverIdentityId).toBe('srv_connected_account_setup');
        const target = { serverIdentityId: account.home.serverIdentityId!, machineId: machine.id };
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a' });
        // Seed a fresh Account snapshot; the versioned echo writer correctly
        // refuses version 1 after a preceding case persisted a later revision.
        storage.setState({ settings: { ...settingsDefaults,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: target },
        }, settingsVersion: 1 });
        storage.getState().applyMachines([machine], true, { sourceServerId: active.serverId });
        storage.setState({ isDataReady: true });
        const candidate = {
            target, displayName: 'Setup machine', serverLabel: 'Home', availability: 'online' as const,
            observation: 'live' as const, observedAt: Date.now(),
        };
        // The panel supplies its selected machine through this public prop; no selection owner is mocked.
        selection = {
            candidates: [candidate], pickerRows: [], state: { kind: 'online', target, machine: candidate },
            selectedTarget: target, selectedTargetServerMatchesActiveAccount: true, canExecute: true,
            selectTarget: () => {}, clearTarget: () => {},
            resolveExecutionTarget: () => ({ kind: 'resolved', target, profile: account.home, serverId: active.serverId, machine }),
        };
        installDescription(described);
        // Only the socket-facing machine RPC adapter is replaced. The controller, scoped routing,
        // Account currentness, command normalization, and strict request/response schemas stay real.
        vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async <R, A>(
            machineId: string, method: string, payload: A,
            options?: Parameters<typeof apiSocket.machineRPC>[3],
        ): Promise<R> => {
            if (options?.requestId && method === CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD) {
                authenticationRequestIds.push(options.requestId);
            }
            if (options?.requestId && method === CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD) {
                controlRequestIds.push(options.requestId);
            }
            options?.onIssued?.();
            // RPC bytes are unknown at this genuine transport boundary; the real caller parses them.
            return await answerConnectedCommand(machineId, method, payload) as R;
        });
    });

    afterEach(async () => {
        const [{ serverScopedRpcSocketPool }, { resetScopedMachineTransportCacheForTests }] = await Promise.all([
            import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool'),
            import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool'),
        ]);
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        installDisconnectedServerSocketBoundary();
        await act(async () => { Modal.hideAll(); });
        standardCleanup();
        resetServerFeaturesClientForTests();
        const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
        await getInstalledPluginUiClientExecutableComposition().unload();
        vi.restoreAllMocks();
        await account?.dispose();
        vi.unstubAllGlobals();
        storage.getState().clearProfileScope();
    });

    it('admits pending authentication through the captured portable Home front door', async () => {
        const machineId = selection.selectedTarget?.machineId;
        if (!machineId) throw new Error('missing_selected_machine');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('missing_account_scope');
        expect(await createDefaultActionExecutor().execute('connectedServices.authentication.pending.list', { machineId, service },
            { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId }))
            .toEqual({ ok: true, result: { status: 'pendingAttempts', attempts: [] } });
        let execution: ReturnType<typeof useMountedActionExecution> | undefined;
        function Probe() { execution = useMountedActionExecution(scope); return null; }
        const screen = await renderScreen(<Probe />);
        try {
            await vi.waitFor(() => expect(execution?.ready, JSON.stringify({
                capturedScope: scope,
                credentialScope: execution?.binding?.scope,
                current: execution?.binding?.isCurrent(),
            })).toBe(true));
            expect(await execution!.execute('connectedServices.authentication.pending.list', { machineId, service }))
                .toEqual({ ok: true, result: { status: 'pendingAttempts', attempts: [] } });
        } finally { await screen.unmount(); }
    });
    it.each([false, true])('shows the single manual draft immediately and waits for its submit before beginning native authentication (configuration %s)', async configurationRequired => {
        const draftService = service;
        const manualMode = { ...authentication.modes[0]!,
            setup: { url: 'https://provider.example/keys', checklist: ['Create a key'] },
            ...(configurationRequired ? { configuration: configuredMode.configuration } : {}) };
        const manualTarget = { ...configurationTarget, service: draftService, modeId: manualMode.id };
        installDescription({ ...described, service: draftService, descriptor: { ...described.descriptor,
            authentication: { ...authentication, modes: [manualMode] } } });
        if (configurationRequired) {
            waiveConfigurationConfirmation();
            const previousControl = handleControl;
            const reply = { ...configurationReply, mode: manualMode, target: manualTarget };
            handleControl = command => command.operation === 'readConfiguration' ? reply
                : command.operation === 'replaceConfiguration' ? { ...reply, status: 'configurationCommitted',
                    configuration: { ...reply.configuration, status: 'ready', revision: 'config-2' } }
                    : previousControl(command);
        }
        const [{ captureLazyActionAccountContext }, { createNativeAttemptAddressBoundary, answerAttemptTransaction }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
        ]);
        const captured = await captureLazyActionAccountContext(account.home.id);
        const address = await createNativeAttemptAddressBoundary(captured, selection.selectedTarget!.machineId);
        const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
        const previousHttp = handleHttp;
        const labels = installAccountLabelBoundary(QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service: draftService, accountId: 'new-account' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        }));
        const labelsHttp = handleHttp;
        handleHttp = async (input, init) => {
            const url = new URL(String(input));
            // Native-only service inventory does not install an Account executable.
            if (url.pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return Response.json({ availabilityCursor: 1, snapshots: [], inventoryComplete: true, releases: [] });
            }
            if (url.pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return Response.json({ availabilityCursor: 1, pluginIds: [], failedPluginIds: [], intentReads: [] });
            }
            const transaction = await answerAttemptTransaction(url, init, transactions);
            if (transaction) return transaction;
            const labelResponse = await labelsHttp(input, init);
            return !labelResponse || labelResponse.status === 404 ? previousHttp(input, init) : labelResponse;
        };
        const nativeAuthentication = handleAuthentication;
        const attemptCreatedAtMs = Date.now();
        handleAuthentication = async command => {
            const response = ConnectedAccountAttemptResponseSchema.parse(configurationRequired && command.operation === 'beginConnect'
                ? { status: 'configurationRequired', attemptId: 'attempt-1', target: manualTarget, missingFieldIds: [] }
                : configurationRequired && command.operation === 'continueConnect'
                    ? { status: 'awaitingManual', attemptId: 'attempt-1' }
                    : configurationRequired && command.operation === 'submitManual'
                        ? { status: 'connected', attemptId: 'attempt-1', account: { service: draftService, accountId: 'new-account' } }
                    : await nativeAuthentication(command));
            if ((command.operation === 'beginConnect' || command.operation === 'continueConnect')
                && (response.status === 'awaitingManual' || response.status === 'configurationRequired')) {
                if (!response.attemptId) throw new Error('Native fixture must acknowledge its attempt');
                await address.acknowledge({ attemptId: response.attemptId, kind: 'manual', phase: response.status,
                    createdAtMs: attemptCreatedAtMs, intent: 'connect', service: draftService, modeId: manualMode.id });
            } else if (response.status === 'connected' || response.status === 'cancelled') {
                await address.clear(response.attemptId);
            }
            return response;
        };
        let screen: Awaited<ReturnType<typeof manualScreen>> | undefined;
        try {
            const { createUiConnectedAccountAuthenticationHost } = await import('@/sync/ops/connectedAccounts/connectedAccountAuthenticationHost');
            const host = createUiConnectedAccountAuthenticationHost(captured);
            expect(await host.readAccountAuthenticationModes(draftService)).toEqual({ status: 'available', modeIds: [] });
            await (await import('@/sync/sync')).sync.refreshPluginAccountAvailability();
            expect(await host.describeService(draftService)).toEqual({
                description: null, accountAuthenticationModes: { status: 'available', modeIds: [] },
            });
            screen = await renderScreen(element(selection, draftService));
            await vi.waitFor(() => expect(screen!.findHostByTestId('connected-account-manual:token'), screen!.getTextContent()).not.toBeNull());
            expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
            expect(screen.findHostByTestId('connected-account:error:retry'), JSON.stringify({
                rendered: screen.getTextContent(), httpPaths: [...new Set(httpRequests.map(request => request.pathname))],
            })).toBeNull();
            // Discovery and pending-attempt reads do not admit authentication or write configuration.
            expect(controlCommands.every(command => command.operation === 'describeService'
                || command.operation === 'listPendingAttempts')).toBe(true);
            expect(authenticationCommands).toEqual([]);
            const completionDrafts: boolean[] = [];
            onConnected.mockImplementationOnce(() => completionDrafts.push(getActiveUnsavedChangesGuard()?.isDirtyRef.current ?? false));
            await act(async () => screen!.findHostByTestId('connected-account-manual:token')!.props.onChangeText('secret-token'));
            await act(async () => screen!.changeTextByTestId('connected-account-manual:name', 'Build server'));
            if (configurationRequired) {
                await act(async () => screen!.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
            }
            expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            await vi.waitFor(() => expect(onConnected, JSON.stringify({
                rendered: screen!.getTextContent(),
                controls: controlCommands.map(command => command.operation),
                authentication: authenticationCommands.map(command => command.operation),
                confirmations: platform.confirm.mock.calls.length,
            })).toHaveBeenCalledWith({ service: draftService, accountId: 'new-account' }));
            expect(labels.readPresentation().entries).toContainEqual({ v: 1,
                subject: { kind: 'account', account: { service: draftService, accountId: 'new-account' } }, label: 'Build server' });
            if (configurationRequired) expect(controlCommands).toContainEqual(expect.objectContaining({
                operation: 'replaceConfiguration', values: { endpoint: 'https://new.example' },
            }));
            // Completion retires the acknowledged native address; it need not perform another discovery GET.
            expect(transactions.size).toBe(0);
            expect(completionDrafts).toEqual([false]);
            expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
            expect(authenticationCommands.filter(command => command.operation !== 'cancel')).toEqual([
                { operation: 'beginConnect', service: draftService, modeId: 'manual' },
                ...(configurationRequired ? [{ operation: 'continueConnect', attemptId: 'attempt-1', expectedConfigurationRevision: 'config-2' }] : []),
                { operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'secret-token' } },
            ]);
            expect(platform.confirm).not.toHaveBeenCalled();
        } finally { await screen?.unmount(); captured.dispose(); }
    });

    it.each(['oauth', 'device'] as const)('retires the acknowledged %s form before notifying the setup host', async kind => {
        const callbackUrl = 'http://127.0.0.1:4000/auth/callback';
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: kind, modes: [kind === 'device'
                ? { id: kind, kind: 'oauthDeviceCode', outcomeReconciliation: 'providerCheck' }
                : { id: kind, kind: 'oauthAuthorizationCode', callbackUrl, pkce: 'required', outcomeReconciliation: 'none' }] },
        } });
        handleAuthentication = command => command.operation === 'cancel'
            ? { status: 'cancelled', attemptId: 'attempt-1' }
            : command.operation === 'beginConnect'
                ? kind === 'device'
                    ? { status: 'awaitingDeviceAuthorization', attemptId: 'attempt-1', verificationUri: 'https://provider.example/device', userCode: 'SAFE-CODE' }
                    : { status: 'awaitingOAuth', attemptId: 'attempt-1', authorizationUrl: 'https://provider.example/authorize?state=setup-state', callbackUrl }
                : { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'new-account' } };
        const [{ captureLazyActionAccountContext }, { createNativeAttemptAddressBoundary, answerAttemptTransaction },
            { createUiConnectedAccountAttemptTransactionApi }, { createUiConnectedAccountContent }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
            import('@/sync/ops/connectedAccounts/connectedAccountAttemptTransactions'),
            import('@/sync/ops/connectedAccounts/connectedAccountContent'),
        ]);
        const captured = await captureLazyActionAccountContext(account.home.id);
        const address = await createNativeAttemptAddressBoundary(captured, selection.selectedTarget!.machineId);
        const nativeTransactions = createUiConnectedAccountAttemptTransactionApi(captured);
        const nativeContent = createUiConnectedAccountContent(captured);
        const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
        const previousHttp = handleHttp;
        handleHttp = async (input, init) => await answerAttemptTransaction(new URL(String(input)), init, transactions)
            ?? previousHttp(input, init);
        const nativeAuthentication = handleAuthentication;
        handleAuthentication = async command => {
            const response = ConnectedAccountAttemptResponseSchema.parse(await nativeAuthentication(command));
            if (response.status === 'awaitingOAuth' || response.status === 'awaitingDeviceAuthorization') {
                // The fake native RPC host owns its opaque transaction; the manual-address
                // adapter accepts only configuration/manual phases.
                await nativeTransactions.create({ attemptId: response.attemptId, kind,
                    content: await nativeContent.seal('attempt', await nativeContent.resolveAccountMode('fresh-authority'), null),
                    scope: { machineId: selection.selectedTarget!.machineId,
                        phase: response.status, createdAtMs: Date.now(), intent: 'connect', service, modeId: kind } });
            } else if (response.status === 'connected' || response.status === 'cancelled') {
                await address.clear(response.attemptId);
            }
            return response;
        };
        const screen = await renderScreen(element(selection, service, null));
        try {
            const formId = kind === 'device' ? 'connected-account-device:code' : 'connected-account-oauth:callback';
            const completions: { dirty: boolean; formPresent: boolean }[] = [];
            onConnected.mockImplementationOnce(() => completions.push({
                dirty: getActiveUnsavedChangesGuard()?.isDirtyRef.current ?? false,
                formPresent: screen.findHostByTestId(formId) !== null,
            }));
            // The default method's own first step is the sheet: its start action, never a generic Continue
            // that leads to a second press. Nothing starts before that one press (R8-9).
            const startId = kind === 'device' ? 'connected-account-device:start' : 'connected-account-oauth:start';
            await vi.waitFor(() => expect(screen.findHostByTestId(startId)).not.toBeNull());
            expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
            expect(authenticationCommands).toEqual([]);
            await screen.pressByTestIdAsync(startId);
            await vi.waitFor(() => expect(screen.findHostByTestId(formId)).not.toBeNull());
            expect(authenticationCommands.filter(command => command.operation === 'beginConnect')).toHaveLength(1);
            if (kind === 'oauth') {
                await act(async () => screen.changeTextByTestId(formId, `${callbackUrl}?code=accepted-code&state=setup-state`));
                expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
            }
            await screen.pressByTestIdAsync(kind === 'device' ? 'connected-account-device:poll' : 'connected-account-oauth:submit');
            await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'new-account' }));
            expect(completions).toEqual([{ dirty: false, formPresent: false }]);
            await screen.update(element());
            expect(onConnected).toHaveBeenCalledOnce();
            expect(screen.findHostByTestId(formId)).toBeNull();
            expect(transactions.size).toBe(0);
        } finally { await screen.unmount(); captured.dispose(); }
    });

    it.each(['controller', 'setup-panel', 'Gemini mixed panel', 'Gemini mixed sheet', 'Gemini native begin'] as const)('saves an explicitly Account-direct API key through the real %s draft and Action without reading or contacting a Machine', async surface => {
        const gemini = surface.startsWith('Gemini');
        const draftService = gemini ? { pluginId: 'happier.agent.gemini', localId: 'gemini-account' } : service;
        const declaredAuthentication = gemini
            ? BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.gemini/gemini-account']!.descriptor.authentication
            : { defaultModeId: 'manual', modes: [{ ...authentication.modes[0], accountDirectSave: true }] };
        const modes = declaredAuthentication.modes.map(mode => PluginConnectedAccountAuthenticationModeV2Schema.parse(mode));
        const mode = modes.find(mode => mode.id === declaredAuthentication.defaultModeId)!;
        if (gemini) expect(mode).toMatchObject({ accountDirectSave: { fieldKeys: { token: 'apiKey' } } });
        installDescription({ ...described, service: draftService, descriptor: { ...described.descriptor, id: draftService.localId,
            authentication: { defaultModeId: mode.id, modes } } });
        installConnectedAccountDescriptorProjection({ scopeKey: account.home.id, status: 'ready', conflicts: [], errorReason: null,
            descriptors: [{ id: draftService.localId, serviceId: gemini ? 'gemini' : 'acme-work', pluginId: draftService.pluginId, title: gemini ? 'Gemini' : 'Acme Work',
                provenance: gemini ? 'first_party' : 'external', sourceKind: gemini ? 'bundled' : 'installed', authentication: { defaultModeId: mode.id, modes },
                availability: { state: 'available', reason: 'resolved' }, capabilities: [], diagnostics: [] }] }, captureActiveServerAccountScopeLifetime());
        machineRows = [];
        storage.getState().applyMachines([], true, { sourceServerId: account.home.id });
        selection = { ...selection, candidates: [], selectedTarget: null, canExecute: false,
            state: { kind: 'unselected', candidates: [] }, resolveExecutionTarget: () => null };
        let saved: ReturnType<typeof QualifiedConnectedAccountCredentialMutationV4Schema.parse> | undefined;
        let promoted: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse> | undefined;
        const features = createRootLayoutFeaturesResponse({ features: { connectedServices: { enabled: true } },
            capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } } });
        primeServerFeaturesSnapshot({ serverId: account.home.id, snapshot: { status: 'ready', features } });
        handleHttp = async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/saved-secrets/resources/promote' && init?.method === 'POST') {
                promoted = SharedSavedSecretPromoteInputV1Schema.parse(JSON.parse(String(init.body)));
                saved = promoted.connectedAccountCredentialMutation;
                return Response.json({ resourceId: promoted.resourceId, settingsVersion: 1 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        // Cold Account restoration independently starts Sync's include-revoked
        // census. Settle that public owner before measuring this draft's demand.
        await (await import('@/sync/sync')).sync.refreshMachines();
        httpRequests.length = 0;
        machineRequestStacks.length = 0;
        // Count the real inventory projection work; do not replace its selection logic.
        const inventoryReads = vi.spyOn(machineInventoryProjection, 'resolveAllProfileMachineInventorySnapshots');
        const registry = getConnectedServiceRegistrySnapshot();
        const serviceKey = `${draftService.pluginId}/${draftService.localId}`;
        const machineDemand = vi.fn();
        const screen = await renderScreen(surface === 'controller' ? element()
            : <InjectedAuthProvider credentials={account.credentials}>{surface === 'Gemini mixed sheet' ? <ConnectSheetContent onClose={onCancel} request={{ service: draftService, intent: 'add' }}
                onResult={result => { if ('account' in result) onConnected(result.account); }} /> : <ConnectedServiceSetupPanel
                target={{ kind: 'service', serviceKey }} registry={registry}
                catalog={[{ serviceKey, service: draftService, entry: registry.entries.find(entry => entry.service?.pluginId === draftService.pluginId) ?? null,
                    legacyServiceId: null, label: 'Acme Work', usedBy: [], usedByAgentIds: [], connectedCount: 0, section: 'tools', canAdd: true }]}
                targetLocked onMachineRequirementChange={machineDemand}
                onTargetChange={() => {}} onClose={() => {}} onConnected={ref => onConnected(ref)} />}
            </InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        if (surface === 'setup-panel' || surface === 'Gemini mixed panel') expect(machineDemand.mock.lastCall?.[0]).toBe(false);
        // An Account-saved key runs on no Machine, so its draft names none.
        if (surface !== 'controller') expect(screen.findHostByTestId('connected-service-setup-target.chip')).toBeNull();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'account-direct-key'));
        const completionDrafts: boolean[] = [];
        onConnected.mockImplementationOnce(() => completionDrafts.push(getActiveUnsavedChangesGuard()?.isDirtyRef.current ?? false));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(onConnected,
            JSON.stringify({ surface, text: screen.getTextContent(), requests: httpRequests.map(row => row.pathname), saved })).toHaveBeenCalledOnce());
        expect(completionDrafts).toEqual([false]);
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
        expect(saved).toMatchObject({ ref: { service: draftService }, authenticationModeId: mode.id, expectedCredentialRevision: null, content: { t: 'plain' } });
        if (!saved || saved.content.t !== 'plain') throw new Error('Expected saved plain Account credential');
        expect(promoted?.storedContent).toMatchObject({ t: 'plain', v: { value: 'account-direct-key' } });
        expect(saved.savedSecretResourceIds).toEqual([promoted?.resourceId]);
        expect(parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: saved.ref, authenticationModeId: saved.authenticationModeId,
            plaintext: saved.content.v })).toEqual({ v: 1, values: {}, secretRefs: {
                [gemini ? 'apiKey' : 'token']: formatSharedSavedSecretRefV1(promoted!.resourceId),
            } });
        expect(onConnected).toHaveBeenCalledWith(saved.ref);
        expect(authenticationCommands).toEqual([]);
        expect(controlCommands).toEqual([]);
        expect(httpRequests.filter(request => request.pathname.startsWith('/v1/machines')), machineRequestStacks.join('\n')).toEqual([]);
        expect(inventoryReads).not.toHaveBeenCalled();
        if (gemini) {
            const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
            machineRows = [createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine })];
            await act(async () => { await (await import('@/sync/sync')).sync.refreshMachines(); });
            observeMachinePresenceForTest({ serverId: account.home.id, accountId: 'account-a' }, [machine.id]);
            if (surface === 'Gemini native begin') await installNativeConfigurationAttemptBoundary(machine.id);
            await screen.pressByTestIdAsync('connected-service-setup:method:service-account');
            // A Machine-scoped method keeps its chip.
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-setup-target.chip')).not.toBeNull());
            await vi.waitFor(() => expect(inventoryReads).toHaveBeenCalled());
            if (surface === 'Gemini mixed panel') expect(machineDemand.mock.lastCall?.[0]).toBe(true);
            if (surface === 'Gemini native begin') {
                // Separate positive native-authentication contract: demand alone does not prove admission.
                await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:credentialsJson')).not.toBeNull());
                expect(authenticationCommands).toEqual([]);
                await act(async () => screen.changeTextByTestId('connected-account-manual:credentialsJson', JSON.stringify({
                    type: 'service_account', client_id: '123', client_email: 'fixture@example.test',
                    project_id: 'fixture-project', private_key: 'synthetic-test-key',
                })));
                await screen.pressByTestIdAsync('connected-account-manual:submit');
                await vi.waitFor(() => expect(authenticationCommands,
                    JSON.stringify({ text: screen.getTextContent(), controls: controlCommands,
                        requests: httpRequests.map(row => row.pathname) })).toContainEqual({ operation: 'beginConnect', service: draftService, modeId: 'service-account' }));
            } else {
                await screen.pressByTestIdAsync(`connected-service-setup:method:${mode.id}`);
                if (surface === 'Gemini mixed panel') expect(machineDemand.mock.lastCall?.[0]).toBe(false);
                expect(screen.findHostByTestId('connected-service-setup-target.chip')).toBeNull();
            }
        }
        await screen.unmount();
    });

    it.each([
        { surface: 'controller', enrolled: false }, { surface: 'controller', enrolled: true },
        { surface: 'setup-panel', enrolled: false }, { surface: 'setup-sheet', enrolled: false },
    ] as const)('offers Account device sign-in without Machine work and waits for explicit intent ($surface, enrolled: $enrolled)', async ({ surface, enrolled }) => {
        const draftService = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const descriptor = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.codex/openai-codex']!.descriptor;
        const authentication = descriptor.authentication;
        installDescription({ ...described, service: draftService, descriptor }, 'openai-codex');
        installConnectedAccountDescriptorProjection({ scopeKey: account.home.id, status: 'ready', conflicts: [], errorReason: null,
            descriptors: [{ id: draftService.localId, serviceId: 'openai-codex', pluginId: draftService.pluginId, title: 'ChatGPT',
                provenance: 'first_party', sourceKind: 'bundled', authentication,
                availability: { state: 'available', reason: 'resolved' }, capabilities: [], diagnostics: [] }] },
        captureActiveServerAccountScopeLifetime());
        if (!enrolled) {
            machineRows = [];
            storage.getState().applyMachines([], true, { sourceServerId: account.home.id });
            selection = { ...selection, candidates: [], selectedTarget: null, canExecute: false,
                state: { kind: 'unselected', candidates: [] }, resolveExecutionTarget: () => null };
        }
        const previousHttp = handleHttp;
        const { PluginAccountAvailabilityMaterializationsReadResponseV1Schema,
            PluginAccountAvailabilityIntentsListResponseV1Schema, PluginAvailabilityActionHttpPathsV1 } = await import('@happier-dev/protocol/plugins/availability');
        const features = (await import('@/dev/testkit/fixtures/featureFixtures')).createRootLayoutFeaturesResponse({ features: {
            plugins: { enabled: true, ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } },
        } });
        handleHttp = async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return Response.json(PluginAccountAvailabilityMaterializationsReadResponseV1Schema.parse({
                    availabilityCursor: 1, snapshots: [], inventoryComplete: true, releases: [],
                }));
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return Response.json(PluginAccountAvailabilityIntentsListResponseV1Schema.parse({
                    availabilityCursor: 1, pluginIds: [], intentReads: [], failedPluginIds: [],
                }));
            }
            if (path === '/v4/connect/qualified/accounts') return Response.json({ service: draftService, accounts: [] });
            return path === '/v2/connect/connected-account-attempt-transactions/pending'
                ? Response.json({ attempts: [] }) : previousHttp(url, init);
        };
        resetServerFeaturesClientForTests();
        await (await import('@/sync/sync')).sync.refreshMachines();
        // This case replaces the bootstrap HTTP routes with the bundled
        // Account inventory. Acquire that real producer before its AppShell consumer.
        await (await import('@/sync/sync')).sync.refreshPluginAccountAvailability();
        httpRequests.length = 0;
        machineRequestStacks.length = 0;
        const inventoryReads = vi.spyOn(machineInventoryProjection, 'resolveAllProfileMachineInventorySnapshots');
        const serviceKey = `${draftService.pluginId}/${draftService.localId}`;
        const registry = getConnectedServiceRegistrySnapshot();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
            <AppShellPluginUiProjectionProvider>{null}</AppShellPluginUiProjectionProvider>
        </InjectedAuthProvider>);
        // Opening a setup controller happens inside an already mounted AppShell.
        // Settle its real declaration producer before mounting this consumer.
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Account setup fixture has no current scope');
        const { readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
        await vi.waitFor(() => expect(readPluginAccountAvailability(scope).readAccountUiProjection()
            ?.connectedAccountDescriptorsById?.[serviceKey]).toBeDefined());
        await screen.update(<InjectedAuthProvider credentials={account.credentials}>
            <AppShellPluginUiProjectionProvider>
            {surface === 'controller' ? <ConnectedAccountSetupController service={draftService} targetSelection={selection}
                panel={{ intent: { kind: 'add' }, onConnected, onCancel }} />
                : surface === 'setup-sheet' ? <ConnectSheetContent onClose={onCancel} request={{ service: draftService, intent: 'add' }}
                    onResult={result => { if ('account' in result) onConnected(result.account); }} />
                    : <ConnectedServiceSetupPanel target={{ kind: 'service', serviceKey }} registry={registry}
                        catalog={[{ serviceKey, service: draftService, entry: registry.entries.find(entry =>
                            entry.service?.pluginId === draftService.pluginId && entry.service.localId === draftService.localId) ?? null,
                        legacyServiceId: 'openai-codex', label: 'ChatGPT', usedBy: [], usedByAgentIds: [], connectedCount: 0, section: 'agents', canAdd: true }]}
                        onTargetChange={() => {}} onClose={onCancel} onConnected={onConnected} />}
            </AppShellPluginUiProjectionProvider>
        </InjectedAuthProvider>);
        // The bundled Codex default exposes its Ready step without reselecting the method.
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-device:start'),
            JSON.stringify({ text: screen.getTextContent(), paths: httpRequests.map(request => request.pathname) })).not.toBeNull());
        expect(authenticationCommands).toEqual([]);
        expect(controlCommands).toEqual([]);
        expect(httpRequests.filter(request => request.pathname.startsWith('/v1/machines'))).toEqual([]);
        expect(inventoryReads).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('shows the ranked default device step without selecting it again or starting authentication', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: 'manual', modes: [
                { id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' },
                { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                    pkce: 'required', outcomeReconciliation: 'none' }, ...authentication.modes,
            ] } } });
        handleAuthentication = command => command.operation === 'cancel'
            ? { status: 'cancelled', attemptId: command.attemptId }
            : { status: 'awaitingDeviceAuthorization', attemptId: 'attempt-default',
                verificationUri: 'https://provider.example/device', userCode: 'SAFE-CODE' };
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <ConnectedAccountSetupController service={service} targetSelection={selection}
                panel={{ intent: { kind: 'add' }, onConnected, onCancel }} />
        </InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-device:start')).not.toBeNull());
        expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
        expect(authenticationCommands).toEqual([]);
        expect(screen.findHostByTestId('connected-account-device:start')!.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('connected-service-setup:method:oauth');
        await vi.waitFor(() => {
            const browserStart = screen.findHostByTestId('connected-account-oauth:start');
            expect(browserStart).not.toBeNull();
            expect(browserStart!.props.disabled).not.toBe(true);
        });
        expect(authenticationCommands).toEqual([]);
        await screen.pressByTestIdAsync('connected-service-setup:method:device');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-device:start')!.props.disabled).not.toBe(true));
        await screen.pressByTestIdAsync('connected-account-device:start');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-device:code')).not.toBeNull());
        expect(authenticationCommands).toEqual([{ operation: 'beginConnect', service, modeId: 'device' }]);
        await screen.unmount();
    });

    it('R8-9 keeps a device draft Ready without beginning authentication until the explicit action', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: 'device', modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }, ...authentication.modes] } } });
        handleAuthentication = command => command.operation === 'cancel'
            ? { status: 'cancelled', attemptId: command.attemptId }
            : command.operation === 'beginConnect' && command.modeId === 'manual'
                ? { status: 'awaitingManual', attemptId: 'manual-attempt' }
            : { status: 'awaitingDeviceAuthorization', attemptId: 'attempt-1', verificationUri: 'https://provider.example/device', userCode: 'SAFE-CODE' };
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(controlCommands).toContainEqual({ operation: 'listPendingAttempts', service }));
        await act(async () => {});
        expect(authenticationCommands).toEqual([]);
        expect(screen.findHostByTestId('connected-account-device:code')).toBeNull();
        expect(screen.findHostByTestId('connected-service-setup:preparing')).toBeNull();
        await screen.pressByTestIdAsync('connected-account-device:start');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-device:code')).not.toBeNull());
        expect(authenticationCommands).toEqual([{ operation: 'beginConnect', service, modeId: 'device' }]);
        await screen.update(element());
        expect(authenticationCommands).toHaveLength(1);
        await screen.pressByTestIdAsync('connected-service-setup:method:manual');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-service-setup:method:device');
        expect(screen.findHostByTestId('connected-account-device:code')).toBeNull();
        expect(authenticationCommands.filter(command => command.operation === 'beginConnect' && command.modeId === 'device')).toHaveLength(1);
        await screen.pressByTestIdAsync('connected-account-device:start');
        await vi.waitFor(() => expect(authenticationCommands.filter(command => command.operation === 'beginConnect' && command.modeId === 'device')).toHaveLength(2));
    });

    it('keeps a signed-out account page around its resumed reconnect and cancels only the flow', async () => {
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'existing' },
            status: 'needs_reauth', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision,
            configurationReady: true, configurationRevision: null });
        installDescription({ ...described, accounts: [saved], descriptor: { ...described.descriptor,
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'none' }] } } });
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', connectedAccountsV4: [saved] });
        handleControl = command => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [{ attemptId: 'persisted-reconnect', kind: 'oauth', modeId: 'oauth',
                intent: 'reconnect', phase: 'awaitingOAuth', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 }] }
            : description;
        handleAuthentication = command => command.operation === 'cancel'
            ? { status: 'cancelled', attemptId: command.attemptId }
            : { status: 'awaitingOAuth', attemptId: 'persisted-reconnect', authorizationUrl: 'https://provider.example/authorize',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback' };
        platform.params = { ...service, accountId: saved.ref.accountId };
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedAccountServiceView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-oauth:open'), JSON.stringify({
            text: screen.getTextContent(), controlCommands, authenticationCommands,
        })).not.toBeNull());
        expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull();
        const accountPage = screen.findHostByTestId('qualified-account-detail');
        expect(screen.findHostByTestId('qualified-account-detail:signed-out-banner')).not.toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:sign-in')).not.toBeNull();
        const flow = screen.findHostByTestId('connected-account-oauth:open')!;
        let parent = flow.parent;
        while (parent && parent.props.title !== 'connectedServicesSettings.detailSignInTitle') parent = parent.parent;
        expect(parent, 'the resumed flow belongs to the existing account Sign-in section').not.toBeNull();
        expect(screen.findHostByTestId('connected-account:cancel')).toBeNull();
        await screen.pressByTestIdAsync('connected-account-setup:cancel');
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'cancel', attemptId: 'persisted-reconnect' }));
        expect(screen.findHostByTestId('connected-account-oauth:open')).toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail')).toBe(accountPage);
        expect(screen.findHostByTestId('qualified-account-detail:signed-out-banner')).not.toBeNull();
        expect(platform.replace).not.toHaveBeenCalled();
        expect(authenticationCommands.some(command => command.operation === 'beginConnect' || command.operation === 'beginReconnect')).toBe(false);
        await screen.pressByTestIdAsync('qualified-account-detail:signed-out-banner:sign-in-again');
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'beginReconnect', account: saved.ref }));
        expect(screen.findHostByTestId('qualified-account-detail')).toBe(accountPage);
    });

    it('P8 account draft checklist · Add account keeps the existing account and returns a second connected ref to the collection', async () => {
        // The new draft must retain the existing qualified preference even when election cannot choose a sole Machine.
        const savedTarget = selection.selectedTarget;
        if (!savedTarget) throw new Error('missing_selected_machine');
        const [{ captureLazyActionAccountContext }, { createNativeAttemptAddressBoundary, answerAttemptTransaction }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
        ]);
        const other = createMachineFixture({ id: 'draft-other-machine', activeAt: Date.now() });
        machineRows.push(createPlainMachineRowFixture({ id: other.id, accountId: 'account-a' }));
        storage.getState().applyMachines([...Object.values(storage.getState().machines), other], true,
            { sourceServerId: getActiveServerSnapshot().serverId });
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            features: { connectedServices: { enabled: true } },
            capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'new-account' },
            status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision,
            configurationReady: true, configurationRevision: null });
        const existing = QualifiedConnectedAccountProfileV4Schema.parse({ ...saved, ref: { service, accountId: 'existing-account' } });
        installDescription({ ...described, accounts: [existing] });
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', connectedAccountsV4: [existing] });
        let connected = false;
        const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
        handleHttp = async (input, init) => {
            const request = new URL(String(input));
            const transaction = await answerAttemptTransaction(request, init, transactions);
            if (transaction) return transaction;
            if (request.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-a',
                timestamp: Date.now(), connectedAccountsV4: connected ? [existing, saved] : [existing] });
            if (request.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (request.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            return new Response('{}', { status: 404 });
        };
        const captured = await captureLazyActionAccountContext(account.home.id);
        const address = await createNativeAttemptAddressBoundary(captured, savedTarget.machineId);
        let cleanupScreen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            handleAuthentication = async command => {
                if (command.operation === 'submitManual') {
                    connected = true;
                    installDescription({ ...described, accounts: [existing, saved] });
                    await address.clear('attempt-1');
                    return { status: 'connected', attemptId: 'attempt-1', account: saved.ref };
                }
                if (command.operation === 'cancel') {
                    await address.clear(command.attemptId);
                    return { status: 'cancelled', attemptId: command.attemptId };
                }
                if (command.operation === 'beginConnect') {
                    await address.acknowledge({ attemptId: 'attempt-1', kind: 'manual', phase: 'awaitingManual',
                        createdAtMs: Date.now(), intent: 'connect', service: command.service, modeId: command.modeId });
                }
                return { status: 'awaitingManual', attemptId: 'attempt-1' };
            };
            const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ModalProvider>{null}</ModalProvider></InjectedAuthProvider>);
            cleanupScreen = screen;
            let result: ReturnType<typeof presentConnectSheet> | undefined;
            await act(async () => { result = presentConnectSheet({ service, intent: 'add' }); });
            expect(authenticationCommands.filter(command => command.operation === 'beginConnect')).toEqual([]);
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
            const draftSelection = screen.findByType(ConnectedAccountSetupController).props.targetSelection as MachineAdministrationTargetSelectionV1;
            expect(draftSelection.selectedTarget).toEqual(savedTarget);
            await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'secret-token'));
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            let settled: Awaited<ReturnType<typeof presentConnectSheet>> | undefined;
            void result?.then(value => { settled = value; });
            await vi.waitFor(() => expect(settled, JSON.stringify(authenticationCommands)).toEqual({ kind: 'connected', account: saved.ref }));
            expect(authenticationCommands.filter(command => command.operation === 'beginConnect')).toHaveLength(1);
            expect(authenticationCommands.filter(command => command.operation === 'beginReconnect')).toEqual([]);
            expect(authenticationCommands.filter(command => command.operation === 'submitManual')).toHaveLength(1);
            // The Home publishes the new profile separately; completing Add must not discard the retained account.
            expect(storage.getState().profile.connectedAccountsV4).toContainEqual(existing);
        } finally {
            await cleanupScreen?.unmount();
            captured.dispose();
        }
    });

    it('keeps one explicit Ask for credentials pending without repeating the connect intent, then cancels on close', async () => {
        storage.getState().applySettings({ ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'connectedServices.authentication.submitManual': { approvalRequiredSurfaces: ['ui'] },
            } }),
        }, 2);
        const approvals = installApprovalBoundary();
        await installNativeConfigurationAttemptBoundary();
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'secret-token'));
        const submission = screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(approvals, JSON.stringify({ rendered: screen.getTextContent(),
            requests: httpRequests.map(url => url.pathname), alerts: vi.mocked(Modal.alert).mock.calls })).toHaveLength(1));
        expect(approvals[0]).toMatchObject({ actionId: 'connectedServices.authentication.submitManual', status: 'open' });
        expect(authenticationCommands).toEqual([{ operation: 'beginConnect', service, modeId: 'manual' }]);
        expect(platform.confirm).not.toHaveBeenCalled();
        await screen.unmount();
        await submission;
        expect(authenticationCommands.filter(command => command.operation === 'submitManual')).toEqual([]);
        expect(onConnected).not.toHaveBeenCalled();
    });

    it('retains one initial explicit Ask across setup rerenders without beginning an unapproved attempt', async () => {
        storage.getState().applySettings({ ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'connectedServices.authentication.beginConnect': { approvalRequiredSurfaces: ['ui'] },
            } }),
        }, 2);
        const approvals = installApprovalBoundary();
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'secret-token'));
        // The explicit manual method keeps a local draft until the person submits it.
        const submission = screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(approvals).toHaveLength(1));
        await screen.update(element());
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({ actionId: 'connectedServices.authentication.beginConnect', status: 'open' });
        expect(authenticationCommands).toEqual([]);
        expect(platform.confirm).not.toHaveBeenCalled();
        await screen.unmount();
        await submission;
        expect(authenticationCommands).toEqual([]);
        expect(onConnected).not.toHaveBeenCalled();
    });

    it('submits a declared native import source choice through the qualified selected-machine attempt', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
            defaultModeId: 'native-import',
            modes: [{ id: 'native-import', title: 'Import native login', kind: 'manual', outcomeReconciliation: 'none', fields: [{
                id: 'source', title: 'Source', secret: false,
                schema: { type: 'string', enum: ['acp', 'cli'] }, default: 'acp',
                presentation: { control: 'select', options: [
                    { value: 'acp', title: 'ACP login' }, { value: 'cli', title: 'CLI login' },
                ] },
            }] }],
        } } });
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:source')).not.toBeNull());
            const choice = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'connected-account-manual:source');
            expect(choice).toBeDefined();
            expect(choice!.props.selectedId).toBe('acp');
            await act(async () => choice!.props.onSelect('cli'));
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'new-account' }));
            expect(authenticationCommands).toContainEqual({ operation: 'beginConnect', service, modeId: 'native-import' });
            expect(authenticationCommands).toContainEqual({ operation: 'submitManual', attemptId: 'attempt-1', fields: { source: 'cli' } });
        } finally { await screen.unmount(); }
    });

    it('keeps Claude setup-token and native-import methods distinguishable in the sign-in switch', async () => {
        const claudeService = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
        installDescription({ ...described, service: claudeService, descriptor: { ...described.descriptor,
            id: claudeService.localId, authentication: { defaultModeId: 'setup-token', modes: [
                { ...authentication.modes[0]!, id: 'setup-token', title: 'Setup token' },
                { ...authentication.modes[0]!, id: 'native-import', title: 'Import native login' },
            ] },
        } }, 'claude-subscription');
        const screen = await renderScreen(element(selection, claudeService));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-setup:method:native-import')).not.toBeNull());
        const methodText = (id: string) => screen.findHostByTestId(`connected-service-setup:method:${id}`)!
            .findAll(node => typeof node.type === 'string').flatMap(node => node.children.filter(child => typeof child === 'string'));
        expect(methodText('setup-token')).toContain('Setup token');
        expect(methodText('native-import')).toContain('Import native login');
        await screen.pressByTestIdAsync('connected-service-setup:method:native-import');
        expect(authenticationCommands).toEqual([]);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-native-login'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'beginConnect', service: claudeService, modeId: 'native-import' }));
    });

    it('offers no authentication method without a captured Account', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
            ...authentication,
            modes: [...authentication.modes, { ...authentication.modes[0]!, id: 'other-manual' }],
        } } });
        await account.dispose();
        storage.getState().clearProfileScope();
        expect(getActiveServerAccountScope()).toBeNull();
        const screen = await renderScreen(element());
        expect(screen.findHostByTestId('connected-service-setup:method:other-manual')).toBeNull();
        expect(screen.findByTestId('connected-account:error')).toBeNull();
        expect(authenticationCommands).toEqual([]);
        expect(onConnected).not.toHaveBeenCalled();
    });

    it.each(['Machine', 'Machine label-failed', 'Account-direct', 'Account-direct label-failed'] as const)('names a %s guided key through the existing Account label preference only after connection succeeds', async placement => {
        const keyService = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
        const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse({ ...authentication.modes[0],
            setup: { url: 'https://provider.example/keys', checklist: ['Create a key'] },
            ...(placement.startsWith('Account-direct') ? { accountDirectSave: true } : {}) });
        installDescription({ ...described, service: keyService,
            descriptor: { ...described.descriptor, authentication: { defaultModeId: mode.id, modes: [mode] } } }, 'anthropic');
        installConnectedAccountDescriptorProjection({ scopeKey: account.home.id, status: 'ready', conflicts: [], errorReason: null,
            descriptors: [{ id: keyService.localId, serviceId: keyService.localId, pluginId: keyService.pluginId, title: 'Anthropic',
                provenance: 'external', sourceKind: 'installed', authentication: { defaultModeId: mode.id, modes: [mode] },
                availability: { state: 'available', reason: 'resolved' }, capabilities: [], diagnostics: [] }] }, captureActiveServerAccountScopeLifetime());
        const boundary = installAccountLabelBoundary(QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service: keyService, accountId: 'new-key' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        }));
        const labelsHttp = handleHttp;
        let directRef: QualifiedConnectedAccountProfileV4['ref'] | undefined;
        let credentialWrites = 0;
        handleHttp = async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/promote') {
                credentialWrites += 1;
                const promotion = SharedSavedSecretPromoteInputV1Schema.parse(JSON.parse(String(init?.body)));
                const write = promotion.connectedAccountCredentialMutation!;
                expect(write.metadata).not.toHaveProperty('displayName');
                directRef = write.ref;
                boundary.publishAccount(QualifiedConnectedAccountProfileV4Schema.parse({ ref: write.ref,
                    status: 'connected', authenticationModeId: mode.id, revisionSemantics: 'revisioned', credentialRevision,
                    configurationReady: true, configurationRevision: null, scopes: [] }));
                return Response.json({ resourceId: promotion.resourceId, settingsVersion: 1 });
            }
            if (placement.endsWith('label-failed') && new URL(String(url)).pathname === CONNECTED_PRESENTATION_ROWS_ROUTE_V1
                && init?.method === 'POST') return Response.json({ error: 'label_temporarily_unavailable' }, { status: 503 });
            return labelsHttp(url, init);
        };
        const [{ captureLazyActionAccountContext }, { createNativeAttemptAddressBoundary, answerAttemptTransaction }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
        ]);
        const captured = await captureLazyActionAccountContext(account.home.id);
        const address = await createNativeAttemptAddressBoundary(captured, selection.selectedTarget!.machineId);
        const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
        const credentialHttp = handleHttp;
        handleHttp = async (input, init) => await answerAttemptTransaction(new URL(String(input)), init, transactions)
            ?? credentialHttp(input, init);
        handleAuthentication = async command => {
            if (command.operation === 'submitManual') {
                await address.clear('attempt-1');
                return { status: 'connected', attemptId: 'attempt-1', account: { service: keyService, accountId: 'new-key' } };
            }
            await address.acknowledge({ attemptId: 'attempt-1', kind: 'manual', phase: 'awaitingManual',
                createdAtMs: Date.now(), intent: 'connect', service: keyService, modeId: mode.id });
            return { status: 'awaitingManual', attemptId: 'attempt-1' };
        };
        const screen = await renderScreen(element(selection, keyService));
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:name')).not.toBeNull());
            await act(async () => {
                screen.changeTextByTestId('connected-account-manual:token', 'sk-ant-secret');
                screen.changeTextByTestId('connected-account-manual:name', 'Build server');
            });
            expect(boundary.readPresentation().entries).toEqual([]);
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            if (placement.endsWith('label-failed')) {
                await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith(directRef ?? { service: keyService, accountId: 'new-key' }));
                expect(onConnected).toHaveBeenCalledOnce();
                expect(Modal.alert).toHaveBeenCalled();
                expect(boundary.readPresentation().entries).toEqual([]);
                if (placement.startsWith('Account-direct')) {
                    expect(credentialWrites).toBe(1);
                    expect(authenticationCommands).toEqual([]);
                } else {
                    expect(credentialWrites).toBe(0);
                    expect(authenticationCommands.filter(command => command.operation === 'submitManual')).toHaveLength(1);
                }
                return;
            }
            await vi.waitFor(() => expect(boundary.readPresentation().entries).toContainEqual({
                v: 1,
                subject: { kind: 'account', account: directRef ?? { service: keyService, accountId: 'new-key' } }, label: 'Build server',
            }));
            if (placement === 'Machine') expect(authenticationCommands).toContainEqual({ operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'sk-ant-secret' } });
            else expect(authenticationCommands).toEqual([]);
        } finally { await screen.unmount(); captured.dispose(); }
    });

    it('fails closed before daemon effects for a machine belonging to another Home', async () => {
        storage.getState().applySettings({ ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: { serverIdentityId: 'srv_foreign_home', machineId: selection.selectedTarget!.machineId } },
        }, 2);
        const screen = await focusedScreen();
        expect(screen.findHostByTestId('connected-account-account-scope-mismatch')).not.toBeNull();
        expect(controlCommands).toEqual([]);
        expect(authenticationCommands).toEqual([]);
    });

    it.each(['unselected', 'offline', 'foreign'] as const)('P8 capability preservation checklist · personal label save/reset survives reload with an %s machine', async (machineState) => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        const boundary = installAccountLabelBoundary(targetAccount);
        if (machineState === 'unselected') leaveMachineChoiceUnselected();
        else if (machineState === 'offline') {
            const machine = createMachineFixture({ id: selection.selectedTarget!.machineId, active: false, activeAt: Date.now() + 1,
                presenceProtocolVersion: 1 });
            const serverId = getActiveServerSnapshot().serverId;
            // The Home publishes a newer inactive observation over the online bootstrap row.
            machineRows = [createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine })];
            storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        }
        else storage.getState().applySettings({ ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: {
                serverIdentityId: 'srv_foreign_home', machineId: selection.selectedTarget!.machineId,
            } },
        }, 2);
        if (machineState === 'offline') expect(readMachineActivity(storage.getState().machines[selection.selectedTarget!.machineId]).active).toBe(false);
        const screen = await focusedScreen(true);
        expect(screen.findHostByTestId('qualified-account-detail'), JSON.stringify({ tree: screen.tree.toJSON(), profile: storage.getState().profile, machines: storage.getState().machines })).not.toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:refresh')).toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:configuration')).toBeNull();
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        const label = machineState === 'unselected' ? 'A personal account label beyond the former local cap · '.repeat(3) : 'Travel account';
        const input = screen.findHostByTestId('qualified-account-detail:rename:input');
        if (!input) throw new Error('Expected the mounted native label input');
        // Native TextInput enforces maxLength before delivering onChangeText.
        // Model that SDK boundary so this journey cannot bypass a platform cap.
        const acceptedInput = label.slice(0, typeof input.props.maxLength === 'number' ? input.props.maxLength : undefined);
        await act(async () => screen.changeTextByTestId('qualified-account-detail:rename:input', acceptedInput));
        await screen.pressByTestIdAsync('qualified-account-detail:rename:save');
        await vi.waitFor(() => expect(boundary.readPresentation().entries).toEqual([
            { v: 1, subject: { kind: 'account', account: targetAccount.ref }, label: label.trim() },
        ]));
        await screen.unmount();
        const reloaded = await focusedScreen(true);
        await reloaded.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        expect(reloaded.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe(label.trim());
        await act(async () => reloaded.changeTextByTestId('qualified-account-detail:rename:input', ''));
        await reloaded.pressByTestIdAsync('qualified-account-detail:rename:save');
        await vi.waitFor(() => expect(boundary.readPresentation().entries.some(entry => entry.label === label.trim())).toBe(false));
        await reloaded.unmount();
        const reset = await focusedScreen(true);
        await reset.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        expect(reset.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe('');
        expect(controlCommands.filter(command => command.operation !== 'describeService')).toEqual([]);
        expect(authenticationCommands).toEqual([]);
        expect(httpRequests.some(url => url.pathname === '/v4/connect/qualified/quotas/refresh')).toBe(false);
    });

    it('keeps the saved Account detail when the selected machine has no augmentation for it', async () => {
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', connectedAccountsV4: [{
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        }] });
        installDescription({ ...described, accounts: [] });
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(controlCommands.some(command => command.operation === 'describeService')).toBe(true));
        await act(async () => {});
        expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:action:edit-label')).not.toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:configuration')).toBeNull();
    });

    it('labels an unfenced qualified Account without admitting credential operations', async () => {
        const targetAccount = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'legacy_unfenced', credentialRevision: null,
            configurationReady: false, configurationRevision: null, scopes: [],
        });
        const boundary = installAccountLabelBoundary(targetAccount);
        leaveMachineChoiceUnselected();
        const screen = await focusedScreen(true);
        expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull();
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        await act(async () => screen.changeTextByTestId('qualified-account-detail:rename:input', 'Legacy work'));
        await screen.pressByTestIdAsync('qualified-account-detail:rename:save');
        await vi.waitFor(() => expect(boundary.readPresentation().entries).toEqual([
            { v: 1, subject: { kind: 'account', account: targetAccount.ref }, label: 'Legacy work' },
        ]));
        for (const action of ['action:reconnect', 'action:disconnect', 'configuration']) {
            expect(screen.findHostByTestId(`qualified-account-detail:${action}`)).toBeNull();
        }
        expect(authenticationCommands).toEqual([]);
        expect(controlCommands).toEqual([]);
    });

    it.each(['draft', 'pending'] as const)('retains the Account label %s across a machine selection change', async phase => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        let releaseWrite!: () => void;
        const writeReady = new Promise<void>(resolve => { releaseWrite = resolve; });
        const boundary = installAccountLabelBoundary(targetAccount, phase === 'pending' ? () => writeReady : undefined);
        installDescription({ ...described, accounts: [targetAccount] });
        storage.getState().applyMachines([
            createMachineFixture({ id: selection.selectedTarget!.machineId, activeAt: Date.now() }),
            createMachineFixture({ id: 'machine-second', activeAt: Date.now() }),
        ], true, { sourceServerId: getActiveServerSnapshot().serverId });
        const screen = await focusedScreen(true);
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        await act(async () => screen.changeTextByTestId('qualified-account-detail:rename:input', 'Travel account'));
        const pendingSave = phase === 'pending' ? screen.pressByTestIdAsync('qualified-account-detail:rename:save') : null;
        try {
            if (pendingSave) await vi.waitFor(() => expect(boundary.readWriteSignal()).toBeInstanceOf(AbortSignal));
            await act(async () => storage.getState().applySettings({ ...storage.getState().settings,
                machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: {
                    serverIdentityId: account.home.serverIdentityId!, machineId: 'machine-second',
                } },
            }, 2));
            if (phase === 'draft') {
                expect(screen.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe('Travel account');
                await screen.pressByTestIdAsync('qualified-account-detail:rename:save');
            } else {
                expect(boundary.readWriteSignal()?.aborted).toBe(false);
                releaseWrite();
                await pendingSave;
            }
            await vi.waitFor(() => expect(boundary.readPresentation().entries).toEqual([
                { v: 1, subject: { kind: 'account', account: targetAccount.ref }, label: 'Travel account' },
            ]));
        } finally { releaseWrite(); await pendingSave; }
    });

    it('retires native reconnect replies when the detail machine changes', async () => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        installAccountLabelBoundary(targetAccount);
        installDescription({ ...described, accounts: [targetAccount] });
        storage.getState().applyMachines([
            createMachineFixture({ id: selection.selectedTarget!.machineId, activeAt: Date.now() }),
            createMachineFixture({ id: 'machine-second', activeAt: Date.now() }),
        ], true, { sourceServerId: getActiveServerSnapshot().serverId });
        const late = deferredReply();
        handleAuthentication = command => command.operation === 'beginReconnect' ? late.promise
            : { status: 'cancelled', attemptId: 'old-machine-attempt' };
        const screen = await focusedScreen(true);
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:reconnect')).not.toBeNull());
        await screen.pressByTestIdAsync('qualified-account-detail:action:reconnect');
        await vi.waitFor(() => expect(authenticationCommands.some(command => command.operation === 'beginReconnect')).toBe(true));
        await act(async () => storage.getState().applySettings({ ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: {
                serverIdentityId: account.home.serverIdentityId!, machineId: 'machine-second',
            } },
        }, 2));
        await act(async () => late.resolve({ status: 'awaitingManual', attemptId: 'old-machine-attempt' }));
        expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
    });

    it('does not promote a persisted machine choice with no fresh inventory into execution authority', async () => {
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true,
            configurationRevision: null, scopes: [],
        });
        installAccountLabelBoundary(saved);
        // A warm row remains cached while this Home has not returned its current inventory.
        storage.setState({ isDataReady: false, machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
        const screen = await focusedScreen();
        // One quiet machine line (the canonical machine section) and no second chooser in the header.
        expect(screen.findHostByTestId('connected-account-target.state'), JSON.stringify(screen.tree.toJSON())).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-target.chip')).toBeNull();
        expect(controlCommands.filter(command => command.operation !== 'describeService')).toEqual([]);
        expect(authenticationCommands).toEqual([]);
    });

    it('recovers an unavailable description through user retry without starting authentication first', async () => {
        let available = false;
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : available ? description : { status: 'unavailable', code: 'connected_account_service_description_unavailable' };
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('connected_account_service_description_unavailable');
        expect(authenticationCommands).toEqual([]);
        available = true;
        await screen.pressByTestIdAsync('connected-account:error:retry');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account:error')).toBeNull();
    });

    it('says the sign-in could not load when its description fails without a typed reason', async () => {
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : { status: 'conflict', code: 'boat_setup_declaration_unreadable' };
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
        expect(screen.getTextContent()).toContain('connectedServices.errors.signInLoadFailed');
        expect(screen.getTextContent()).not.toContain('connectedServices.errors.generic');
        expect(screen.findHostByTestId('connected-account:error:retry')!.props.accessibilityLabel).toBe('common.retry');
    });

    it('rejects a malformed plugin-declared key inline before submission and accepts a corrected shape', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
            defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'API key', secret: true, schema: ANTHROPIC_API_KEY_INPUT_SCHEMA }] }],
        } } });
        await installNativeConfigurationAttemptBoundary();
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'not-a-valid-key'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(authenticationCommands.filter((command) => command.operation === 'submitManual')).toEqual([]);
        expect(screen.findHostByTestId('connected-account-manual:token.error')).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.value).toBe('not-a-valid-key');
        expect(onConnected).not.toHaveBeenCalled();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'sk-ant-corrected'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'new-account' }));
    });

    it.each([
        { status: 'rejected', code: 'cloudflare_token_rejected', message: 'Cloudflare rejected this token.' },
        { status: 'unavailable', code: 'cloudflare_verification_unavailable', message: 'Cloudflare verification is unavailable. No token was saved; try again.' },
    ] as const)('shows the provider probe diagnostic for $status authentication', async ({ status, code, message }) => {
        handleAuthentication = command => command.operation === 'submitManual'
            ? { status, attemptId: 'attempt-1', code, diagnostic: { message } }
            : { status: 'awaitingManual', attemptId: 'attempt-1' };
        await installNativeConfigurationAttemptBoundary();
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-provider-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
        expect(screen.getTextContent()).toContain(message);
        expect(screen.getTextContent()).not.toContain('connectedServices.errors.accountServiceUnavailable');
        expect(onConnected).not.toHaveBeenCalled();
    });

    it('returns to a fresh editable manual form after provider verification rejects a valid-shaped key', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
            defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'API key', secret: true, schema: ANTHROPIC_API_KEY_INPUT_SCHEMA }] }],
        } } });
        handleAuthentication = (command) => {
            if (command.operation === 'submitManual') {
                return command.fields.token === 'sk-ant-qa-fake'
                    ? { status: 'rejected', attemptId: 'attempt-1', code: 'credential_unavailable', diagnostic: { message: 'The provider rejected this token.' } }
                    : { status: 'connected', attemptId: 'attempt-2', account: { service, accountId: 'corrected-account' } };
            }
            if (command.operation === 'read') {
                return { status: 'rejected', attemptId: 'attempt-1', code: 'credential_unavailable' };
            }
            return { status: 'awaitingManual', attemptId: authenticationCommands.some((entry) => entry.operation === 'submitManual') ? 'attempt-2' : 'attempt-1' };
        };
        await installNativeConfigurationAttemptBoundary();
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'sk-ant-qa-fake'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
        expect(screen.getTextContent()).toContain('The provider rejected this token.');
        expect(screen.getTextContent()).not.toContain('connectedServices.errors.generic');
        expect(screen.findHostByTestId('connected-account:error:retry')!.props.accessibilityLabel).toBe('common.edit');
        expect(authenticationCommands.filter(command => command.operation === 'read' || command.operation === 'pollDevice')).toEqual([]);
        expect(onConnected).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('connected-account:error:retry');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.editable).toBe(true);
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.value).toBe('');
        expect(screen.findHostByTestId('connected-account:error')).toBeNull();
        expect(authenticationCommands).toContainEqual({ operation: 'cancel', attemptId: 'attempt-1' });
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'sk-ant-corrected'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'corrected-account' }));
        expect(authenticationCommands.filter(command => command.operation === 'cancel')).toEqual([{ operation: 'cancel', attemptId: 'attempt-1' }]);
        expect(authenticationCommands.filter((command) => command.operation === 'submitManual')).toEqual([
            { operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'sk-ant-qa-fake' } },
            { operation: 'submitManual', attemptId: 'attempt-2', fields: { token: 'sk-ant-corrected' } },
        ]);
    });

    it('refreshes a stale described manual form before retrying a terminal admission rejection', async () => {
        let attemptsBegun = 0;
        handleAuthentication = (command) => command.operation === 'beginConnect'
            ? { status: 'awaitingManual', attemptId: `attempt-${++attemptsBegun}` }
            : command.operation === 'submitManual'
                ? { status: 'rejected', attemptId: 'attempt-1', code: 'connected_account_manual_fields_invalid' }
                : { status: 'cancelled', attemptId: 'attempt-1' };
        await installNativeConfigurationAttemptBoundary();
        const screen = await manualScreen();
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
            defaultModeId: 'manual', modes: [{ ...authentication.modes[0], fields: [{ id: 'apiKey', title: 'API key', secret: true, schema: { type: 'string', minLength: 1 } }] }],
        } } });
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'captured-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account:error:retry');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:apiKey')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
        expect(attemptsBegun).toBe(2);
    });

    it('keeps an unsupported legacy service closed before authentication, pool, or quota effects', async () => {
        const compatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID.bitbucket;
        installDescription({ ...described, service: compatibility.service,
            descriptor: { ...described.descriptor, id: compatibility.service.localId },
        }, 'bitbucket');
        handleControl = () => ({ status: 'unavailable', code: 'connected_account_service_identity_unsupported' });
        platform.params = { ...compatibility.service, accountId: 'account-1' };
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedAccountServiceView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
        expect(controlCommands.length).toBeGreaterThan(0);
        expect(controlCommands.every(command => command.operation === 'describeService'
            && command.service.pluginId === compatibility.service.pluginId
            && command.service.localId === compatibility.service.localId
            && command.requiredOperation === 'account_list')).toBe(true);
        expect(authenticationCommands).toEqual([]);
        expect(httpRequests.filter((url) => url.pathname.startsWith('/v4/connect/qualified/'))).toEqual([]);
        expect(screen.findHostByTestId('qualified-account-detail')).toBeNull();
    });

    it('uses the generated legacy identity only to reach fresh revisioned setup, then submits through the daemon owner', async () => {
        const compatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID.github;
        const modeId = compatibility.authenticationModeByCredentialKind.token!;
        installDescription({ ...described, service: compatibility.service,
            descriptor: { id: compatibility.service.localId, title: 'GitHub', authentication: {
                defaultModeId: modeId, modes: [{ ...authentication.modes[0], id: modeId }],
            } },
            operationTransport: { kind: 'legacy', peerClass: 'revisioned_v2_v3', serviceId: 'github' },
        }, 'github');
        // No machine descriptor is retained: the generated identity cannot supply an authentication mode.
        installConnectedAccountDescriptorProjection({ scopeKey: getActiveServerSnapshot().serverId,
            status: 'ready', conflicts: [], errorReason: null, descriptors: [] });
        handleAuthentication = (command) => command.operation === 'submitManual'
            ? { status: 'connected', attemptId: 'attempt-1', account: { service: compatibility.service, accountId: 'new-account' } }
            : { status: 'awaitingManual', attemptId: 'attempt-1' };
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element(selection, compatibility.service));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        expect(controlCommands).toContainEqual({ operation: 'describeService', service: compatibility.service, requiredOperation: 'account_list' });
        expect(authenticationCommands).toEqual([]);
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'github-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service: compatibility.service, accountId: 'new-account' }));
        expect(authenticationCommands).toContainEqual({ operation: 'beginConnect', service: compatibility.service, modeId });
    });

    it('cancels locally without waiting and ignores a late submission reply after its host closes', async () => {
        const submitted = deferredReply();
        const cancelled = deferredReply();
        handleAuthentication = (command) => command.operation === 'submitManual' ? submitted.promise
            : command.operation === 'cancel' ? cancelled.promise
                : { status: 'awaitingManual', attemptId: 'attempt-1' };
        await installNativeConfigurationAttemptBoundary();
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'secret-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(authenticationCommands.some((command) => command.operation === 'submitManual')).toBe(true));
        await screen.pressByTestIdAsync('connected-account-setup:cancel');
        expect(onCancel).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'cancel', attemptId: 'attempt-1' }));
        // The setup host closes its draft in response to the local cancellation.
        await screen.update(<InjectedAuthProvider credentials={null}>{null}</InjectedAuthProvider>);
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
        await act(async () => submitted.resolve({ status: 'awaitingManual', attemptId: 'attempt-1' }));
        expect(onConnected).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
        await act(async () => cancelled.resolve({ status: 'cancelled', attemptId: 'attempt-1' }));
    });

    it('keeps the first explicit method choice while the previous attempt is still cancelling', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { ...authentication, modes: [...authentication.modes, {
                id: 'other', kind: 'manual', outcomeReconciliation: 'none', fields: authentication.modes[0].fields,
            }] },
        } });
        const cancellation = deferredReply();
        handleControl = command => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [{ attemptId: 'old-attempt', kind: 'manual', modeId: 'manual',
                intent: 'connect', phase: 'awaitingManual', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 }] }
            : description;
        handleAuthentication = command => command.operation === 'cancel' ? cancellation.promise
            : { status: 'awaitingManual', attemptId: command.operation === 'beginConnect' && command.modeId === 'other'
                ? 'new-attempt' : 'old-attempt' };
        const address = await installNativeConfigurationAttemptBoundary();
        await address.acknowledge({ attemptId: 'old-attempt', kind: 'manual', phase: 'awaitingManual',
            createdAtMs: Date.now(), intent: 'connect', service, modeId: 'manual' });
        const screen = await manualScreen();
        try {
            await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'read', attemptId: 'old-attempt' }));
            await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'do-not-retain'));
            await screen.pressByTestIdAsync('connected-service-setup:method:other');
            expect(screen.findHostByTestId('connected-service-setup:method:other')?.props.accessibilityState?.checked).toBe(true);
            await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'cancel', attemptId: 'old-attempt' }));
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
            expect(screen.findHostByTestId('connected-service-setup:method:other')?.props.accessibilityState?.checked).toBe(true);
            expect(screen.findHostByTestId('connected-account-manual:token')?.props.value).toBe('');
            expect(authenticationCommands).not.toContainEqual({ operation: 'beginConnect', service, modeId: 'other' });
            await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'new-token'));
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'beginConnect', service, modeId: 'other' }));
            expect(onConnected).not.toHaveBeenCalled();
        } finally {
            cancellation.resolve({ status: 'cancelled', attemptId: 'old-attempt' });
            await screen.unmount();
        }
    });

    it('does not reopen a restored service configuration after switching the sign-in method', async () => {
        const mode: PluginConnectedAccountAuthenticationModeV2 = { ...configuredMode,
            configuration: { ...configuredMode.configuration!, scope: 'service' } };
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: mode.id, modes: [mode, ...authentication.modes] } } });
        const gate = deferredReply();
        const cancelledGate = deferredReply();
        let reading = false;
        let restoredAttemptRead = false;
        let cancelled = false;
        const previousHttp = handleHttp;
        handleHttp = async (input, init) => {
            if (new URL(String(input)).pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`) {
                if (restoredAttemptRead) {
                    reading = true;
                    await gate.promise;
                }
                return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { key: 'configurations', value: {
                    v: 1, entries: [{ service, modeId: mode.id, revision: 'config-1', values: { endpoint: 'https://old.example' }, secretRefs: {} }],
                } } } });
            }
            return previousHttp(input, init);
        };
        handleControl = async command => {
            if (command.operation !== 'listPendingAttempts') return description;
            // Let the daemon finish cancellation before answering a new discovery, so this
            // case isolates the already-running Account read rather than a second resume.
            if (restoredAttemptRead && !cancelled) await cancelledGate.promise;
            return { status: 'pendingAttempts', attempts: cancelled ? [] : [{ attemptId: 'restored-attempt', kind: 'oauth',
                modeId: mode.id, intent: 'connect', phase: 'configurationRequired', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 }] };
        };
        handleAuthentication = command => {
            if (command.operation === 'cancel') {
                cancelled = true;
                cancelledGate.resolve(null);
                return { status: 'cancelled', attemptId: command.attemptId };
            }
            if (command.operation === 'beginConnect' && command.modeId === 'manual') return { status: 'awaitingManual', attemptId: 'fresh-manual' };
            restoredAttemptRead = true;
            return { status: 'configurationRequired', attemptId: 'restored-attempt', target: { kind: 'service', service, modeId: mode.id }, missingFieldIds: [] };
        };
        const address = await installNativeConfigurationAttemptBoundary();
        await address.acknowledge({ attemptId: 'restored-attempt', kind: 'oauth', phase: 'configurationRequired',
            createdAtMs: Date.now(), intent: 'connect', service, modeId: mode.id });
        const screen = await renderScreen(element(selection, service, mode.id));
        try {
            await vi.waitFor(() => expect(reading, screen.getTextContent()).toBe(true));
            expect(authenticationCommands).toContainEqual({ operation: 'read', attemptId: 'restored-attempt' });
            expect(screen.findHostByTestId('connected-service-setup:method:manual')?.props.accessibilityState?.disabled).toBe(false);
            await screen.pressByTestIdAsync('connected-service-setup:method:manual');
            await vi.waitFor(() => expect(cancelled, JSON.stringify({ rendered: screen.getTextContent(), authenticationCommands })).toBe(true));
            expect(screen.findHostByTestId('connected-service-setup:method:manual')?.props.accessibilityState?.checked).toBe(true);
            await act(async () => gate.resolve(null));
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
            expect(screen.findHostByTestId('connected-account-configuration:endpoint')).toBeNull();
            expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull();
            expect(onConnected).not.toHaveBeenCalled();
        } finally { gate.resolve(null); cancelledGate.resolve(null); await screen.unmount(); }
    });

    it.each(['advanced', 'unchanged'] as const)('recovers a lost reply with the same exact attempt (%s)', async (outcome) => {
        handleAuthentication = (command) => {
            if (command.operation === 'submitManual') throw new Error('Lost transport reply');
            if (command.operation === 'read' && outcome === 'advanced') {
                return { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'new-account' } };
            }
            return { status: 'awaitingManual', attemptId: 'attempt-1' };
        };
        await installNativeConfigurationAttemptBoundary();
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'secret-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account:error:retry');
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'read', attemptId: 'attempt-1' }));
        expect(authenticationCommands.filter((command) => command.operation === 'submitManual')).toHaveLength(1);
        if (outcome === 'advanced') {
            await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'new-account' }));
            expect(screen.findHostByTestId('connected-account:error')).toBeNull();
        } else {
            expect(screen.findHostByTestId('connected-account:error')).not.toBeNull();
            expect(onConnected).not.toHaveBeenCalled();
        }
    });

    it.each(['device', 'oauth'] as const)('resumes daemon-persisted %s authentication after remount without creating another attempt', async (kind) => {
        let persistedAttemptLive = true;
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: kind, modes: [kind === 'device'
                ? { id: kind, kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }
                : { id: kind, kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'none' }, ...authentication.modes] },
        } });
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: !persistedAttemptLive ? [] : [{ attemptId: 'persisted-attempt', kind, modeId: kind,
                intent: 'connect', phase: kind === 'device' ? 'awaitingDeviceAuthorization' : 'awaitingOAuth',
                createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 }] }
            : description;
        handleAuthentication = command => {
            if (command.operation === 'cancel') {
                persistedAttemptLive = false;
                return { status: 'cancelled', attemptId: command.attemptId };
            }
            return command.operation === 'beginConnect' && command.modeId === 'manual'
            ? { status: 'awaitingManual', attemptId: 'other-method' }
            : kind === 'device'
            ? { status: 'awaitingDeviceAuthorization', attemptId: 'persisted-attempt', verificationUri: 'https://provider.example/device',
                userCode: 'SAFE-CODE', expiresAtMs: Date.now() + 60_000, pollIntervalMs: 5_000 }
            : { status: 'awaitingOAuth', attemptId: 'persisted-attempt', authorizationUrl: 'https://provider.example/authorize', callbackUrl: 'http://127.0.0.1:4000/auth/callback' };
        };
        await installNativeConfigurationAttemptBoundary();
        const testId = kind === 'device' ? 'connected-account-device:code' : 'connected-account-oauth:open';
        const first = await renderScreen(element());
        await vi.waitFor(() => expect(first.findHostByTestId(testId)).not.toBeNull());
        await act(async () => first.tree.unmount());
        const second = await renderScreen(element());
        await vi.waitFor(() => expect(second.findHostByTestId(testId)).not.toBeNull());
        expect(authenticationCommands).toEqual(Array.from({ length: 2 }, () => kind === 'device'
            ? { operation: 'resumeDevice', attemptId: 'persisted-attempt' }
            : { operation: 'read', attemptId: 'persisted-attempt' }));
        if (kind === 'device') {
            await second.pressByTestIdAsync('connected-service-setup:method:manual');
            await vi.waitFor(() => expect(second.findHostByTestId('connected-account-manual:token')).not.toBeNull());
            await second.pressByTestIdAsync('connected-service-setup:method:device');
            expect(authenticationCommands.filter(command => command.operation === 'beginConnect' && command.modeId === 'device')).toHaveLength(0);
            expect(second.findHostByTestId('connected-account-device:start')!.props.disabled).not.toBe(true);
            await second.pressByTestIdAsync('connected-account-device:start');
            await vi.waitFor(() => expect(authenticationCommands.filter(command => command.operation === 'beginConnect' && command.modeId === 'device')).toHaveLength(1));
        }
    });

    it('publishes the actual completion key fact before the new account enters inventory', async () => {
        const connected = { service, accountId: 'new-account-before-inventory' };
        handleAuthentication = command => command.operation === 'submitManual'
            ? { status: 'connected', attemptId: 'created-key', account: connected, includesApiKey: true }
            : { status: 'awaitingManual', attemptId: 'created-key' };
        await installNativeConfigurationAttemptBoundary();
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-setup-key'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith(connected, { includesApiKey: true }));
        expect(storage.getState().profile.connectedAccountsV4.some(account => account.ref.accountId === connected.accountId)).toBe(false);
    });

    it.each(['route', 'machine', 'account', 'server', 'unmount'] as const)('ignores a terminal late reply after %s retirement', async (retirement) => {
        const pending = deferredReply();
        let issued = false;
        handleAuthentication = () => {
            if (issued) return { status: 'awaitingManual', attemptId: 'fresh-attempt' };
            issued = true;
            return pending.promise;
        };
        const screen = await renderScreen(element(selection, service, 'manual'));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-retired-key'));
        const submission = screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'beginConnect', service, modeId: 'manual' }));
        await act(async () => {
            if (retirement === 'unmount') screen.tree.unmount();
            else if (retirement === 'route') screen.tree.update(element(selection, { ...service, localId: 'other' }));
            else if (retirement === 'machine') {
                const execution = selection.resolveExecutionTarget()!;
                const nextTarget = { ...execution.target, machineId: 'other-machine' };
                screen.tree.update(element({ ...selection, selectedTarget: nextTarget,
                    resolveExecutionTarget: () => ({ ...execution, target: nextTarget, machine: { ...execution.machine, id: nextTarget.machineId } }) }));
            } else if (retirement === 'account') storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-b' });
            else await account.dispose();
        });
        await act(async () => pending.resolve({ status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'must-not-publish' } }));
        await submission;
        expect(onConnected).not.toHaveBeenCalled();
    });

    it('polls a visible device code at the provider interval and retains it while approval is pending', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: 'device', modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'providerCheck' }] } } });
        handleAuthentication = (command) => command.operation === 'beginConnect'
            ? { status: 'awaitingDeviceAuthorization', attemptId: 'attempt-1', verificationUri: 'https://provider.example/device',
                userCode: 'SAFE-CODE', expiresAtMs: Date.now() + 60_000, pollIntervalMs: 5_000 }
            : { status: 'pending', attemptId: 'attempt-1', retryAfterMs: 5_000 };
        vi.useFakeTimers();
        try {
            await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element());
            await act(async () => { await vi.advanceTimersByTimeAsync(0); });
            await screen.pressByTestIdAsync('connected-account-device:start');
            expect(screen.findByTestId('connected-account-device:code')).toBeTruthy();
            await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
            expect(authenticationCommands).toContainEqual({ operation: 'pollDevice', attemptId: 'attempt-1' });
            expect(screen.findByTestId('connected-account-device:code')).toBeTruthy();
        } finally { vi.useRealTimers(); }
    });

    it('keeps a manual approval check when an external device service publishes no polling cadence', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: 'device', modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'providerCheck' }] } } });
        handleAuthentication = () => ({ status: 'awaitingDeviceAuthorization', attemptId: 'attempt-1', verificationUri: 'https://provider.example/device', userCode: 'SAFE-CODE' });
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-device:start')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account-device:start');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-device:poll')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account-device:poll');
        expect(authenticationCommands).toContainEqual({ operation: 'pollDevice', attemptId: 'attempt-1' });
    });

    it.each(['oauth', 'device'] as const)('continues an uncertain pending %s attempt through its mode-owned operation', async (kind) => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: kind, modes: [kind === 'device'
                ? { id: kind, kind: 'oauthDeviceCode', outcomeReconciliation: 'providerCheck' }
                : { id: kind, kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
        } });
        handleAuthentication = (command) => command.operation === 'reconcile'
            ? { status: 'pending', attemptId: 'attempt-1', retryAfterMs: 250 }
            : { status: 'outcomeUnknown', attemptId: 'attempt-1', diagnostic: { code: 'provider_response_lost' } };
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element());
        await pressReadyAction(screen, kind === 'device' ? 'connected-account-device:start' : 'connected-account-oauth:start');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:reconcile')).not.toBeNull());
        vi.useFakeTimers();
        try {
            await screen.pressByTestIdAsync('connected-account:reconcile');
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            expect(authenticationCommands).toEqual([
                { operation: 'beginConnect', service, modeId: kind },
                { operation: 'reconcile', attemptId: 'attempt-1' },
                { operation: kind === 'device' ? 'pollDevice' : 'reconcile', attemptId: 'attempt-1' },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(['readConfiguration', 'replaceConfiguration', 'continueConnect'] as const)('ignores a late %s reply after the enclosing setup panel unmounts', async (operation) => {
        if (operation !== 'readConfiguration') waiveConfigurationConfirmation();
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [configuredMode] } } });
        const pending = deferredReply();
        const committed = { ...configurationReply, status: 'configurationCommitted', configuration: { ...configurationReply.configuration, status: 'ready', revision: 'config-2' } };
        handleControl = (command) => command.operation === operation ? pending.promise
            : command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] }
                : command.operation === 'readConfiguration' ? configurationReply
                    : command.operation === 'replaceConfiguration' ? committed : description;
        handleAuthentication = (command) => command.operation === operation ? pending.promise
            : { status: 'configurationRequired', attemptId: 'attempt-1', target: configurationTarget, missingFieldIds: [] };
        await installNativeConfigurationAttemptBoundary();
        // 58c-u1 explicit-intent contract: opening a draft does not choose its method.
        const screen = await renderScreen(element(selection, service, 'oauth'));
        await pressReadyAction(screen);
        if (operation !== 'readConfiguration') {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
            await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
            await screen.pressByTestIdAsync('connected-account-configuration:save');
        }
        await vi.waitFor(() => expect([...controlCommands, ...authenticationCommands].some((command) => command.operation === operation),
            JSON.stringify({ rendered: screen.getTextContent(), controlCommands, authenticationCommands,
                httpPaths: httpRequests.map(request => request.pathname) })).toBe(true));
        await act(async () => screen.tree.unmount());
        await act(async () => pending.resolve(operation === 'readConfiguration' ? configurationReply
            : operation === 'replaceConfiguration' ? committed
                : { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'retired-account' } }));
        expect(onConnected).not.toHaveBeenCalled();
        if (operation !== 'continueConnect') expect(authenticationCommands.some((command) => command.operation === 'continueConnect')).toBe(false);
    });

    it.each([null, 'config-1'])('confirms configuration save only on an existing revision (%s)', async (revision) => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: 'oauth', modes: [configuredMode] } } });
        const reply = { ...configurationReply, configuration: { ...configurationReply.configuration, revision,
            configuredSecretFieldIds: [] } };
        handleControl = command => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? reply
                : command.operation === 'replaceConfiguration' ? { ...reply, status: 'configurationCommitted',
                    configuration: { ...reply.configuration, status: 'ready', revision: 'config-2' } } : description;
        handleAuthentication = command => command.operation === 'continueConnect'
            ? { status: 'awaitingManual', attemptId: 'attempt-1' }
            : { status: 'configurationRequired', attemptId: 'attempt-1', target: configurationTarget, missingFieldIds: [] };
        installApprovalBoundary();
        await installNativeConfigurationAttemptBoundary();
        if (revision !== null) platform.confirm.mockResolvedValue(false);
        const screen = await renderScreen(element());
        await pressReadyAction(screen);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
        const submission = screen.pressByTestIdAsync('connected-account-configuration:save');
        if (revision === null) {
            await submission;
            await vi.waitFor(() => expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration',
                target: { kind: 'attempt', attemptId: 'attempt-1' }, expectedRevision: null,
                values: { endpoint: 'https://new.example' }, secretValues: {} }));
            expect(platform.confirm).not.toHaveBeenCalled();
            expect(authenticationCommands).toContainEqual({ operation: 'continueConnect', attemptId: 'attempt-1', expectedConfigurationRevision: 'config-2' });
        } else {
            await submission;
            expect(platform.confirm).toHaveBeenCalledTimes(1);
            expect(controlCommands.some(command => command.operation === 'replaceConfiguration')).toBe(false);
        }
        await screen.unmount();
        await submission;
    });

    it('reads, saves and continues configuration with exact managed targets and no disclosed secret', async () => {
        waiveConfigurationConfirmation();
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [configuredMode] } } });
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? configurationReply
                : command.operation === 'replaceConfiguration'
                    ? { ...configurationReply, status: 'configurationCommitted', configuration: { ...configurationReply.configuration, status: 'ready', revision: 'config-2' } }
                    : description;
        handleAuthentication = (command) => command.operation === 'continueConnect'
            ? { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'new-account' } }
            : { status: 'configurationRequired', attemptId: 'attempt-1', target: configurationTarget, missingFieldIds: [] };
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element());
        await pressReadyAction(screen);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:secret')!.props.value).toBe('');
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        await vi.waitFor(() => expect(onConnected, JSON.stringify({ rendered: screen.getTextContent(), controlCommands, authenticationCommands,
            httpPaths: httpRequests.map(request => request.pathname) })).toHaveBeenCalledWith({ service, accountId: 'new-account' }));
        expect(controlCommands).toContainEqual({ operation: 'readConfiguration', target: { kind: 'attempt', attemptId: 'attempt-1' } });
        expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: { kind: 'attempt', attemptId: 'attempt-1' },
            expectedRevision: 'config-1', values: { endpoint: 'https://new.example' }, secretValues: {} });
        expect(authenticationCommands).toContainEqual({ operation: 'continueConnect', attemptId: 'attempt-1', expectedConfigurationRevision: 'config-2' });
    });

    it('reconnects and continues only the requested qualified account after its configuration commit', async () => {
        waiveConfigurationConfirmation();
        const ref = { service, accountId: 'account-1' };
        const target = { kind: 'account' as const, account: ref, modeId: 'oauth' };
        installDescription({ ...described, accounts: [{ ref, status: 'needs_reauth', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: false, configurationRevision: 'config-1', scopes: [] }],
            descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [configuredMode] } },
        });
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? { ...configurationReply, target }
                : command.operation === 'replaceConfiguration'
                    ? { ...configurationReply, target, status: 'configurationCommitted', configuration: { ...configurationReply.configuration, status: 'ready', revision: 'config-2' } }
                    : description;
        handleAuthentication = (command) => command.operation === 'continueConnect'
            ? { status: 'connected', attemptId: 'attempt-1', account: ref }
            : { status: 'configurationRequired', attemptId: 'attempt-1', target, missingFieldIds: [] };
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <ConnectedAccountSetupController service={service} targetSelection={selection}
                panel={{ intent: { kind: 'reconnect', accountId: ref.accountId }, onConnected, onCancel }} />
        </InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith(ref));
        expect(authenticationCommands).toEqual([
            { operation: 'beginReconnect', account: ref },
            { operation: 'continueConnect', attemptId: 'attempt-1', expectedConfigurationRevision: 'config-2' },
        ]);
        expect(controlCommands).toContainEqual({ operation: 'readConfiguration', target: { kind: 'account', account: ref } });
        expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: { kind: 'account', account: ref },
            expectedRevision: 'config-1', values: { endpoint: 'https://new.example' }, secretValues: {} });
    });

    it.each(['add', 'reconnect'] as const)('keeps an account configuration draft while the same selected machine is temporarily unresolved (%s)', async (intent) => {
        waiveConfigurationConfirmation();
        const mode: PluginConnectedAccountAuthenticationModeV2 = {
            ...authentication.modes[0]!, configuration: configuredMode.configuration,
        };
        const ref = { service, accountId: 'account-1' };
        installDescription({ ...described, accounts: intent === 'reconnect' ? [{ ref, status: 'needs_reauth', authenticationModeId: mode.id,
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: false, configurationRevision: 'config-1', scopes: [] }] : [], descriptor: { ...described.descriptor,
            authentication: { defaultModeId: mode.id, modes: [mode] } } });
        const target = intent === 'reconnect' ? { kind: 'account' as const, account: ref, modeId: mode.id }
            : { ...configurationTarget, modeId: mode.id };
        const reply = { ...configurationReply, target, mode };
        handleControl = command => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? reply
                : command.operation === 'replaceConfiguration' ? { ...reply, status: 'configurationCommitted',
                    configuration: { ...reply.configuration, status: 'ready', revision: 'config-2' } }
                    : description;
        handleAuthentication = command => command.operation === 'submitManual'
            ? { status: 'connected', attemptId: 'attempt-1', account: ref }
            : command.operation === 'continueConnect' ? { status: 'awaitingManual', attemptId: 'attempt-1' }
                : { status: 'configurationRequired', attemptId: 'attempt-1', target, missingFieldIds: [] };
        const selected = { ...selection, resolveExecutionTarget: () => resolveFreshMachineAdministrationExecutionTarget(selection.selectedTarget) };
        await installNativeConfigurationAttemptBoundary();
        const setup = () => <InjectedAuthProvider credentials={null}>
            <ConnectedAccountSetupController service={service} targetSelection={selected}
                panel={{ intent: intent === 'reconnect' ? { kind: 'reconnect', accountId: ref.accountId } : { kind: 'add' }, onConnected, onCancel }} />
        </InjectedAuthProvider>;
        const screen = await renderScreen(setup());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://unsaved.example'));
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-configured-token'));
        const state = storage.getState();
        const inventory = { isDataReady: state.isDataReady, machines: state.machines,
            machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId };
        await act(async () => storage.setState({ isDataReady: false, machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} }));
        expect(selected.resolveExecutionTarget()).toBeNull();
        await screen.update(setup());
        expect(screen.findHostByTestId('connected-account-configuration:endpoint')?.props.value).toBe('https://unsaved.example');
        // No fresh execution target: retaining a form cannot authorize a write.
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(controlCommands.some(command => command.operation === 'replaceConfiguration')).toBe(false);
        await act(async () => storage.setState(inventory));
        await screen.update(setup());
        if (intent === 'reconnect') {
            expect(screen.findHostByTestId('connected-account-configuration:endpoint')?.props.value).toBe('https://unsaved.example');
            await screen.pressByTestIdAsync('connected-account-manual:submit');
        }
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith(ref));
        expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: intent === 'reconnect'
            ? { kind: 'account', account: ref } : { kind: 'attempt', attemptId: 'attempt-1' },
            expectedRevision: 'config-1', values: { endpoint: 'https://unsaved.example' }, secretValues: {} });
        expect(authenticationCommands).toEqual([
            intent === 'reconnect' ? { operation: 'beginReconnect', account: ref }
                : { operation: 'beginConnect', service, modeId: mode.id },
            { operation: 'continueConnect', attemptId: 'attempt-1', expectedConfigurationRevision: 'config-2' },
            { operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'synthetic-configured-token' } },
        ]);
    });

    describe('step cue', () => {
        const stepOf = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findHostByTestId('connected-account-setup-steps')?.props.accessibilityValue;

        it('saves manual settings and credentials in one form without a separate step cue', async () => {
            waiveConfigurationConfirmation();
            const mode: PluginConnectedAccountAuthenticationModeV2 = { ...authentication.modes[0]!, configuration: configuredMode.configuration };
            installDescription({ ...described, descriptor: { ...described.descriptor, authentication: { defaultModeId: mode.id, modes: [mode] } } });
            const target = { ...configurationTarget, modeId: mode.id };
            const reply = { ...configurationReply, target, mode };
            handleControl = command => command.operation === 'listPendingAttempts'
                ? { status: 'pendingAttempts', attempts: [] }
                : command.operation === 'readConfiguration' ? reply
                    : command.operation === 'replaceConfiguration' ? { ...reply, status: 'configurationCommitted',
                        configuration: { ...reply.configuration, status: 'ready', revision: 'config-2' } }
                        : description;
            handleAuthentication = command => command.operation === 'submitManual'
                ? { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'configured-account' } }
                : command.operation === 'continueConnect' ? { status: 'awaitingManual', attemptId: 'attempt-1' }
                    : { status: 'configurationRequired', attemptId: 'attempt-1', target, missingFieldIds: [] };
            await installNativeConfigurationAttemptBoundary();
            const screen = await renderScreen(element());
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
            expect(stepOf(screen)).toBeUndefined();
            await act(async () => {
                screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://configured.example.test');
                screen.changeTextByTestId('connected-account-manual:token', 'synthetic-configured-token');
            });
            await screen.pressByTestIdAsync('connected-account-manual:submit');
            await vi.waitFor(() => expect(onConnected, JSON.stringify({ authentication: authenticationCommands,
                controls: controlCommands.map(command => command.operation), rendered: screen.getTextContent() })).toHaveBeenCalledWith({ service, accountId: 'configured-account' }));
            expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: { kind: 'attempt', attemptId: 'attempt-1' },
                expectedRevision: 'config-1', values: { endpoint: 'https://configured.example.test' }, secretValues: {} });
            expect(authenticationCommands).toContainEqual({ operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'synthetic-configured-token' } });
        });

        it('shows no cue on a one-step sign-in', async () => {
            installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
                defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                    fields: [{ id: 'token', title: 'API key', secret: true, schema: { type: 'string', minLength: 1 } }] }],
            } } });
            handleAuthentication = () => ({ status: 'awaitingManual', attemptId: 'attempt-1' });
            const screen = await manualScreen();
            expect(stepOf(screen)).toBeUndefined();
        });
    });

    it.each(['controller', 'page', 'inline', 'inline-offer'] as const)('retains the email-shaped draft through a choice, target loss and options refresh at the real setup owner (%s)', async (host) => {
        waiveConfigurationConfirmation();
        if (host === 'inline' || host === 'inline-offer') {
            // Window geometry is the native boundary; the actual inline host,
            // catalog projection, setup panel and controller all remain real.
            const native = await import('react-native');
            vi.spyOn(native, 'useWindowDimensions').mockReturnValue({ width: 1440, height: 900, scale: 1, fontScale: 1 });
        }
        // Use the real published descriptor, under the external-plugin fixture's
        // identity: the host must not special-case the bundled email plugin.
        const mode = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.channel.email/email-imap-smtp']!
            .descriptor.authentication.modes.find(candidate => candidate.id === 'password')!;
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: mode.id, modes: [mode] } } });
        const target = { ...configurationTarget, modeId: mode.id };
        let readMode = mode;
        const replacement = deferredReply();
        const reply = () => ({ ...configurationReply, target, mode: readMode,
            configuration: { ...configurationReply.configuration, values: {}, configuredSecretFieldIds: [] } });
        handleControl = command => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? reply()
                : command.operation === 'replaceConfiguration' ? replacement.promise
                    : description;
        handleAuthentication = command => command.operation === 'continueConnect'
            ? { status: 'awaitingManual', attemptId: 'attempt-1' }
            : command.operation === 'submitManual' ? { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'email-account' } }
            : { status: 'configurationRequired', attemptId: 'attempt-1', target, missingFieldIds: [] };
        await installNativeConfigurationAttemptBoundary();
        let misbound = false;
        let selected = { ...selection, resolveExecutionTarget: () => {
            const fresh = resolveFreshMachineAdministrationExecutionTarget(selection.selectedTarget);
            return fresh && misbound ? { ...fresh, target: { ...fresh.target, machineId: 'wrong-machine' } } : fresh;
        } };
        const registryEntry = getConnectedServiceRegistrySnapshot().entries.find(entry => entry.service?.pluginId === service.pluginId
            && entry.service.localId === service.localId);
        if (!registryEntry) throw new Error('Expected the real email descriptor projection');
        let catalog: readonly ConnectedServiceSetupCatalogEntry[] = [{
            serviceKey: `${service.pluginId}/${service.localId}`, service, entry: registryEntry, legacyServiceId: null,
            label: 'Email', usedBy: [], usedByAgentIds: [], connectedCount: 0, section: 'tools', canAdd: true,
        }];
        let requestedTarget: ConnectedServiceSetupTarget = { kind: 'service', serviceKey: `${service.pluginId}/${service.localId}` };
        const handled = () => {};
        const inline = () => <InjectedAuthProvider credentials={null}>
            <ConnectedServicesConnectMore layout="section" request={requestedTarget} onRequestHandled={handled} onConnected={onConnected}
                targetSelection={selected} model={buildConnectedServicesIndexModel({ transport: 'advertised-v4',
                    entries: catalog.map(() => registryEntry),
                    qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
                    resolveLabel: entry => String(entry?.projectedTitle ?? ''), resolveFallbackEntry: () => null,
                    presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
                    agentUses: host === 'inline-offer' ? [{ title: 'Acme Agent', services: [service], defaults: [] }] : [] })} />
        </InjectedAuthProvider>;
        const setup = () => host === 'controller' ? element(selected) : host === 'inline' || host === 'inline-offer' ? inline() : <InjectedAuthProvider credentials={null}>
            <ConnectedServiceSetupPanel chrome="page" target={requestedTarget}
                catalog={catalog} targetSelection={selected} onTargetChange={() => {}} onClose={onCancel}
                onConnected={account => onConnected(account)} />
        </InjectedAuthProvider>;
        const screen = await renderScreen(setup());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:mailbox')).not.toBeNull());
        const entered = { imapHost: 'imap.example.test', imapPort: '39753', mailbox: 'wilson@example.test',
            sentFolder: 'My Sent', smtpHost: 'smtp.example.test', smtpPort: '37419', username: 'wilson-login', inboxFolder: 'Inbox/custom' };
        for (const [id, value] of Object.entries(entered)) {
            await act(async () => screen.changeTextByTestId(`connected-account-configuration:${id}`, value));
        }
        const securityChoice = () => screen.tree.findAllByType(DropdownMenu)
            .find(node => node.props.testID === 'connected-account-configuration:smtpSecurity')!;
        const assertDraft = () => {
            for (const [id, value] of Object.entries(entered)) {
                expect(screen.findHostByTestId(`connected-account-configuration:${id}`)?.props.value, id).toBe(value);
            }
            expect(securityChoice().props.selectedId).toBe(JSON.stringify('starttls'));
            expect(screen.findHostByTestId('connected-account-manual:password')?.props.value).toBe('synthetic-email-password');
        };
        await act(async () => securityChoice().props.onSelect(JSON.stringify('starttls')));
        await act(async () => screen.changeTextByTestId('connected-account-manual:password', 'synthetic-email-password'));
        assertDraft();
        const state = storage.getState();
        const inventory = { isDataReady: state.isDataReady, machines: state.machines,
            machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId };
        await act(async () => storage.setState({ isDataReady: false, machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} }));
        await screen.update(setup());
        expect(selected.resolveExecutionTarget()).toBeNull();
        assertDraft();
        await act(async () => storage.setState(inventory));
        await screen.update(setup());
        readMode = { ...mode, configuration: { ...mode.configuration!, fields: mode.configuration!.fields.map(field =>
            field.id === 'smtpSecurity' ? { ...field, presentation: { ...field.presentation,
                options: [...field.presentation!.options!].reverse() } } : field) } };
        // Mis-wiring negative: retaining values never lends authority to a
        // resolver that returns another Machine. Recovery uses the same draft.
        misbound = true;
        selected = { ...selected };
        await screen.update(setup());
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(authenticationCommands).toEqual([]);
        expect(controlCommands.some(command => command.operation === 'replaceConfiguration')).toBe(false);
        assertDraft();
        misbound = false;
        selected = { ...selected };
        await screen.update(setup());
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(controlCommands.some(command => command.operation === 'replaceConfiguration')).toBe(true));
        // Catalog discovery can refresh while Replace/approval is in flight.
        // The chosen service and attempt still own this ongoing setup journey.
        catalog = [];
        await screen.update(setup());
        assertDraft();
        await act(async () => replacement.resolve({ ...reply(), status: 'configurationCommitted',
            configuration: { ...reply().configuration, status: 'ready', revision: 'config-2' } }));
        await vi.waitFor(() => expect(onConnected.mock.calls[0]?.[0]).toEqual({ service, accountId: 'email-account' }));
        if (host === 'inline' || host === 'inline-offer') expect(onConnected.mock.calls[0]?.[1]).toBe(`${service.pluginId}/${service.localId}`);
        expect(screen.findHostByTestId('connected-account-manual:password')).toBeNull();
        expect(authenticationCommands.filter(command => command.operation === 'beginConnect')).toHaveLength(1);
        expect(authenticationCommands).toContainEqual({ operation: 'continueConnect', attemptId: 'attempt-1', expectedConfigurationRevision: 'config-2' });
        expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: { kind: 'attempt', attemptId: 'attempt-1' },
            expectedRevision: 'config-1', values: { ...entered, imapPort: 39753, smtpPort: 37419, smtpSecurity: 'starttls' }, secretValues: {} });
        if (host !== 'controller') {
            // Retention follows the continuing user intent. Returning to the
            // catalog must still retire the old attempt and its secret form.
            requestedTarget = { kind: 'catalog' };
            await screen.update(setup());
            expect(screen.findHostByTestId('connected-account-manual:password')).toBeNull();
        }
    });

    it('does not deliver a queued manual submission to another Machine’s restored attempt', async () => {
        const other = createMachineFixture({ id: 'machine-other', activeAt: Date.now() });
        const restoredReply = deferredReply();
        let changedMachine = false;
        handleControl = command => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: changedMachine ? [{ attemptId: 'other-attempt', kind: 'manual', modeId: 'manual',
                intent: 'connect', phase: 'awaitingManual', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 }] : [] }
            : description;
        handleAuthentication = command => command.operation === 'submitManual'
            ? { status: 'connected', attemptId: 'other-attempt', account: { service, accountId: 'other-machine-account' } }
            : command.operation === 'read' ? restoredReply.promise
                : { status: 'awaitingManual', attemptId: 'other-attempt' };
        const otherAddress = await installNativeConfigurationAttemptBoundary(other.id);
        const screen = await renderScreen(element({ ...selection, resolveExecutionTarget: () => null }, service, null));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-original-machine-key'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(authenticationCommands).toEqual([]);

        changedMachine = true;
        await otherAddress.acknowledge({ attemptId: 'other-attempt', kind: 'manual', phase: 'awaitingManual',
            createdAtMs: Date.now(), intent: 'connect', service, modeId: 'manual' });
        machineRows.push(createPlainMachineRowFixture({ id: other.id, accountId: 'account-a' }));
        await act(async () => storage.getState().applyMachines([...Object.values(storage.getState().machines), other], true,
            { sourceServerId: getActiveServerSnapshot().serverId }));
        observeMachinePresenceForTest({ serverId: account.home.id, accountId: 'account-a' }, [other.id]);
        const otherTarget = { ...selection.selectedTarget!, machineId: other.id };
        expect(resolveFreshMachineAdministrationExecutionTarget(otherTarget)?.machine.id).toBe(other.id);
        await screen.update(element({ ...selection, selectedTarget: otherTarget,
            resolveExecutionTarget: () => resolveFreshMachineAdministrationExecutionTarget(otherTarget) }, service, null));
        await vi.waitFor(() => expect(authenticationCommands, JSON.stringify({ controls: controlCommands.map(command => command.operation),
            rendered: screen.getTextContent() })).toContainEqual({ operation: 'read', attemptId: 'other-attempt' }));
        await act(async () => restoredReply.resolve({ status: 'awaitingManual', attemptId: 'other-attempt' }));
        expect(authenticationCommands.filter(command => command.operation === 'submitManual')).toEqual([]);
        expect(onConnected).not.toHaveBeenCalled();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-other-machine-key'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'other-machine-account' }));
        expect(authenticationCommands).toContainEqual({ operation: 'submitManual', attemptId: 'other-attempt',
            fields: { token: 'synthetic-other-machine-key' } });
        await screen.unmount();
    });

    it.each(['machine', 'home'] as const)('refuses a setup resolver mis-bound to another %s', async (mismatch) => {
        await installNativeConfigurationAttemptBoundary();
        const fresh = selection.resolveExecutionTarget()!;
        const misbound = { ...selection, resolveExecutionTarget: () => ({ ...fresh,
            target: { ...fresh.target, ...(mismatch === 'machine' ? { machineId: 'machine-other' } : { serverIdentityId: 'srv_other' }) },
            ...(mismatch === 'machine' ? { machine: createMachineFixture({ id: 'machine-other', activeAt: Date.now() }) } : {}),
        }) };
        const screen = await renderScreen(element(misbound));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-bound-key'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(authenticationCommands).toEqual([]);
        expect(controlCommands.filter(command => command.operation !== 'describeService')).toEqual([]);
        // Restore the same target's binding: the explicit submission can now
        // continue, using its retained credential exactly once.
        await screen.update(element());
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'new-account' }));
        expect(authenticationCommands).toEqual([
            { operation: 'beginConnect', service, modeId: 'manual' },
            { operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'synthetic-bound-key' } },
        ]);
    });

    it.each(['account'] as const)('edits established %s configuration without inferring reconnect or revealing configured secrets', async (scope) => {
        waiveConfigurationConfirmation();
        const ref = { service, accountId: 'account-1' };
        const mode: PluginConnectedAccountAuthenticationModeV2 = { ...configuredMode, configuration: { ...configuredMode.configuration!, scope, changeBehavior: 'refresh' } };
        const target = scope === 'account' ? { kind: 'account' as const, account: ref, modeId: 'oauth' }
            : { kind: 'service' as const, service, modeId: 'oauth' };
        const reply = { ...configurationReply, target, mode, configuration: { ...configurationReply.configuration, status: 'ready' as const } };
        installDescription({ ...described, accounts: [{ ref, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: 'config-1', scopes: [] }],
            descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [mode] } },
        });
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? reply
                : command.operation === 'replaceConfiguration'
                    ? { ...reply, status: 'configurationCommitted', configuration: { ...reply.configuration, revision: 'config-2' } }
                    : description;
        const screen = await focusedScreen();
        const configureId = scope === 'account' ? 'qualified-account-detail:configuration' : 'connected-service-configuration-settings:oauth';
        await vi.waitFor(() => expect(screen.findHostByTestId(configureId)).not.toBeNull());
        await screen.pressByTestIdAsync(configureId);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:secret')!.props.value).toBe('');
        await act(async () => {
            screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example');
            screen.changeTextByTestId('connected-account-configuration:secret', 'explicit-replacement');
        });
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        const controlTarget = scope === 'account' ? { kind: 'account', account: ref } : target;
        await vi.waitFor(() => expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: controlTarget,
            expectedRevision: 'config-1', values: { endpoint: 'https://new.example' }, secretValues: { secret: 'explicit-replacement' } }));
        expect(authenticationCommands).toEqual([]);
        expect(onConnected).not.toHaveBeenCalled();
    });

    it.each(['none', 'missing', 'reading', 'saving'] as const)('clears a service Saved Secret reference through Account CAS without opening its value (Machine: %s)', async selectedMachine => {
        const mode: PluginConnectedAccountAuthenticationModeV2 = { ...configuredMode,
            configuration: { scope: 'service', changeBehavior: 'refresh', fields: [configuredMode.configuration!.fields[0]!, { id: 'secret', title: 'Secret', schema: { type: 'string' }, secret: true }] } };
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: mode.id, modes: [mode] } } });
        const projected = { scopeKey: getActiveServerSnapshot().serverId, status: 'ready' as const, conflicts: [], errorReason: null,
            descriptors: [{ id: service.localId, serviceId: 'acme-work', pluginId: service.pluginId, title: 'Acme Work',
                provenance: 'external' as const, sourceKind: 'installed' as const, authentication: description.descriptor.authentication,
                capabilities: [], availability: { state: 'available' as const, reason: 'resolved' }, diagnostics: [] }] };
        installConnectedAccountDescriptorProjection(projected, captureActiveServerAccountScopeLifetime());
        let value = { v: 1 as const, entries: [{ service, modeId: mode.id, revision: 'config-1',
            values: { endpoint: 'https://old.example' }, secretRefs: { secret: formatSharedSavedSecretRefV1('configuration-secret') } as Record<string, string> }] };
        let revision = 1;
        let writes = 0;
        let materialReads = 0;
        let reading = false;
        let saving = false;
        let holdRead = false;
        const readGate = deferredReply();
        const saveGate = deferredReply();
        handleHttp = async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/saved-secrets/resources/materials') { materialReads += 1; return new Response('{}', { status: 503 }); }
            if (path === '/v1/account/saved-secrets/resources') return Response.json({ resources: [{
                ref: formatSharedSavedSecretRefV1('configuration-secret'), source: 'shared_resource', relationship: 'owner',
                name: 'Configuration key', kind: 'apiKey', encryptionMode: 'plain', ownerAccountId: 'account-a', revision: 1,
                materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                audience: { accounts: [], teams: [], groups: [] },
            }] });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`) {
                if (init?.method !== 'POST') {
                    if (holdRead) {
                        reading = true;
                        await readGate.promise;
                    }
                    return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'configurations', value } } });
                }
                const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'configurations') throw new Error('Expected Account configuration');
                expect(mutation.content.v.value.entries[0]?.values).toEqual({ endpoint: 'https://new.example' });
                expect(mutation.content.v.value.entries[0]?.secretRefs).toEqual({});
                if (selectedMachine === 'saving') {
                    saving = true;
                    await saveGate.promise;
                }
                writes += 1;
                value = { ...value, entries: mutation.content.v.value.entries.map(entry => ({ ...entry, values: { endpoint: String(entry.values.endpoint) } })) };
                return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
            }
            return new Response('{}', { status: 404 });
        };
        storage.getState().applyMachines([], true, { sourceServerId: getActiveServerSnapshot().serverId });
        machineRows = [];
        if (selectedMachine === 'none') storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: {} });
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', connectedAccountsV4: [
            QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'account-1' }, status: 'connected',
                authenticationModeId: mode.id, revisionSemantics: 'revisioned', credentialRevision,
                configurationReady: true, configurationRevision: null, scopes: [] }),
        ] });
        storage.getState().applySettings({ ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'connectedServices.configuration.replace': ['ui'] } }),
        }, 2);
        platform.params = { ...service, accountId: 'account-1' };
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedAccountServiceView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-configuration-settings:oauth'),
            JSON.stringify({ rendered: screen.getTextContent(), httpPaths: httpRequests.map(request => request.pathname) })).not.toBeNull());
        const changeMachine = async (machineId: string) => {
            await act(async () => storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: {
                [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: {
                    serverIdentityId: account.home.serverIdentityId!, machineId,
                },
            } }));
        };
        await screen.pressByTestIdAsync('connected-service-configuration-settings:oauth');
        await vi.waitFor(() => {
            expect(materialReads).toBe(0);
            expect(screen.findHostByTestId('connected-account-configuration:endpoint'),
                JSON.stringify({ rendered: screen.getTextContent(), httpPaths: httpRequests.map(request => request.pathname) })).not.toBeNull();
        });
        if (selectedMachine === 'reading') {
            value = { ...value, entries: value.entries.map(entry => ({ ...entry, revision: 'config-reloaded',
                values: { endpoint: 'https://reloaded.example' } })) };
            holdRead = true;
            await screen.pressByTestIdAsync('connected-service-configuration-settings:oauth');
            try {
                await vi.waitFor(() => expect(reading).toBe(true));
                await changeMachine('changed-during-read');
            } finally {
                holdRead = false;
                await act(async () => readGate.resolve(null));
            }
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')?.props.value).toBe('https://reloaded.example'));
        }
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:secret:clear')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account-configuration:secret:clear');
        expect(writes).toBe(0);
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
        if (selectedMachine === 'missing') {
            await changeMachine('other-missing-machine');
            expect(screen.findHostByTestId('connected-account-configuration:endpoint')?.props.value).toBe('https://new.example');
        }
        const pendingSave = screen.pressByTestIdAsync('connected-account-configuration:save');
        if (selectedMachine === 'saving') {
            try {
                await vi.waitFor(() => expect(saving).toBe(true));
                await changeMachine('changed-during-save');
                expect(screen.findHostByTestId('connected-account-configuration:save')?.props.disabled).toBe(true);
            } finally { await act(async () => saveGate.resolve(null)); }
        }
        await pendingSave;
        await vi.waitFor(() => expect(writes).toBe(1));
        expect(materialReads).toBe(0);
        if (selectedMachine === 'none') expect(controlCommands).toEqual([]);
        else expect(controlCommands.every(command => command.operation === 'describeService')).toBe(true);
        expect(authenticationCommands).toEqual([]);
        expect(value.entries[0]!.values.endpoint).toBe('https://new.example');
    });

    it.each(['account', 'attempt'] as const)('retires a native %s configuration draft when its selected Machine changes', async targetKind => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: configuredMode.id, modes: [configuredMode] } } });
        const target = targetKind === 'account'
            ? { kind: 'account' as const, account: { service, accountId: 'account-1' }, modeId: configuredMode.id }
            : configurationTarget;
        const reply = { ...configurationReply, target };
        handleControl = command => command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? reply : description;
        handleAuthentication = () => ({ status: 'configurationRequired', attemptId: 'attempt-1', target, missingFieldIds: [] });
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element(selection, service, configuredMode.id));
        await pressReadyAction(screen);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://old-machine-draft.example'));
        handleAuthentication = () => ({ status: 'awaitingOAuth', attemptId: 'new-machine-attempt',
            authorizationUrl: 'https://example.test/oauth', callbackUrl: 'http://127.0.0.1:4000/auth/callback' });
        const execution = selection.resolveExecutionTarget()!;
        const nextTarget = { ...execution.target, machineId: 'other-machine' };
        await screen.update(element({ ...selection, selectedTarget: nextTarget,
            resolveExecutionTarget: () => ({ ...execution, target: nextTarget, machine: { ...execution.machine, id: nextTarget.machineId } }),
        }, service, configuredMode.id));
        expect(screen.findHostByTestId('connected-account-configuration:endpoint')).toBeNull();
        expect(controlCommands.some(command => command.operation === 'replaceConfiguration')).toBe(false);
        expect(onConnected).not.toHaveBeenCalled();
    });

    it.each(['readConfiguration', 'replaceConfiguration'] as const)('retires a pending native %s when its selected Machine changes', async operation => {
        waiveConfigurationConfirmation();
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: configuredMode.id, modes: [configuredMode] } } });
        const pending = deferredReply();
        const committed = { ...configurationReply, status: 'configurationCommitted',
            configuration: { ...configurationReply.configuration, status: 'ready', revision: 'config-2' } };
        handleControl = command => command.operation === operation ? pending.promise
            : command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] }
                : command.operation === 'readConfiguration' ? configurationReply : description;
        handleAuthentication = () => ({ status: 'configurationRequired', attemptId: 'attempt-1', target: configurationTarget, missingFieldIds: [] });
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element(selection, service, configuredMode.id));
        await pressReadyAction(screen);
        try {
            if (operation === 'replaceConfiguration') {
                await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
                await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://old-machine-draft.example'));
                await screen.pressByTestIdAsync('connected-account-configuration:save');
            }
            await vi.waitFor(() => expect(controlCommands.some(command => command.operation === operation), screen.getTextContent()).toBe(true));
            handleAuthentication = () => ({ status: 'awaitingOAuth', attemptId: 'new-machine-attempt',
                authorizationUrl: 'https://example.test/oauth', callbackUrl: 'http://127.0.0.1:4000/auth/callback' });
            const execution = selection.resolveExecutionTarget()!;
            const nextTarget = { ...execution.target, machineId: 'other-machine' };
            await screen.update(element({ ...selection, selectedTarget: nextTarget,
                resolveExecutionTarget: () => ({ ...execution, target: nextTarget, machine: { ...execution.machine, id: nextTarget.machineId } }),
            }, service, configuredMode.id));
            await act(async () => pending.resolve(operation === 'readConfiguration' ? configurationReply : committed));
            expect(screen.findHostByTestId('connected-account-configuration:endpoint')).toBeNull();
            expect(authenticationCommands.some(command => command.operation === 'continueConnect')).toBe(false);
            expect(onConnected).not.toHaveBeenCalled();
        } finally { pending.resolve(operation === 'readConfiguration' ? configurationReply : committed); await screen.unmount(); }
    });

    it('preserves an invalid configuration draft without claiming a successful reconnect', async () => {
        waiveConfigurationConfirmation();
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [configuredMode] } } });
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? configurationReply
                : command.operation === 'replaceConfiguration' ? { status: 'unavailable', code: 'connected_account_configuration_invalid' } : description;
        handleAuthentication = () => ({ status: 'configurationRequired', attemptId: 'attempt-1', target: configurationTarget, missingFieldIds: [] });
        await installNativeConfigurationAttemptBoundary();
        const screen = await renderScreen(element());
        await pressReadyAction(screen);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint'),
            JSON.stringify({ rendered: screen.getTextContent(), controlCommands, authenticationCommands })).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://unsaved.example'));
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:endpoint')!.props.value).toBe('https://unsaved.example');
        await screen.pressByTestIdAsync('connected-account:error-details-toggle');
        expect(screen.getTextContent()).toContain('connected_account_configuration_invalid');
        expect(controlRequestIds.at(-1)).toEqual(expect.any(String));
        expect(screen.getTextContent()).toContain(controlRequestIds.at(-1)!);
        expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: { kind: 'attempt', attemptId: 'attempt-1' },
            expectedRevision: 'config-1', values: { endpoint: 'https://unsaved.example' }, secretValues: {} });
        expect(authenticationCommands.some((command) => command.operation === 'continueConnect')).toBe(false);
        expect(onConnected).not.toHaveBeenCalled();
    });

    it('does not authorize service configuration through a retired descriptor lifetime', async () => {
        const mode: PluginConnectedAccountAuthenticationModeV2 = { ...configuredMode, configuration: { ...configuredMode.configuration!, scope: 'service' } };
        const target = { kind: 'service' as const, service, modeId: 'oauth' };
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [mode] } },
            accounts: [{ ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'oauth',
                revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [] }],
        });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing descriptor Account lifetime');
        const projection = { scopeKey: lifetime.scope.serverId, status: 'ready' as const, conflicts: [], errorReason: null,
            descriptors: [{ id: service.localId, serviceId: 'acme-work', pluginId: service.pluginId, title: 'Acme Work',
                provenance: 'external' as const, sourceKind: 'installed' as const, authentication: description.descriptor.authentication,
                capabilities: [], availability: { state: 'available' as const, reason: 'resolved' }, diagnostics: [] }] };
        installConnectedAccountDescriptorProjection(projection, lifetime);
        expect(getAccountConnectedServiceConfigurationMode(target, lifetime.scope)).toEqual(mode);
        retireConnectedAccountDescriptorProjection(lifetime);
        // The AppShell may retain presentation facts, but it has not admitted them
        // under the new descriptor lifecycle. They are not configuration authority.
        installConnectedAccountDescriptorProjection(projection);
        storage.getState().applySettings({ ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'connectedServices.configuration.replace': ['ui'] } }),
        }, 2);
        handleControl = (command) => command.operation === 'readConfiguration'
            ? { ...configurationReply, target, mode, occurrenceId: 'retired-occurrence', configuration: { ...configurationReply.configuration, status: 'ready' } }
            : command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] } : description;
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-configuration-settings:oauth')).not.toBeNull());
        // Canonical text boundary emits keys: this is the displayed blocked state, not copy wording.
        expect(JSON.stringify(screen.tree.toJSON())).toContain('common.blocked');
        // Service configuration belongs to the Account catalog. A descriptor without
        // its current Account lifetime cannot authorize a native read as a fallback.
        expect(controlCommands.filter(command => command.operation === 'readConfiguration')).toEqual([]);
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId };
        for (const [actionId, input] of [
            ['connectedServices.configuration.get', { service, modeId: mode.id }],
            ['connectedServices.configuration.replace', { service, modeId: mode.id, expectedRevision: 'config-1',
                values: { endpoint: 'https://unadmitted.example' }, secretValues: {} }],
        ] as const) {
            expect(await createDefaultActionExecutor().execute(actionId, input, context))
                .toMatchObject({ ok: false, errorCode: 'connected_account_configuration_target_unavailable' });
        }
        expect(httpRequests.filter(request => request.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`)).toEqual([]);
        expect(controlCommands.filter(command => command.operation === 'replaceConfiguration')).toEqual([]);
        expect(authenticationCommands).toEqual([]);
    });

    it.each(['exact_v0_2_1', 'revisioned_v2_v3'] as const)('keeps an unfenced %s legacy account passive at the real focused route', async (peerClass) => {
        const legacyServiceId = peerClass === 'exact_v0_2_1' ? 'openai-codex' : 'github';
        const compatibility: BuiltInLegacyConnectedAccountCompatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[legacyServiceId];
        const credentialKind = peerClass === 'exact_v0_2_1' ? 'oauth' : 'token';
        const modeId = compatibility.authenticationModeByCredentialKind[credentialKind]!;
        const mode: PluginConnectedAccountAuthenticationModeV2 = credentialKind === 'oauth'
            ? { id: modeId, kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }
            : { id: modeId, kind: 'manual', outcomeReconciliation: 'none', fields: authentication.modes[0].fields };
        installDescription({ ...described, service: compatibility.service,
            descriptor: { id: compatibility.service.localId, title: 'Legacy service', authentication: {
                defaultModeId: modeId, modes: [mode],
            } },
            operationTransport: { kind: 'legacy', peerClass, serviceId: legacyServiceId },
        }, legacyServiceId);
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', connectedServicesV2: [{
            serviceId: legacyServiceId, groups: [], profiles: [{ profileId: 'account-1', status: 'connected', kind: credentialKind,
                providerEmail: 'legacy@example.test', providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null }],
        }] });
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail'), JSON.stringify(screen.tree.toJSON())).not.toBeNull());
        for (const action of ['action:reconnect', 'action:disconnect', 'configuration']) {
            expect(screen.findHostByTestId(`qualified-account-detail:${action}`)).toBeNull();
        }
        expect(authenticationCommands).toEqual([]);
        expect(controlCommands.filter((command) => command.operation === 'revokeAccount')).toEqual([]);
    });

    it('opens the canonical credential Share sheet from the account header overflow', async () => {
        const source = { kind: 'connected_account' as const, serverId: account.home.id,
            account: { service, accountId: 'account-1' } };
        const show = vi.spyOn(Modal, 'show');
        show.mockClear();
        const screen = await renderScreen(<QualifiedAccountDetailView account={source.account} serviceLabel="Acme Work"
            presentation={{ primaryLabel: 'Work account', accessibilityLabel: 'Work account' }} shareSource={source} />);
        await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)
            .some(menu => menu.props.items.some((item: { id: string }) => item.id === 'share'))).toBe(true));
        const menu = screen.findAllByType(DropdownMenu).find(candidate => candidate.props.items.some((item: { id: string }) => item.id === 'share'))!;
        expect(menu.props.items.find((item: { id: string }) => item.id === 'share').testID).toBe('qualified-account-detail:share');
        await act(async () => { menu.props.onSelect('share'); });
        expect(show).toHaveBeenCalledOnce();
        expect(show).toHaveBeenCalledWith(expect.objectContaining({ props: {
            source, scope: getActiveServerAccountScope(),
        } }));
    });

    it('silently retains a signed-out account and its Sign in again action when removal approval is canceled', async () => {
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'account-1' },
            status: 'needs_reauth', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision,
            configurationReady: true, configurationRevision: null });
        const bindings = await seedPurposeDefaults({ kind: 'account', account: saved.ref });
        installDescription({ ...described, accounts: [saved], descriptor: { ...described.descriptor,
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'none' }] } } });
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', connectedAccountsV4: [saved] });
        const approvals = installApprovalBoundary();
        await transferPurposeDefaults();
        platform.confirm.mockResolvedValue(false);
        const screen = await focusedScreen(true);
        const signInId = 'qualified-account-detail:signed-out-banner:sign-in-again';
        await vi.waitFor(() => expect(screen.findHostByTestId(signInId)).not.toBeNull());
        const signIn = screen.findHostByTestId(signInId);
        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        expect(platform.confirm).toHaveBeenCalledOnce();
        expect(screen.findHostByTestId('connected-account:error')).toBeNull();
        expect(screen.findHostByTestId(signInId)).toBe(signIn);
        expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')?.props.loading).toBeFalsy();
        expect(controlCommands.filter(command => command.operation === 'revokeAccount')).toEqual([]);
        expect(authenticationCommands).toEqual([]);
        expect(approvals).toEqual([]);
        expect(purposeBoundary!.readBindings()).toEqual(bindings);
        expect(platform.replace).not.toHaveBeenCalled();
    });

    it.each([false, true])('settles the configured UI Ask through the single removal decision (accepted: %s)', async accepted => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'connectedServices.accounts.revoke': { approvalRequiredSurfaces: ['ui'] } },
        });
        const bindings = await seedPurposeDefaults({ kind: 'account', account: targetAccount.ref }, actionsSettingsV1);
        installDescription({ ...described, accounts: [targetAccount] });
        const approvals = installApprovalBoundary();
        handleControl = command => command.operation === 'revokeAccount'
            ? { status: 'revoked', account: targetAccount.ref, remoteStatus: 'remoteUnsupported' }
            : command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] } : description;
        await transferPurposeDefaults();
        platform.confirm.mockResolvedValue(accepted);
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).not.toBeNull());
        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        // The Action owner consumes this exact completed consent, including a
        // configured UI Ask, rather than asking the person the same thing again.
        expect(platform.confirm).toHaveBeenCalledOnce();
        expect(approvals).toEqual([]);
        expect(controlCommands.filter(command => command.operation === 'revokeAccount')).toEqual(accepted ? [{
            operation: 'revokeAccount', account: targetAccount.ref, cleanupGroupReferences: false,
            expectedCredentialRevision: credentialRevision,
        }] : []);
        if (!accepted) {
            expect(purposeBoundary!.readBindings()).toEqual(bindings);
            expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull();
        }
    });

    it.each([false, true])('reviews retained native resources before an explicit manual-responsibility revoke retry (confirmed: %s)', async (confirmed) => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'connectedServices.accounts.revoke': ['ui'] },
        });
        const bindings = await seedPurposeDefaults({ kind: 'account', account: targetAccount.ref }, actionsSettingsV1);
        installDescription({ ...described, accounts: [targetAccount] });
        storage.getState().applySettings({ ...storage.getState().settings, actionsSettingsV1 }, 3);
        const resource = createManagedResourceDependencyFixture();
        const renewedResource = createManagedResourceDependencyFixture(resource.intentRevision + 1);
        handleHttp = async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        const revokes: ControlCommand[] = [];
        handleControl = command => {
            if (command.operation === 'revokeAccount') {
                revokes.push(command);
                return command.managedResourceDispositions
                    ? command.managedResourceDispositions[0]?.expectedIntentRevision === resource.intentRevision
                        ? { status: 'removalReviewRequired', account: targetAccount.ref, resources: [renewedResource] }
                        : { status: 'outcomeUnknown', account: targetAccount.ref }
                    : { status: 'removalReviewRequired', account: targetAccount.ref, resources: [resource] };
            }
            return command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] } : description;
        };
        platform.confirm.mockResolvedValueOnce(true).mockResolvedValue(confirmed);
        await transferPurposeDefaults();
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).not.toBeNull());
        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        expect(revokes, JSON.stringify({ commands: controlCommands, requests: httpRequests.map(url => url.pathname) })).not.toHaveLength(0);
        expect(platform.confirm).toHaveBeenCalledTimes(confirmed ? 3 : 2);
        expect(revokes).toEqual([
            { operation: 'revokeAccount', account: targetAccount.ref, expectedCredentialRevision: credentialRevision, cleanupGroupReferences: false },
            ...(confirmed ? [resource, renewedResource].map(reviewed => ({
                operation: 'revokeAccount', account: targetAccount.ref, expectedCredentialRevision: credentialRevision,
                cleanupGroupReferences: false, managedResourceDispositions: [{ managedId: reviewed.managedId,
                    expectedIntentRevision: reviewed.intentRevision, expectedAllocation: reviewed.allocation,
                    expectedResource: reviewed.resource, expectedNativeOperationRef: reviewed.nativeOperationRef,
                    expectedRecovery: reviewed.recovery, responsibility: 'manual' }],
            })) : []),
        ]);
        expect(purposeBoundary!.readBindings()).toEqual(bindings);
        // An unknown native result opens the existing recovery flow, not the detail's
        // disconnect button. The exact Account references above remain retained.
        await vi.waitFor(() => expect(screen.findHostByTestId(confirmed ? 'connected-account:error:retry' : 'qualified-account-detail:action:disconnect'),
            JSON.stringify([...new Set(screen.tree.root.findAll(node => typeof node.props.testID === 'string').map(node => node.props.testID))])).not.toBeNull());
    });

    it('does not emit a captured Account revoke after credentials retire during transport setup without a caller signal', async () => {
        const targetAccount = { service, accountId: 'account-1' };
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'connectedServices.accounts.revoke': ['ui'] },
        });
        storage.getState().applySettings({ ...storage.getState().settings, actionsSettingsV1 }, 3);
        // Bootstrap intentionally hydrated the selected Machine. This exact
        // cold target must resolve its own transport from the real HTTP owner.
        const machineId = 'cold-revoke-machine';
        handleMachineReadId = machineId;
        let releaseMachine!: () => void;
        const machineResponse = new Promise<void>(resolve => { releaseMachine = resolve; });
        let transportAwaiting = false;
        const emissions: ControlCommand[] = [];
        // Keep real scoped fallback, Machine mode resolution, codec and
        // pre-emission callbacks. Only HTTP and Socket.IO are substituted.
        vi.mocked(apiSocket.machineRPC).mockRestore();
        installDisconnectedServerSocketBoundary(socket => {
            configureConnectedServerSocketBoundary(socket);
            socket.emitWithAck = vi.fn(async (_event: string, payload: unknown) => {
                if (!payload || typeof payload !== 'object' || !('params' in payload)) throw new Error('Expected a plain Machine RPC request');
                const request = ConnectedAccountControlCommandRequestSchema.parse(payload.params);
                emissions.push(request.command);
                // Plain socketRpcCodec decodes the relay's outer { ok, result } acknowledgement.
                return { ok: true, result: { status: 'outcomeUnknown', account: targetAccount } };
            });
            socket.timeout = vi.fn(() => socket);
        });
        handleMachineRead = async () => {
            transportAwaiting = true;
            await machineResponse;
            return Response.json({ machine: createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }) });
        };
        handleHttp = async rawUrl => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 3 });
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        const result = createDefaultActionExecutor().execute('connectedServices.accounts.revoke', {
            machineId, account: targetAccount, expectedCredentialRevision: credentialRevision, cleanupGroupReferences: false,
        }, { surface: 'ui', authority: 'present_user', serverId: account.home.id, expectedAccountId: 'account-a' });
        let settledResult: Awaited<typeof result> | undefined;
        void result.then(value => { settledResult = value; });
        try {
            await vi.waitFor(() => expect(transportAwaiting, JSON.stringify({ settledResult,
                requests: httpRequests.map(request => request.pathname) })).toBe(true));
            const replacement = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature` };
            expect(await TokenStorage.setCredentialsForServerUrl(account.home.serverUrl, { serverId: account.home.id }, replacement)).toBe(true);
        } finally {
            releaseMachine();
        }
        try {
            expect(await result).toMatchObject({ ok: false });
            // A retained Home socket may still use the original configured
            // boundary; count it as well as a newly created cold socket.
            expect([...controlCommands, ...emissions]).toEqual([]);
        } finally {
            installDisconnectedServerSocketBoundary();
            await TokenStorage.setCredentialsForServerUrl(account.home.serverUrl, { serverId: account.home.id }, account.credentials);
        }
    });

    it.each([
        { outcome: 'declined', poolCount: 1 },
        { outcome: 'revoked', poolCount: 1 },
        { outcome: 'conflict', poolCount: 1 },
        { outcome: 'revoked', poolCount: 2 },
        { outcome: 'declined', poolCount: 2 },
        { outcome: 'revoked', poolCount: 0 },
        { outcome: 'declined', poolCount: 0 },
    ] as const)('cleans only the exact account group references after explicit confirmation ($outcome, $poolCount loaded pools)', async ({ outcome, poolCount }) => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [], displayName: 'Work account',
        };
        const otherAccount = { ...targetAccount, ref: { service, accountId: 'account-2' } };
        const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1,
            ref: { service, groupId: 'work-pool' }, incarnation: 'pool-life', displayName: 'Work pool',
            policy: {}, activeConnectedAccountId: targetAccount.ref.accountId, generation: 1, runtimeStateRevision: 0,
            state: {}, createdAt: 0, updatedAt: 0,
            members: [{ v: 1, connectedAccountId: targetAccount.ref.accountId, priority: 0, enabled: true, state: {}, createdAt: 0, updatedAt: 0 }],
        });
        const poolGroups = [group, { ...group, ref: { service, groupId: 'fallback-pool' }, displayName: 'Fallback pool' }].slice(0, poolCount);
        const features = createRootLayoutFeaturesResponse({
            features: { connectedServices: { enabled: true, accountGroups: { enabled: true } } },
            capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: true } } },
        });
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1 });
        const bindings = await seedPurposeDefaults({ kind: 'account', account: targetAccount.ref }, actionsSettingsV1);
        installDescription({ ...described, accounts: [targetAccount, otherAccount] });
        // Default destructive confirmation stays real: the pool question is
        // the one designed confirmation, rather than a second generic Ask.
        storage.getState().applySettings({ ...storage.getState().settings, actionsSettingsV1 }, 3);
        handleHttp = async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v4/connect/qualified/groups') return Response.json({ groups: poolGroups });
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(features);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        handleControl = (command) => {
            if (command.operation === 'revokeAccount') {
                if (poolCount > 0 && !command.cleanupGroupReferences || outcome === 'conflict') return { status: 'conflict', code: 'connect_credential_referenced_by_group' };
                description = { ...description, accounts: [otherAccount] };
                return { status: 'revoked', account: targetAccount.ref, remoteStatus: 'remoteUnsupported' };
            }
            return command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] } : description;
        };
        platform.confirm.mockResolvedValueOnce(outcome !== 'declined');
        await transferPurposeDefaults();
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features } });
        await publishServedPoolGroups();
        const screen = await focusedScreen(true);
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).not.toBeNull());
        if (poolCount > 0) expect(screen.findByTestId('qualified-account-detail:action:leave-pool:work-pool')).not.toBeNull();
        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        await vi.waitFor(() => expect(platform.confirm).toHaveBeenCalledOnce());
        expect(platform.confirm).toHaveBeenCalledWith(
            'connectedServicesSettings.detailRemoveAccount',
            [poolCount === 1 ? t('connectedServicesSettings.detailRemovePooledConfirmNamed', { pool: 'Work pool' })
                : poolCount > 0 ? t('connectedServicesSettings.detailRemovePooledConfirm')
                    : t('connectedServicesSettings.detailRemoveAccountConfirm', { name: 'Work account' }),
                t('connectedServicesSettings.detailRemoveProviderSignOut', { provider: 'Acme Work' })].join('\n\n'),
            { confirmText: 'connectedServicesSettings.detailRemoveAccount', cancelText: 'common.cancel', destructive: true },
        );
        expect(controlCommands.filter((command) => command.operation === 'revokeAccount')).toEqual(
            outcome === 'declined' ? [] : [
                { operation: 'revokeAccount', account: targetAccount.ref, expectedCredentialRevision: credentialRevision, cleanupGroupReferences: poolCount > 0 },
            ],
        );
        const changedReferenceWrites = purposeBoundary!.rowWrites.filter(record =>
            JSON.stringify(record.value.bindings) !== JSON.stringify(bindings));
        if (outcome === 'revoked') {
            await vi.waitFor(() => expect(purposeBoundary!.readBindings()).toEqual(bindings.slice(2)));
            const settledReferenceWrites = purposeBoundary!.rowWrites.filter(record =>
                JSON.stringify(record.value.bindings) !== JSON.stringify(bindings));
            expect(settledReferenceWrites).not.toEqual([]);
            // A later normalization can acknowledge the same projection again;
            // every changed projection must preserve the unrelated credential.
            for (const write of settledReferenceWrites) {
                expect(write.value.bindings).toEqual(bindings.slice(2));
            }
        } else {
            expect(changedReferenceWrites).toEqual([]);
        }
        if (outcome === 'conflict') {
            expect(screen.findHostByTestId('connected-account:error')).not.toBeNull();
            expect(JSON.stringify(screen.tree.toJSON())).toContain('connectedServices.errors.credentialReferencedByGroup');
        }
        if (outcome === 'declined') expect(screen.findHostByTestId('connected-account:error')).toBeNull();
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(onConnected).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(purposeBoundary!.readBindings(),
            JSON.stringify({ tree: screen.tree.toJSON(), scope: storage.getState().settingsScope, version: storage.getState().settingsVersion }))
            .toEqual(outcome === 'revoked' ? bindings.slice(2) : bindings));
    });

    it('cleans only the exact account group references on Account-only removal without a post-success modal', async () => {
        await seedConnectedServicesPage();
        const saved = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'account-1' },
            status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision,
            configurationReady: true, configurationRevision: null, displayName: 'Stored identity',
            providerIdentity: { accountId: '1729528', email: 'stored@example.test' } });
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', connectedAccountsV4: [saved] });
        machineRows = [];
        storage.getState().applyMachines([], true, { sourceServerId: getActiveServerSnapshot().serverId });
        storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: {} });
        const settings = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'connectedServices.accounts.revoke': ['ui'] } });
        await seedPurposeDefaults({ kind: 'account', account: saved.ref }, settings);
        const previousHttp = handleHttp;
        const deletions: unknown[] = [];
        const resource = createManagedResourceDependencyFixture();
        handleHttp = async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v4/connect/qualified/credential' && init?.method === 'DELETE') {
                deletions.push({ ref: parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema,
                    url.searchParams.get('ref')!), revision: url.searchParams.get('expectedCredentialRevision'),
                    cleanup: url.searchParams.get('cleanupGroupReferences') });
                const dispositions = url.searchParams.get('managedResourceDispositions');
                if (!dispositions) return Response.json({ error: 'managed_resources_review_required', resources: [resource] }, { status: 409 });
                expect(parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountCredentialDeleteV4Schema.shape.managedResourceDispositions,
                    dispositions)).toEqual([{ managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
                    expectedAllocation: resource.allocation, expectedResource: resource.resource,
                    expectedNativeOperationRef: resource.nativeOperationRef, expectedRecovery: resource.recovery, responsibility: 'manual' }]);
                return Response.json({ success: true });
            }
            return previousHttp(rawUrl, init);
        };
        const screen = await focusedScreen(true);
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail'), screen.getTextContent()).not.toBeNull());
        expect(screen.getTextContent()).toContain('Stored identity');
        expect(screen.findHostByTestId('connected-account:error:retry')).toBeNull();
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).not.toBeNull());
        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        await vi.waitFor(() => expect(deletions).toEqual(Array.from({ length: 2 }, () => ({ ref: saved.ref, revision: credentialRevision, cleanup: 'false' }))));
        // The separate managed-resource responsibility review is retained.
        expect(platform.confirm).toHaveBeenCalledTimes(2);
        expect(platform.confirm).toHaveBeenCalledWith('connectedServicesSettings.detailRemoveAccount',
            expect.stringContaining('connectedServicesSettings.detailRemoveProviderSignOut'), expect.any(Object));
        expect(Modal.alert).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(platform.replace).toHaveBeenCalled());
        expect(authenticationCommands).toEqual([]);
        expect(controlCommands.filter(command => command.operation !== 'describeService')).toEqual([]);
    });

    it('opens Account pool detail without choosing a machine', async () => {
        const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1,
            ref: { service, groupId: 'work-pool' }, incarnation: 'pool-life', displayName: 'Work pool',
            policy: {}, activeConnectedAccountId: null, generation: 1, runtimeStateRevision: 0,
            state: {}, createdAt: 0, updatedAt: 0, members: [] });
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            features: { connectedServices: { enabled: true, accountGroups: { enabled: true } } },
            capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: false } } },
        }) } });
        handleHttp = async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v4/connect/qualified/groups') return Response.json({ groups: [group] });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return new Response('{}', { status: 404 });
        };
        storage.getState().applyMachines([], true, { sourceServerId: getActiveServerSnapshot().serverId });
        machineRows = [];
        platform.params = { ...service, groupId: group.ref.groupId };
        await publishServedPoolGroups();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedAccountServiceView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-pool-detail:delete')).not.toBeNull());
        expect(authenticationCommands).toEqual([]);
        expect(controlCommands.filter(command => command.operation !== 'describeService')).toEqual([]);
    });

    it.each([
        'member enable and disable', 'manage members add and remove', 'priority and active account', 'Behavior and Advanced policy',
        'advertised quota reset policy', 'quota-family selection', 'unavailable fallback capability',
        'pool definition rename', 'pool draft discard', 'pool draft create', 'open member account',
    ] as const)('P8 capability preservation checklist · %s', async capability => {
        const accounts = ['account-1', 'account-2', 'account-3'].map((accountId, index) => QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service, accountId }, status: 'connected', authenticationModeId: 'manual', configurationReady: true,
            configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision, displayName: `Workspace ${index + 1}`,
        }));
        installDescription({ ...described, accounts, descriptor: { ...described.descriptor,
            ...(capability === 'advertised quota reset policy' ? { recoveryCredits: { supported: true } } : {}),
        } });
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', connectedAccountsV4: accounts });
        let group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work-pool' },
            incarnation: 'pool-life', displayName: 'Work pool', policy: { autoSwitch: true, strategy: 'priority',
                ...(capability === 'quota-family selection' ? { quotaLimitSelection: { mode: 'selected', providerLimitIds: ['retained-limit'] } } : {}),
            },
            activeConnectedAccountId: 'account-1', generation: 1, runtimeStateRevision: 0, state: {}, createdAt: 0, updatedAt: 0,
            members: accounts.slice(0, 2).map((account, index) => ({ v: 1, connectedAccountId: account.ref.accountId,
                priority: (index + 1) * 100, enabled: true, state: {}, createdAt: 0, updatedAt: 0 })),
        });
        const drafting = capability === 'pool draft discard' || capability === 'pool draft create';
        let poolExists = !drafting;
        let createWrites = 0;
        const waivedActions = Object.fromEntries(['connectedServices.pools.create', 'connectedServices.pools.patch', 'connectedServices.pools.members.add',
            'connectedServices.pools.members.patch', 'connectedServices.pools.members.remove', 'connectedServices.pools.reorder',
            'connectedServices.pools.switchNow'].map(id => [id, ['ui']]));
        storage.getState().applySettings({ ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: waivedActions }) }, 3);
        handleHttp = async (url, init) => {
            const request = new URL(String(url));
            if (request.pathname === '/v1/features' || request.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                features: { sessions: { usageLimitRecovery: { enabled: true } }, connectedServices: { enabled: true, accountGroups: { enabled: true },
                    accountFallback: { enabled: capability !== 'unavailable fallback capability' },
                    autoQuotaReset: { enabled: true }, autoDisablePlanInvalid: { enabled: true }, poolQuotaLimitSelection: { enabled: true } } },
                capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: false } } },
            }));
            if (request.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (request.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-a', connectedAccountsV4: accounts });
            if (request.pathname === '/v4/connect/qualified/groups' && init?.method === 'POST') {
                const mutation = QualifiedConnectedAccountGroupCreateV4Schema.parse(JSON.parse(String(init.body)));
                expect(poolExists).toBe(false);
                group = QualifiedConnectedAccountGroupV4Schema.parse({ ...group, ref: { service: mutation.service, groupId: mutation.group.groupId },
                    displayName: mutation.group.displayName, policy: mutation.group.policy ?? {}, members: [], activeConnectedAccountId: null });
                poolExists = true;
                createWrites += 1;
                return Response.json({ group });
            }
            if (request.pathname === '/v4/connect/qualified/groups') return Response.json({ groups: poolExists ? [group] : [] });
            if (request.pathname === '/v4/connect/qualified/group/member' && init?.method === 'DELETE') {
                const mutation = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupMemberDeleteV4Schema, request.searchParams.get('mutation')!);
                expect(mutation.expectedGeneration).toBe(group.generation);
                group = { ...group, generation: group.generation + 1, members: group.members.filter(member => member.connectedAccountId !== mutation.connectedAccountId) };
                return Response.json({ group });
            }
            if ((request.pathname === '/v4/connect/qualified/group/member' && init?.method === 'PATCH')
                || (request.pathname === '/v4/connect/qualified/group/members' && init?.method === 'POST')) {
                const mutation = QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(JSON.parse(String(init.body)));
                expect(mutation.expectedGeneration).toBe(group.generation);
                const previous = group.members.find(member => member.connectedAccountId === mutation.connectedAccountId);
                const member = { v: 1 as const, connectedAccountId: mutation.connectedAccountId, priority: mutation.priority ?? previous?.priority ?? 300,
                    enabled: mutation.enabled ?? previous?.enabled ?? true, state: previous?.state ?? {}, createdAt: 0, updatedAt: 0 };
                group = { ...group, generation: group.generation + 1, members: previous
                    ? group.members.map(value => value === previous ? member : value) : [...group.members, member] };
                return Response.json({ group });
            }
            if (request.pathname === '/v4/connect/qualified/group' && init?.method === 'PATCH') {
                const mutation = QualifiedConnectedAccountGroupPatchV4Schema.parse(JSON.parse(String(init.body)));
                expect(mutation.expectedGeneration).toBe(group.generation);
                group = { ...group, generation: group.generation + 1, policy: mutation.policy ?? group.policy,
                    displayName: mutation.displayName === undefined ? group.displayName : mutation.displayName };
                return Response.json({ group });
            }
            if (request.pathname === '/v4/connect/qualified/group/active-account' && init?.method === 'POST') {
                const mutation = QualifiedConnectedAccountGroupActiveAccountV4Schema.parse(JSON.parse(String(init.body)));
                group = { ...group, activeConnectedAccountId: mutation.connectedAccountId, runtimeStateRevision: group.runtimeStateRevision + 1 };
                return Response.json({ group });
            }
            if (request.pathname === '/v4/connect/qualified/group') return Response.json({ group });
            return new Response('{}', { status: 404 });
        };
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            features: { sessions: { usageLimitRecovery: { enabled: true } }, connectedServices: { enabled: true, accountGroups: { enabled: true },
                accountFallback: { enabled: capability !== 'unavailable fallback capability' },
                autoQuotaReset: { enabled: true }, autoDisablePlanInvalid: { enabled: true }, poolQuotaLimitSelection: { enabled: true } } },
            capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: false } } },
        }) } });
        platform.params = drafting ? { ...service, newPool: '1' } : { ...service, groupId: group.ref.groupId };
        await publishServedPoolGroups();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><CollectionDraftTitleScope>
            <DraftRailRow /><ConnectedAccountServiceView />
        </CollectionDraftTitleScope></InjectedAuthProvider>);
        if (drafting) {
            await vi.waitFor(() => expect(screen.findByTestId('connected-services-pool-draft:create')).not.toBeNull());
            expect(createWrites).toBe(0);
            if (capability === 'pool draft discard') {
                await screen.pressByTestIdAsync('connected-services-pool-draft:discard');
                expect(poolExists).toBe(false);
                expect(createWrites).toBe(0);
                expect(platform.replace).toHaveBeenCalledWith(buildConnectedAccountSettingsRoute(service));
            } else {
                const name = screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-draft:name'
                    && typeof node.props.onDraftChange === 'function')[0];
                expect(name).toBeDefined();
                await act(async () => { name!.props.onDraftChange('P8 workspace pool'); });
                expect(screen.findHostByTestId('p8-draft-row')).not.toBeNull();
                expect(screen.findHostByTestId('p8-draft-row')!.findAll(node => node.children.includes('P8 workspace pool'))).not.toHaveLength(0);
                for (const id of ['account-1', 'account-2']) await screen.pressByTestIdAsync(`connected-services-pool-draft:member:${id}`);
                await screen.pressByTestIdAsync('connected-services-pool-draft:create');
                await vi.waitFor(() => expect(group.members.map(row => row.connectedAccountId), JSON.stringify({
                    requests: httpRequests.map(request => request.pathname), screen: screen.getTextContent(), group,
                })).toEqual(['account-1', 'account-2']));
                expect(createWrites).toBe(1);
                expect(group.displayName).toBe('P8 workspace pool');
                await vi.waitFor(() => expect(platform.replace).toHaveBeenCalledWith(
                    buildConnectedAccountSettingsRoute(service, { kind: 'group', groupId: group.ref.groupId })));
            }
            expect(authenticationCommands).toEqual([]);
            await screen.unmount();
            return;
        }
        const member = (accountId: string): React.ComponentProps<typeof PoolMemberRow> => {
            const row = screen.tree.root.findAll(node => node.props.testID === `connected-services-pool-detail:member:${accountId}`
                && Array.isArray(node.props.actions))[0];
            if (!row) throw new Error(`Missing composed member row ${accountId}`);
            // React test renderer exposes untyped props at the component boundary.
            return row.props as React.ComponentProps<typeof PoolMemberRow>;
        };
        await vi.waitFor(() => expect(screen.findByTestId('connected-services-pool-detail:member:account-1')).not.toBeNull());
        if (capability === 'member enable and disable') {
            for (const enabled of [false, true]) {
                await act(async () => { member('account-2').onEnabledChange?.(enabled); });
                await vi.waitFor(() => expect(group.members.find(row => row.connectedAccountId === 'account-2')?.enabled).toBe(enabled));
                await vi.waitFor(() => expect(member('account-2').enabled).toBe(enabled));
            }
        } else if (capability === 'manage members add and remove') {
            for (const ids of [['account-1', 'account-2', 'account-3'], ['account-1', 'account-3']]) {
                const field = screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-detail:members-select'
                    && Array.isArray(node.props.selectedIds) && typeof node.props.onCommit === 'function')[0];
                expect(field).toBeDefined();
                await act(async () => { await field!.props.onCommit(ids); });
                await vi.waitFor(() => expect(group.members.map(row => row.connectedAccountId).sort()).toEqual([...ids].sort()));
                await vi.waitFor(() => expect(screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-detail:members-select'
                    && Array.isArray(node.props.selectedIds))[0]?.props.selectedIds.slice().sort()).toEqual([...ids].sort()));
            }
        } else if (capability === 'priority and active account') {
            const action = member('account-1').actions.find(action => action.id.endsWith(':move-down'));
            expect(action?.disabled).not.toBe(true);
            await act(async () => { action!.onPress!(); });
            await vi.waitFor(() => expect([...group.members].sort((a, b) => a.priority - b.priority).map(row => row.connectedAccountId))
                .toEqual(['account-2', 'account-1']));
            await vi.waitFor(() => expect(member('account-2').onMakeActive).not.toBeNull());
            await act(async () => { member('account-2').onMakeActive?.(); });
            await vi.waitFor(() => expect(group.activeConnectedAccountId).toBe('account-2'));
        } else if (capability === 'Behavior and Advanced policy') {
            const strategy = screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-detail:strategy' && typeof node.props.onChange === 'function')[0];
            expect(strategy).toBeDefined();
            expect(strategy!.props.disabled, screen.getTextContent()).not.toBe(true);
            await act(async () => { strategy!.props.onChange('expiry_first'); });
            await vi.waitFor(() => expect(group.policy.strategy).toBe('expiry_first'));
            for (const autoSwitch of [false, true]) {
                await act(async () => { screen.findHostByTestId('connected-services-pool-detail:auto-switch:toggle')!.props.onValueChange(autoSwitch); });
                await vi.waitFor(() => expect(group.policy.autoSwitch).toBe(autoSwitch));
            }
            await screen.pressByTestIdAsync('connected-services-pool-detail:advanced:header');
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-pool-detail:auto-restore-primary:toggle')).not.toBeNull());
            await act(async () => { screen.findHostByTestId('connected-services-pool-detail:auto-restore-primary:toggle')!.props.onValueChange(true); });
            await vi.waitFor(() => expect(group.policy.autoRestorePrimaryWhenReset).toBe(true));
            for (const key of ['usageLimit', 'authExpired', 'accountChanged', 'refreshFailure'] as const) {
                const next = !group.policy.switchOn[key];
                await screen.pressByTestIdAsync(`connected-services-pool-detail:switch-on:${key}`);
                await vi.waitFor(() => expect(group.policy.switchOn[key]).toBe(next));
            }
            for (const [id, value, read] of [
                ['soft-switch-threshold', '17', () => group.policy.softSwitchRemainingPercent],
                ['stale-probe-after', '12', () => group.policy.probeIfSnapshotOlderThanMs / 60_000],
            ] as const) {
                const field = screen.tree.root.findAll(node => node.props.testID === `connected-services-pool-detail:${id}`
                    && typeof node.props.onCommit === 'function')[0];
                expect(field).toBeDefined();
                await act(async () => { await field!.props.onCommit(value); });
                await vi.waitFor(() => expect(read()).toBe(Number(value)));
            }
            // This external descriptor has no reset-consume capability. A server bit alone
            // must not create one; the real built-in reset Action's positive cases live with its owner.
            expect(screen.findHostByTestId('connected-services-pool-detail:auto-quota-reset:toggle')).toBeNull();
            await act(async () => { screen.findHostByTestId('connected-services-pool-detail:auto-disable-plan-invalid:toggle')!.props.onValueChange(true); });
            await vi.waitFor(() => expect(group.policy.autoDisablePlanInvalidAccounts).toBe(true));
            const recovery = screen.tree.root.findAllByType(DropdownMenu).find(node =>
                node.props.itemTrigger?.itemProps?.testID === 'connected-services-pool-detail:recovery-mode');
            expect(recovery).toBeDefined();
            await act(async () => { recovery!.props.onSelect('off'); });
            await vi.waitFor(() => expect(group.policy.recoveryMode).toBe('off'));
        } else if (capability === 'advertised quota reset policy') {
            for (const autoUseQuotaResetsWhenExhausted of [true, false]) {
                await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-pool-detail:auto-quota-reset:toggle')).not.toBeNull());
                await act(async () => { screen.findHostByTestId('connected-services-pool-detail:auto-quota-reset:toggle')!
                    .props.onValueChange(autoUseQuotaResetsWhenExhausted); });
                await vi.waitFor(() => expect(group.policy.autoUseQuotaResetsWhenExhausted).toBe(autoUseQuotaResetsWhenExhausted));
            }
            expect(authenticationCommands).toEqual([]);
        } else if (capability === 'quota-family selection') {
            const field = screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-detail:quota-limits'
                && node.props.selection?.mode === 'selected' && typeof node.props.onCommit === 'function')[0];
            expect(field?.props.candidates).toEqual([expect.objectContaining({ providerLimitId: 'retained-limit', unavailable: true })]);
            await act(async () => { field!.props.onCommit({ mode: 'all', providerLimitIds: [] }); });
            await vi.waitFor(() => expect(group.policy.quotaLimitSelection).toEqual({ mode: 'all', providerLimitIds: [] }));
        } else if (capability === 'unavailable fallback capability') {
            const strategy = screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-detail:strategy'
                && typeof node.props.onChange === 'function')[0];
            expect(strategy?.props.disabled).toBe(true);
            expect(member('account-2').onMakeActive).toBeNull();
            await act(async () => { strategy!.props.onChange('expiry_first'); });
            expect(group.policy.strategy).toBe('priority');
            expect(group.generation).toBe(1);
        } else if (capability === 'pool definition rename') {
            await screen.pressByTestIdAsync('connected-services-pool-detail:rename');
            await act(async () => screen.changeTextByTestId('connected-services-pool-detail:name-field', 'Shared workspace pool'));
            await screen.pressByTestIdAsync('connected-services-pool-detail:name-save');
            await vi.waitFor(() => expect(group.displayName).toBe('Shared workspace pool'));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Shared workspace pool'));
        } else {
            expect(member('account-1').onOpen).toBeTypeOf('function');
            await act(async () => { member('account-1').onOpen?.(); });
            expect(platform.navigate).toHaveBeenCalledWith(buildConnectedAccountSettingsRoute(service, { kind: 'account', accountId: 'account-1' }));
            expect(group.members).toHaveLength(2);
            expect(authenticationCommands).toEqual([]);
        }
        await screen.unmount();
    });

    it.each([
        ['default', 'row', false], ['default', 'row', true], ['ask', 'row', true],
        ['default', 'selection', false], ['default', 'selection', true], ['ask', 'selection', true],
    ] as const)('confirms pool member removal once before the existing Action (%s, %s, accepted: %s)', async (mode, entry, accepted) => {
        let group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1,
            ref: { service, groupId: 'work-pool' }, incarnation: 'pool-life', displayName: 'Work pool',
            policy: {}, activeConnectedAccountId: null, generation: 1, runtimeStateRevision: 0,
            state: {}, createdAt: 0, updatedAt: 0,
            members: [{ v: 1, connectedAccountId: 'account-1', priority: 0, enabled: true, state: {}, createdAt: 0, updatedAt: 0 }],
        });
        if (mode === 'ask') storage.getState().applySettings({ ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'connectedServices.pools.members.remove': { approvalRequiredSurfaces: ['ui'] },
            } }),
        }, 3);
        const approvals = installApprovalBoundary();
        const approvalHttp = handleHttp;
        const removed: URL[] = [];
        handleHttp = async (url, init) => {
            const request = new URL(String(url));
            if (request.pathname === '/v4/connect/qualified/groups') return Response.json({ groups: [group] });
            if (request.pathname === '/v4/connect/qualified/group/member' && init?.method === 'DELETE') {
                removed.push(request);
                group = { ...group, members: [], generation: group.generation + 1 };
                return Response.json({ group });
            }
            if (request.pathname === '/v4/connect/qualified/group') return Response.json({ group });
            return approvalHttp(url, init);
        };
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            features: { connectedServices: { enabled: true, accountGroups: { enabled: true } } },
            capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: false } } },
        }) } });
        platform.params = { ...service, groupId: group.ref.groupId };
        platform.confirm.mockResolvedValue(accepted);
        await publishServedPoolGroups();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedAccountServiceView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('connected-services-pool-detail:member:account-1')).not.toBeNull());
        if (entry === 'row') {
            const row = screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-detail:member:account-1'
                && Array.isArray(node.props.actions))[0];
            const action = (row?.props.actions as ItemAction[]).find(candidate => candidate.id.endsWith(':remove'));
            expect(action?.onPress).toBeTypeOf('function');
            await act(async () => { action!.onPress!(); });
        } else {
            const selection = screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-detail:members-select'
                && Array.isArray(node.props.selectedIds) && typeof node.props.onCommit === 'function')[0];
            expect(selection).toBeDefined();
            await act(async () => { await selection!.props.onCommit([]); });
        }
        if (!accepted) {
            expect(removed).toEqual([]);
            expect(group.members).toHaveLength(1);
            expect(approvals).toEqual([]);
        } else if (mode === 'default') {
            await vi.waitFor(() => expect(removed).toHaveLength(1));
            expect(group.members).toEqual([]);
            expect(approvals).toEqual([]);
        } else {
            await vi.waitFor(() => expect(approvals).toHaveLength(1));
            expect(approvals[0]).toMatchObject({ actionId: 'connectedServices.pools.members.remove', status: 'open' });
            expect(removed).toEqual([]);
            expect(group.members).toHaveLength(1);
        }
        expect(platform.confirm).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it.each(['cancelled', 'deleted', 'failed'] as const)('clears exact pool purpose defaults only after confirmed successful deletion (%s)', async (outcome) => {
        const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1,
            ref: { service, groupId: 'work-pool' }, incarnation: 'pool-life', displayName: 'Work pool',
            policy: ConnectedServiceAuthGroupPolicyV2Schema.parse({}), activeConnectedAccountId: null,
            generation: 1, runtimeStateRevision: 0, state: {}, createdAt: 0, updatedAt: 0, members: [],
        });
        const bindings = await seedPurposeDefaults({ kind: 'group', ...group.ref });
        QualifiedConnectedAccountGroupListResponseV4Schema.parse({ groups: [group] });
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            features: { connectedServices: { enabled: true, accountGroups: { enabled: true } } },
            capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: false } } },
        }) } });
        const deletedRequests: URL[] = [];
        let groupDeleted = false;
        handleHttp = async (url, init) => {
            const request = new URL(String(url));
            if (request.pathname === '/v4/connect/qualified/groups') {
                return Response.json({ groups: groupDeleted ? [] : [group] });
            }
            if (request.pathname === '/v4/connect/qualified/group' && init?.method === 'DELETE') {
                deletedRequests.push(request);
                if (outcome === 'failed') return Response.json({ error: 'connect_group_generation_conflict' }, { status: 409 });
                groupDeleted = true;
                return Response.json({ success: true });
            }
            if (request.pathname === '/v4/connect/qualified/group') {
                // A definite DELETE receipt alone cannot retire a ref that a
                // recreated pool now owns: model the server's exact absence.
                return groupDeleted
                    ? Response.json({ error: 'connect_group_not_found' }, { status: 404 })
                    : Response.json({ group });
            }
            if (request.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (request.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return new Response('{}', { status: 404 });
        };
        await transferPurposeDefaults();
        platform.params = { ...service, groupId: group.ref.groupId };
        platform.confirm.mockResolvedValue(outcome !== 'cancelled');
        await publishServedPoolGroups();
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedAccountServiceView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-pool-detail:delete'),
            JSON.stringify({ tree: screen.tree.toJSON(), requests: httpRequests.map((url) => url.pathname) })).not.toBeNull());
        await screen.pressByTestIdAsync('connected-services-pool-detail:delete');
        await vi.waitFor(() => expect(platform.confirm).toHaveBeenCalledOnce());
        if (outcome !== 'cancelled') await vi.waitFor(() => expect(deletedRequests).toHaveLength(1));
        if (outcome === 'failed') await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-pool-detail:error')).not.toBeNull());
        await vi.waitFor(() => expect(purposeBoundary!.readBindings())
            .toEqual(outcome === 'deleted' ? bindings.slice(2) : bindings));
        if (outcome === 'cancelled') {
            expect(deletedRequests).toEqual([]);
            expect(screen.findHostByTestId('connected-services-pool-detail:error')).toBeNull();
        }
    });

    it('reads the exact account quota even when V4 pools are disabled and their transport fails', async () => {
        const ref = { service, accountId: 'account-1' };
        const now = Date.now();
        const quota = QualifiedConnectedAccountQuotaResponseV4Schema.parse({
            ref,
            sourceResolution: { source: { ref, bindingKind: 'account' }, providerAccountId: 'provider-account', fetchedAt: now, staleAfterMs: 60_000,
                recordId: buildProviderAccountUsageRecordId({ providerId: 'acme', accountSubjectId: 'provider-account', subjectKind: 'account', quotaScope: 'account' }) },
            content: { t: 'plain', v: {
                v: 1, ref, activeAccountId: 'provider-account', fetchedAt: now, staleAfterMs: 60_000, planLabel: 'Pro', accountLabel: null,
                meters: [{ meterId: 'weekly', label: 'Weekly', used: 40, limit: 100, unit: 'count',
                    utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact' }],
            } },
            metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' },
        });
        expect(openQualifiedConnectedAccountQuotaResponseV4({ response: quota, expectedRef: ref })).toEqual(quota.content.t === 'plain' ? quota.content.v : null);
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({ features: {
            connectedServices: { enabled: true, accountGroups: { enabled: false } },
        } }) } });
        handleHttp = async (url) => new URL(String(url)).pathname === '/v4/connect/qualified/quotas'
            ? new Response(JSON.stringify(quota), { status: 200 })
            : new URL(String(url)).pathname === '/v4/connect/qualified/quotas/refresh'
                ? Response.json({ success: true })
                : new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        // Another live machine comes first in inventory; operations must use the page's exact target.
        storage.getState().applyMachines([
            createMachineFixture({ id: 'other-machine', activeAt: Date.now() }),
            createMachineFixture({ id: selection.selectedTarget!.machineId, activeAt: Date.now() }),
        ], true, { sourceServerId: getActiveServerSnapshot().serverId });
        installDescription({ ...described, accounts: [{ ref, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [] }] });
        platform.params = { ...service, accountId: ref.accountId };
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedAccountServiceView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('account-detail-usage:meter:weekly'), JSON.stringify({ requests: httpRequests, tree: screen.tree.toJSON() })).not.toBeNull());
        const quotaRequests = httpRequests.filter((url) => url.pathname === '/v4/connect/qualified/quotas');
        expect(quotaRequests.length).toBeGreaterThan(0);
        expect(quotaRequests.map((url) => parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, url.searchParams.get('ref')!)))
            .toEqual(quotaRequests.map(() => ref));
        expect(screen.findHostByTestId('qualified-account-detail:pools-empty')).toBeNull();
        // Wide account detail keeps its single Refresh action with Usage (O-SERVICES / s2svc:account).
        await screen.pressByTestIdAsync('account-detail-usage:refresh');
        await vi.waitFor(() => expect(httpRequests.some(url => url.pathname === '/v4/connect/qualified/quotas/refresh')).toBe(true));
        const refreshAdmission = vi.mocked(apiSocket.machineRPC).mock.calls.find(([, , payload]) => {
            const parsed = ConnectedAccountControlCommandRequestSchema.safeParse(payload);
            return parsed.success && parsed.data.command.operation === 'describeService';
        });
        expect(refreshAdmission?.[0]).toBe(selection.selectedTarget!.machineId);
        expect(onConnected).not.toHaveBeenCalled();
    });
});
