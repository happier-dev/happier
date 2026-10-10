import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope, captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readConnectedAccountCatalog } from '@/sync/api/account/apiConnectedAccountCatalog';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { ApprovalRequestV2 } from '@happier-dev/protocol';
import type { ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import {
    ConnectedAccountAuthenticationCommandRequestSchema,
    ConnectedAccountControlCommandRequestSchema,
    type ConnectedAccountAuthenticationCommandRequest,
    type ConnectedAccountControlCommandRequest,
    type ConnectedAccountDaemonControlResponse,
    type PluginConnectedAccountAuthenticationModeV2,
    type QualifiedConnectedAccountProfileV4,
    type BuiltInLegacyConnectedAccountCompatibility,
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    buildProviderAccountUsageRecordId,
    QualifiedConnectedAccountQuotaResponseV4Schema,
    QualifiedConnectedAccountRefSchema,
    QualifiedConnectedAccountProfileV4Schema,
    parseQualifiedConnectedAccountV4StructuredQueryValue,
    CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
    ConnectedAccountDaemonControlResponseSchema,
    openQualifiedConnectedAccountQuotaResponseV4,
    QualifiedConnectedAccountGroupV4Schema,
    QualifiedConnectedAccountGroupListResponseV4Schema,
    ConnectedServiceAuthGroupPolicyV1Schema,
    ActionsSettingsV1Schema,
    type QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';
import { ConnectedAccountSetupController, ConnectedAccountServiceView } from './ConnectedAccountServiceView';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
    ConnectedPresentationRowMutationV1Schema, type ConnectedPresentationRecordV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowMutationV1Schema,
    type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ANTHROPIC_API_KEY_INPUT_SCHEMA } from '../../../../../../../packages/plugins/claude/src/connectedAccounts/anthropicRuntime';

const platform = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>,
    confirm: vi.fn(async () => true),
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
// Keep the real machine picker beneath a deterministic portal/window measurement boundary.
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('expo-router', async () => {
    const mocked = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => platform.params }).module;
    const router = { ...mocked.router, canGoBack: () => false };
    return { ...mocked, router, useRouter: () => router };
});
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm: platform.confirm } }).module);
// No Markdown is rendered in this controller journey. Fail if this absent third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in account setup'); },
}));
installDisconnectedServerSocketBoundary();

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
    id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'providerCheck',
    configuration: {
        scope: 'account', changeBehavior: 'reconnect', fields: [
            { id: 'endpoint', title: 'Endpoint', secret: false, required: true, schema: { type: 'string', minLength: 1 } },
            { id: 'secret', title: 'Secret', secret: true, schema: { type: 'string' } },
        ],
    },
};
const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
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
    const controlCommands: ControlCommand[] = [];
    let description: typeof described;
    let handleAuthentication: WireHandler<AuthenticationCommand>;
    let handleControl: WireHandler<ControlCommand>;
    let handleHttp: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']>;
    let purposeBoundary: ReturnType<typeof installPurposeBoundary> | null;
    const httpRequests: URL[] = [];
    const onConnected = vi.fn();
    const onCancel = vi.fn();

    const element = (selected = selection, requestedService = service) => <InjectedAuthProvider credentials={null}>
        <ConnectedAccountSetupController service={requestedService} targetSelection={selected}
            panel={{ intent: { kind: 'add' }, onConnected, onCancel }} />
    </InjectedAuthProvider>;

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
        });
    }

    async function manualScreen() {
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        return screen;
    }

    async function focusedScreen(withAccountCredentials = false) {
        platform.params = { ...description.service, accountId: 'account-1' };
        return renderScreen(<InjectedAuthProvider credentials={withAccountCredentials ? account.credentials : null}><ConnectedAccountServiceView /></InjectedAuthProvider>);
    }

    function installAccountLabelBoundary(targetAccount: QualifiedConnectedAccountProfileV4, beforeWrite?: () => Promise<void>) {
        const savedProfile = { ...profileDefaults, id: 'account-a', connectedAccountsV4: [targetAccount] };
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
        return { readPresentation: () => presentation, readWriteSignal: () => writeSignal };
    }

    function installPurposeBoundary(bindings: Extract<ConnectedAccountCatalogRecordV1, { key: 'purposes' }>['value']['bindings']) {
        let record: Extract<ConnectedAccountCatalogRecordV1, { key: 'purposes' }> | null = null;
        let revision = 0;
        let settingsVersion = 3;
        let raw: Readonly<Record<string, unknown>> | null = null;
        const rowWrites: Array<Extract<ConnectedAccountCatalogRecordV1, { key: 'purposes' }>> = [];
        const source = () => raw ??= { ...storage.getState().settings, connectedAccountPurposeBindingsV1: { v: 1, bindings } };
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

    async function seedPurposeDefaults(target: QualifiedConnectedAccountPurposeBindingTargetV1) {
        const bindings = [
            { purpose: { consumer: { pluginId: 'custom.agent', localId: 'one' }, purpose: 'model' }, target },
            { purpose: { consumer: { pluginId: 'custom.agent', localId: 'two' }, purpose: 'model' }, target },
            { purpose: { consumer: { pluginId: 'custom.agent', localId: 'other' }, purpose: 'model' },
                target: { kind: 'account' as const, account: { service, accountId: 'account-2' } } },
        ];
        storage.getState().applySettings({ ...storage.getState().settings,
            connectedAccountPurposeBindingsV1: { v: 1, bindings },
        }, 2);
        purposeBoundary = installPurposeBoundary(bindings);
        return bindings;
    }

    async function transferPurposeDefaults() {
        const result = await readConnectedAccountCatalog({ serverId: account.home.id, accountId: 'account-a' }, 'purposes');
        expect(result.status).toBe('ready');
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
        platform.confirm.mockReset().mockResolvedValue(true);
        vi.mocked(Modal.confirm).mockImplementation(platform.confirm);
        authenticationCommands.length = 0;
        controlCommands.length = 0;
        httpRequests.length = 0;
        purposeBoundary = null;
        handleHttp = async () => new Response('{}', { status: 404 });
        handleAuthentication = (command) => command.operation === 'submitManual'
            ? { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'new-account' } }
            : command.operation === 'cancel'
                ? { status: 'cancelled', attemptId: command.attemptId }
                : { status: 'awaitingManual', attemptId: 'attempt-1' };
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : description;
        await adoptHomeProfile({ descriptor: { serverUrl: 'https://connected-account-setup.example.test',
            homeServerIdentityId: 'srv_connected_account_setup' }, source: 'manual' });
        account = await restoreServerAccountForTest({
            serverUrl: 'https://connected-account-setup.example.test', accountId: 'account-a',
            request: async (url, init) => {
                const parsed = new URL(String(url));
                httpRequests.push(parsed);
                return purposeBoundary?.request(parsed.pathname, init) ?? handleHttp(url, init);
            },
        });
        const active = getActiveServerSnapshot();
        storage.getState().activateProfileScope({ serverId: active.serverId, accountId: 'account-a' });
        await storage.getState().activateSettingsScope({ serverId: active.serverId, accountId: 'account-a' });
        expect(getActiveServerAccountScope()).toEqual({ serverId: active.serverId, accountId: 'account-a' });
        const machine = createMachineFixture({ activeAt: Date.now() });
        expect(account.home.serverIdentityId).toBe('srv_connected_account_setup');
        const target = { serverIdentityId: account.home.serverIdentityId!, machineId: machine.id };
        storage.getState().applyProfile({ ...profileDefaults, id: 'account-a' });
        storage.getState().applySettings({ ...settingsDefaults,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: target },
        }, 1);
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
            options?.onIssued?.();
            const control = ConnectedAccountControlCommandRequestSchema.safeParse(payload);
            if (control.success) {
                expect(method).toBe(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD);
                expect(control.data.machineId).toBe(machineId);
                controlCommands.push(control.data.command);
                const response = await handleControl(control.data.command);
                // RPC bytes are unknown at this genuine transport boundary; the real caller parses them.
                return response as R;
            }
            expect(method).toBe(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD);
            const request = ConnectedAccountAuthenticationCommandRequestSchema.parse(payload);
            expect(request.machineId).toBe(machineId);
            const { command } = request;
            authenticationCommands.push(command);
            return await handleAuthentication(command) as R;
        });
    });

    afterEach(async () => {
        installDisconnectedServerSocketBoundary();
        standardCleanup();
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
        await account?.dispose();
        vi.unstubAllGlobals();
        storage.getState().clearProfileScope();
    });

    it('starts and completes the recommended authentication through the exact daemon owner', async () => {
        const screen = await manualScreen();
        await act(async () => screen.findHostByTestId('connected-account-manual:token')!.props.onChangeText('secret-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'new-account' }));
        expect(authenticationCommands).toEqual([
            { operation: 'beginConnect', service, modeId: 'manual' },
            { operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'secret-token' } },
            { operation: 'cancel', attemptId: 'attempt-1' },
        ]);
    });

    it('names a guided key through the existing Account label preference only after connection succeeds', async () => {
        const keyService = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
        installDescription({ ...described, service: keyService }, 'anthropic');
        const boundary = installAccountLabelBoundary(QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service: keyService, accountId: 'new-key' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        }));
        handleAuthentication = (command) => command.operation === 'submitManual'
            ? { status: 'connected', attemptId: 'attempt-1', account: { service: keyService, accountId: 'new-key' } }
            : { status: 'awaitingManual', attemptId: 'attempt-1' };
        const screen = await renderScreen(element(selection, keyService));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:name')).not.toBeNull());
        await act(async () => {
            screen.changeTextByTestId('connected-account-manual:token', 'sk-ant-secret');
            screen.changeTextByTestId('connected-account-manual:name', 'Build server');
        });
        expect(boundary.readPresentation().entries).toEqual([]);
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(boundary.readPresentation().entries).toContainEqual({
            v: 1,
            subject: { kind: 'account', account: { service: keyService, accountId: 'new-key' } }, label: 'Build server',
        }));
        expect(authenticationCommands).toContainEqual({ operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'sk-ant-secret' } });
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

    it.each(['unselected', 'offline', 'foreign'] as const)('keeps captured Account detail and label editing available with an %s machine', async (machineState) => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        const boundary = installAccountLabelBoundary(targetAccount);
        if (machineState === 'unselected') storage.getState().applySettings({ ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: {},
        }, 2);
        else if (machineState === 'offline') {
            const machine = createMachineFixture({ id: selection.selectedTarget!.machineId, active: false, activeAt: 0 });
            const serverId = getActiveServerSnapshot().serverId;
            // Seed the actual inactive census, not an out-of-order activity update over the online fixture.
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        }
        else storage.getState().applySettings({ ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: {
                serverIdentityId: 'srv_foreign_home', machineId: selection.selectedTarget!.machineId,
            } },
        }, 2);
        if (machineState === 'offline') expect(storage.getState().machines[selection.selectedTarget!.machineId].active).toBe(false);
        const screen = await focusedScreen(true);
        expect(screen.findHostByTestId('qualified-account-detail'), JSON.stringify({ tree: screen.tree.toJSON(), profile: storage.getState().profile, machines: storage.getState().machines })).not.toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:refresh')).toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:action:reconnect')).toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:configuration')).toBeNull();
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        await act(async () => screen.changeTextByTestId('qualified-account-detail:rename:input', 'Travel account'));
        await screen.pressByTestIdAsync('qualified-account-detail:rename:save');
        await vi.waitFor(() => expect(boundary.readPresentation().entries).toEqual([
            { v: 1, subject: { kind: 'account', account: targetAccount.ref }, label: 'Travel account' },
        ]));
        expect(controlCommands).toEqual([]);
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
        expect(screen.findHostByTestId('qualified-account-detail:action:reconnect')).toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:configuration')).toBeNull();
    });

    it('labels an unfenced qualified Account without admitting credential operations', async () => {
        const targetAccount = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'legacy_unfenced', credentialRevision: null,
            configurationReady: false, configurationRevision: null, scopes: [],
        });
        const boundary = installAccountLabelBoundary(targetAccount);
        storage.getState().applySettings({ ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} }, 2);
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
        // A warm row remains cached while this Home has not returned its current inventory.
        storage.setState({ isDataReady: false });
        const screen = await focusedScreen();
        expect(screen.findHostByTestId('connected-account-choose-machine'), JSON.stringify(screen.tree.toJSON())).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-choose-machine:action') !== null).toBe(true);
        await screen.pressByTestIdAsync('connected-account-choose-machine:action');
        expect(screen.findByTestId('connected-account-target.chip')?.props.accessibilityState?.expanded).toBe(true);
        expect(controlCommands).toEqual([]);
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

    it('rejects a malformed plugin-declared key inline before submission and accepts a corrected shape', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
            defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'API key', secret: true, schema: ANTHROPIC_API_KEY_INPUT_SCHEMA }] }],
        } } });
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

    it('returns to a fresh editable manual form after provider verification rejects a valid-shaped key', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: {
            defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'API key', secret: true, schema: ANTHROPIC_API_KEY_INPUT_SCHEMA }] }],
        } } });
        handleAuthentication = (command) => {
            if (command.operation === 'submitManual') {
                return command.fields.token === 'sk-ant-qa-fake'
                    ? { status: 'rejected', attemptId: 'attempt-1', code: 'anthropic_api_key_rejected' }
                    : { status: 'connected', attemptId: 'attempt-2', account: { service, accountId: 'corrected-account' } };
            }
            if (command.operation === 'read') {
                return { status: 'rejected', attemptId: 'attempt-1', code: 'anthropic_api_key_rejected' };
            }
            return { status: 'awaitingManual', attemptId: authenticationCommands.some((entry) => entry.operation === 'submitManual') ? 'attempt-2' : 'attempt-1' };
        };
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'sk-ant-qa-fake'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry')).not.toBeNull());
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
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'cancel', attemptId: 'attempt-2' }));
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
        expect(controlCommands).toEqual([{ operation: 'describeService', service: compatibility.service, requiredOperation: 'account_list' }]);
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
        const screen = await renderScreen(element(selection, compatibility.service));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        expect(controlCommands).toContainEqual({ operation: 'describeService', service: compatibility.service, requiredOperation: 'account_list' });
        expect(authenticationCommands).toContainEqual({ operation: 'beginConnect', service: compatibility.service, modeId });
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'github-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service: compatibility.service, accountId: 'new-account' }));
    });

    it('cancels locally without waiting and cancels a live reply to the abandoned submission', async () => {
        const submitted = deferredReply();
        const cancelled = deferredReply();
        handleAuthentication = (command) => command.operation === 'submitManual' ? submitted.promise
            : command.operation === 'cancel' ? cancelled.promise
                : { status: 'awaitingManual', attemptId: 'attempt-1' };
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'secret-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(authenticationCommands.some((command) => command.operation === 'submitManual')).toBe(true));
        await screen.pressByTestIdAsync('connected-account-setup:cancel');
        expect(onCancel).toHaveBeenCalledOnce();
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
        await act(async () => submitted.resolve({ status: 'awaitingManual', attemptId: 'late-attempt' }));
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'cancel', attemptId: 'late-attempt' }));
        expect(onConnected).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
        await act(async () => cancelled.resolve({ status: 'cancelled', attemptId: 'attempt-1' }));
    });

    it('changing the sign-in method abandons its live attempt and clears retained secrets', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { ...authentication, modes: [...authentication.modes, {
                id: 'other', kind: 'manual', outcomeReconciliation: 'none', fields: authentication.modes[0].fields,
            }] },
        } });
        handleAuthentication = (command) => command.operation === 'cancel'
            ? { status: 'cancelled', attemptId: command.attemptId }
            : { status: 'awaitingManual', attemptId: command.operation === 'beginConnect' && command.modeId === 'other' ? 'attempt-2' : 'attempt-1' };
        const screen = await manualScreen();
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'do-not-retain'));
        await screen.pressByTestIdAsync('connected-service-setup:method:other');
        await vi.waitFor(() => expect(authenticationCommands).toContainEqual({ operation: 'beginConnect', service, modeId: 'other' }));
        expect(authenticationCommands).toContainEqual({ operation: 'cancel', attemptId: 'attempt-1' });
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')!.props.value).toBe(''));
        expect(onConnected).not.toHaveBeenCalled();
    });

    it.each(['advanced', 'unchanged'] as const)('recovers a lost reply with the same exact attempt (%s)', async (outcome) => {
        handleAuthentication = (command) => {
            if (command.operation === 'submitManual') throw new Error('Lost transport reply');
            if (command.operation === 'read' && outcome === 'advanced') {
                return { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'new-account' } };
            }
            return { status: 'awaitingManual', attemptId: 'attempt-1' };
        };
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
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: kind, modes: [kind === 'device'
                ? { id: kind, kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }
                : { id: kind, kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none' }] },
        } });
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [{ attemptId: 'persisted-attempt', kind, modeId: kind,
                intent: 'connect', phase: kind === 'device' ? 'awaitingDeviceAuthorization' : 'awaitingOAuth',
                createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 }] }
            : description;
        handleAuthentication = () => kind === 'device'
            ? { status: 'awaitingDeviceAuthorization', attemptId: 'persisted-attempt', verificationUri: 'https://provider.example/device',
                userCode: 'SAFE-CODE', expiresAtMs: Date.now() + 60_000, pollIntervalMs: 5_000 }
            : { status: 'awaitingOAuth', attemptId: 'persisted-attempt', authorizationUrl: 'https://provider.example/authorize', callbackUrl: 'http://127.0.0.1:4000/auth/callback' };
        const testId = kind === 'device' ? 'connected-account-device:code' : 'connected-account-oauth:open';
        const first = await renderScreen(element());
        await vi.waitFor(() => expect(first.findHostByTestId(testId)).not.toBeNull());
        await act(async () => first.tree.unmount());
        const second = await renderScreen(element());
        await vi.waitFor(() => expect(second.findHostByTestId(testId)).not.toBeNull());
        expect(authenticationCommands).toEqual(Array.from({ length: 2 }, () => kind === 'device'
            ? { operation: 'resumeDevice', attemptId: 'persisted-attempt' }
            : { operation: 'read', attemptId: 'persisted-attempt', restoreKind: 'oauth' }));
    });

    it.each(['route', 'machine', 'account', 'server', 'unmount'] as const)('ignores a terminal late reply after %s retirement', async (retirement) => {
        const pending = deferredReply();
        let issued = false;
        handleAuthentication = () => {
            if (issued) return { status: 'awaitingManual', attemptId: 'fresh-attempt' };
            issued = true;
            return pending.promise;
        };
        const screen = await renderScreen(element());
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
            const screen = await renderScreen(element());
            await act(async () => { await vi.advanceTimersByTimeAsync(0); });
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
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-device:poll')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account-device:poll');
        expect(authenticationCommands).toContainEqual({ operation: 'pollDevice', attemptId: 'attempt-1' });
    });

    it.each(['oauth', 'device'] as const)('continues an uncertain pending %s attempt through its mode-owned operation', async (kind) => {
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: kind, modes: [kind === 'device'
                ? { id: kind, kind: 'oauthDeviceCode', outcomeReconciliation: 'providerCheck' }
                : { id: kind, kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
        } });
        handleAuthentication = (command) => command.operation === 'reconcile'
            ? { status: 'pending', attemptId: 'attempt-1', retryAfterMs: 250 }
            : { status: 'outcomeUnknown', attemptId: 'attempt-1', diagnostic: { code: 'provider_response_lost' } };
        const screen = await renderScreen(element());
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
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [configuredMode] } } });
        const pending = deferredReply();
        const committed = { ...configurationReply, status: 'configurationCommitted', configuration: { ...configurationReply.configuration, status: 'ready', revision: 'config-2' } };
        handleControl = (command) => command.operation === operation ? pending.promise
            : command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] }
                : command.operation === 'readConfiguration' ? configurationReply
                    : command.operation === 'replaceConfiguration' ? committed : description;
        handleAuthentication = (command) => command.operation === operation ? pending.promise
            : { status: 'configurationRequired', attemptId: 'attempt-1', target: configurationTarget, missingFieldIds: [] };
        const screen = await renderScreen(element());
        if (operation !== 'readConfiguration') {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
            await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
            await screen.pressByTestIdAsync('connected-account-configuration:save');
        }
        await vi.waitFor(() => expect([...controlCommands, ...authenticationCommands].some((command) => command.operation === operation)).toBe(true));
        await act(async () => screen.tree.unmount());
        await act(async () => pending.resolve(operation === 'readConfiguration' ? configurationReply
            : operation === 'replaceConfiguration' ? committed
                : { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'retired-account' } }));
        expect(onConnected).not.toHaveBeenCalled();
        if (operation !== 'continueConnect') expect(authenticationCommands.some((command) => command.operation === 'continueConnect')).toBe(false);
    });

    it('reads, saves and continues configuration with exact managed targets and no disclosed secret', async () => {
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
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:secret')!.props.value).toBe('');
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith({ service, accountId: 'new-account' }));
        expect(controlCommands).toContainEqual({ operation: 'readConfiguration', target: { kind: 'attempt', attemptId: 'attempt-1' } });
        expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: { kind: 'attempt', attemptId: 'attempt-1' },
            expectedRevision: 'config-1', values: { endpoint: 'https://new.example' }, secretValues: {} });
        expect(authenticationCommands).toContainEqual({ operation: 'continueConnect', attemptId: 'attempt-1', expectedConfigurationRevision: 'config-2' });
    });

    it('reconnects and continues only the requested qualified account after its configuration commit', async () => {
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
            { operation: 'cancel', attemptId: 'attempt-1' },
        ]);
        expect(controlCommands).toContainEqual({ operation: 'readConfiguration', target: { kind: 'account', account: ref } });
        expect(controlCommands).toContainEqual({ operation: 'replaceConfiguration', target: { kind: 'account', account: ref },
            expectedRevision: 'config-1', values: { endpoint: 'https://new.example' }, secretValues: {} });
    });

    it.each(['account'] as const)('edits established %s configuration without inferring reconnect or revealing configured secrets', async (scope) => {
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

    it('edits admitted service configuration through Account CAS without selecting a machine', async () => {
        const mode: PluginConnectedAccountAuthenticationModeV2 = { ...configuredMode,
            configuration: { scope: 'service', changeBehavior: 'refresh', fields: [configuredMode.configuration!.fields[0]!] } };
        installDescription({ ...described, descriptor: { ...described.descriptor,
            authentication: { defaultModeId: mode.id, modes: [mode] } } });
        const projected = { scopeKey: getActiveServerSnapshot().serverId, status: 'ready' as const, conflicts: [], errorReason: null,
            descriptors: [{ id: service.localId, serviceId: 'acme-work', pluginId: service.pluginId, title: 'Acme Work',
                provenance: 'external' as const, sourceKind: 'installed' as const, authentication: description.descriptor.authentication,
                capabilities: [], availability: { state: 'available' as const, reason: 'resolved' }, diagnostics: [] }] };
        installConnectedAccountDescriptorProjection(projected, captureActiveServerAccountScopeLifetime());
        let value = { v: 1 as const, entries: [{ service, modeId: mode.id, revision: 'config-1',
            values: { endpoint: 'https://old.example' }, secretRefs: {} }] };
        let revision = 1;
        let writes = 0;
        handleHttp = async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`) {
                if (init?.method !== 'POST') return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'configurations', value } } });
                const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'configurations') throw new Error('Expected Account configuration');
                expect(mutation.content.v.value.entries[0]?.values).toEqual({ endpoint: 'https://new.example' });
                writes += 1;
                value = { ...value, entries: mutation.content.v.value.entries.map(entry => ({ ...entry, values: { endpoint: String(entry.values.endpoint) } })) };
                return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
            }
            return new Response('{}', { status: 404 });
        };
        storage.getState().applyMachines([], true, { sourceServerId: getActiveServerSnapshot().serverId });
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
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-configuration-settings:oauth')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-service-configuration-settings:oauth');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://new.example'));
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        await vi.waitFor(() => expect(writes).toBe(1));
        expect(controlCommands).toEqual([]);
        expect(authenticationCommands).toEqual([]);
        expect(value.entries[0]!.values.endpoint).toBe('https://new.example');
    });

    it('preserves an invalid configuration draft without claiming a successful reconnect', async () => {
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [configuredMode] } } });
        handleControl = (command) => command.operation === 'listPendingAttempts'
            ? { status: 'pendingAttempts', attempts: [] }
            : command.operation === 'readConfiguration' ? configurationReply
                : command.operation === 'replaceConfiguration' ? { status: 'unavailable', code: 'connected_account_configuration_invalid' } : description;
        handleAuthentication = () => ({ status: 'configurationRequired', attemptId: 'attempt-1', target: configurationTarget, missingFieldIds: [] });
        const screen = await renderScreen(element());
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://unsaved.example'));
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:endpoint')!.props.value).toBe('https://unsaved.example');
        expect(authenticationCommands.some((command) => command.operation === 'continueConnect')).toBe(false);
        expect(onConnected).not.toHaveBeenCalled();
    });

    it('does not treat service configuration from a retired occurrence as ready even with the same managed custody', async () => {
        const mode: PluginConnectedAccountAuthenticationModeV2 = { ...configuredMode, configuration: { ...configuredMode.configuration!, scope: 'service' } };
        const target = { kind: 'service' as const, service, modeId: 'oauth' };
        installDescription({ ...described, descriptor: { ...described.descriptor, authentication: { defaultModeId: 'oauth', modes: [mode] } },
            accounts: [{ ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'oauth',
                revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [] }],
        });
        handleControl = (command) => command.operation === 'readConfiguration'
            ? { ...configurationReply, target, mode, occurrenceId: 'retired-occurrence', configuration: { ...configurationReply.configuration, status: 'ready' } }
            : command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] } : description;
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-configuration-settings:oauth')).not.toBeNull());
        // Canonical text boundary emits keys: this is the displayed blocked state, not copy wording.
        expect(JSON.stringify(screen.tree.toJSON())).toContain('common.blocked');
        expect(controlCommands).toContainEqual({ operation: 'readConfiguration', target });
        expect(authenticationCommands).toEqual([]);
    });

    it.each(['exact_v0_2_1', 'revisioned_v2_v3'] as const)('keeps an unfenced %s legacy account passive at the real focused route', async (peerClass) => {
        const legacyServiceId = peerClass === 'exact_v0_2_1' ? 'openai-codex' : 'github';
        const compatibility: BuiltInLegacyConnectedAccountCompatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[legacyServiceId];
        const credentialKind = peerClass === 'exact_v0_2_1' ? 'oauth' : 'token';
        const modeId = compatibility.authenticationModeByCredentialKind[credentialKind]!;
        const mode: PluginConnectedAccountAuthenticationModeV2 = credentialKind === 'oauth'
            ? { id: modeId, kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'providerCheck' }
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

    it('retains connected-account custody until the canonical default Ask is approved', async () => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        const bindings = await seedPurposeDefaults({ kind: 'account', account: targetAccount.ref });
        installDescription({ ...described, accounts: [targetAccount] });
        const approvals: ApprovalRequestV2[] = [];
        handleHttp = async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/artifacts' && init?.method === 'POST') {
                // The persisted approval is produced by the real executor and
                // Artifact owner; only their HTTP boundary is replaced.
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
        handleControl = command => command.operation === 'revokeAccount'
            ? { status: 'revoked', account: targetAccount.ref, remoteStatus: 'remoteUnsupported' }
            : command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] } : description;
        await transferPurposeDefaults();
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).not.toBeNull());
        // An awaited final approval may keep this invocation open. Unmount's
        // real controller lifetime cancels it during the standard cleanup.
        void screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        await vi.waitFor(() => expect(approvals, JSON.stringify({ commands: controlCommands,
            requests: httpRequests.map(url => url.pathname), tree: screen.tree.toJSON() })).toHaveLength(1));
        expect(approvals[0]).toMatchObject({ actionId: 'connectedServices.accounts.revoke', status: 'open', actionArgs: {
            machineId: selection.selectedTarget!.machineId, account: targetAccount.ref, cleanupGroupReferences: false,
            expectedCredentialRevision: credentialRevision,
        } });
        // The actual installed Action's persisted Ask is the confirmation owner,
        // not an additional local destructive-confirmation gate in this view.
        expect(platform.confirm).not.toHaveBeenCalled();
        expect(controlCommands.filter(command => command.operation === 'revokeAccount')).toEqual([]);
        expect(purposeBoundary!.readBindings()).toEqual(bindings);
        expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull();
    });

    it.each([false, true])('reviews retained native resources before an explicit manual-responsibility revoke retry (confirmed: %s)', async (confirmed) => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        const bindings = await seedPurposeDefaults({ kind: 'account', account: targetAccount.ref });
        installDescription({ ...described, accounts: [targetAccount] });
        storage.getState().applySettings({ ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'connectedServices.accounts.revoke': ['ui'] },
        }) }, 3);
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
        platform.confirm.mockResolvedValue(confirmed);
        await transferPurposeDefaults();
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).not.toBeNull());
        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        expect(revokes, JSON.stringify({ commands: controlCommands, requests: httpRequests.map(url => url.pathname) })).not.toHaveLength(0);
        expect(platform.confirm).toHaveBeenCalledTimes(confirmed ? 2 : 1);
        expect(vi.mocked(Modal.confirm).mock.calls[0]?.[1]).toContain('native-1');
        expect(vi.mocked(Modal.confirm).mock.calls[0]?.[1]).toContain('controller-1');
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
        storage.getState().applySettings({ ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'connectedServices.accounts.revoke': ['ui'] },
        }) }, 3);
        const machineId = selection.selectedTarget!.machineId;
        let releaseMachine!: () => void;
        const machineResponse = new Promise<void>(resolve => { releaseMachine = resolve; });
        let transportAwaiting = false;
        const emissions: ControlCommand[] = [];
        // Keep real scoped fallback, Machine mode resolution, codec and
        // pre-emission callbacks. Only HTTP and Socket.IO are substituted.
        vi.mocked(apiSocket.machineRPC).mockRestore();
        installDisconnectedServerSocketBoundary(socket => {
            socket.connected = true;
            socket.emitWithAck = vi.fn(async (_event: string, payload: unknown) => {
                if (payload && typeof payload === 'object' && 'params' in payload) {
                    const request = ConnectedAccountControlCommandRequestSchema.safeParse(payload.params);
                    if (request.success) emissions.push(request.data.command);
                }
                return { ok: true, result: { status: 'outcomeUnknown', account: targetAccount } };
            });
            socket.timeout = vi.fn(() => socket);
        });
        handleHttp = async rawUrl => {
            const url = new URL(String(rawUrl));
            if (url.pathname === `/v1/machines/${machineId}`) {
                transportAwaiting = true;
                await machineResponse;
                return Response.json({ machine: { id: machineId, kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    metadataVersion: 1, daemonStateVersion: 1 } });
            }
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        const result = createDefaultActionExecutor().execute('connectedServices.accounts.revoke', {
            machineId, account: targetAccount, expectedCredentialRevision: credentialRevision, cleanupGroupReferences: false,
        }, { surface: 'ui', authority: 'present_user', serverId: account.home.id, expectedAccountId: 'account-a' });
        try {
            await vi.waitFor(() => expect(transportAwaiting).toBe(true));
            const replacement = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature` };
            expect(await TokenStorage.setCredentialsForServerUrl(account.home.serverUrl, { serverId: account.home.id }, replacement)).toBe(true);
        } finally {
            releaseMachine();
        }
        try {
            expect(await result).toMatchObject({ ok: false });
            expect(emissions).toEqual([]);
        } finally {
            installDisconnectedServerSocketBoundary();
            await TokenStorage.setCredentialsForServerUrl(account.home.serverUrl, { serverId: account.home.id }, account.credentials);
        }
    });

    it.each(['declined', 'revoked', 'conflict'] as const)('cleans only the exact account group references after explicit confirmation (%s)', async (outcome) => {
        const targetAccount: QualifiedConnectedAccountProfileV4 = {
            ref: { service, accountId: 'account-1' }, status: 'connected', authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
        };
        const otherAccount = { ...targetAccount, ref: { service, accountId: 'account-2' } };
        const bindings = await seedPurposeDefaults({ kind: 'account', account: targetAccount.ref });
        installDescription({ ...described, accounts: [targetAccount, otherAccount] });
        // This neighbor exercises a settled reply under an explicit shared
        // policy waiver. The default Ask's Artifact boundary is covered above.
        storage.getState().applySettings({ ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'connectedServices.accounts.revoke': ['ui'] },
        }) }, 3);
        expect(storage.getState().settings.actionsSettingsV1.approvalWaivedSurfaces?.['connectedServices.accounts.revoke']).toEqual(['ui']);
        handleHttp = async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        handleControl = (command) => {
            if (command.operation === 'revokeAccount') {
                if (!command.cleanupGroupReferences || outcome === 'conflict') return { status: 'conflict', code: 'connect_credential_referenced_by_group' };
                description = { ...description, accounts: [otherAccount] };
                return { status: 'revoked', account: targetAccount.ref, remoteStatus: 'remoteUnsupported' };
            }
            return command.operation === 'listPendingAttempts' ? { status: 'pendingAttempts', attempts: [] } : description;
        };
        platform.confirm.mockResolvedValueOnce(outcome !== 'declined');
        await transferPurposeDefaults();
        const screen = await focusedScreen();
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:action:disconnect')).not.toBeNull());
        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        await vi.waitFor(() => expect(platform.confirm).toHaveBeenCalledOnce());
        expect(controlCommands.filter((command) => command.operation === 'revokeAccount')).toEqual([
            { operation: 'revokeAccount', account: targetAccount.ref, expectedCredentialRevision: credentialRevision, cleanupGroupReferences: false },
            ...(outcome !== 'declined' ? [{ operation: 'revokeAccount', account: targetAccount.ref, expectedCredentialRevision: credentialRevision, cleanupGroupReferences: true }] : []),
        ]);
        const changedReferenceWrites = purposeBoundary!.rowWrites.filter(record =>
            JSON.stringify(record.value.bindings) !== JSON.stringify(bindings));
        if (outcome === 'revoked') {
            expect(changedReferenceWrites).not.toEqual([]);
            // A later normalization can acknowledge the same projection again;
            // every changed projection must preserve the unrelated credential.
            for (const write of changedReferenceWrites) {
                expect(write.value.bindings).toEqual(bindings.slice(2));
            }
        } else {
            expect(changedReferenceWrites).toEqual([]);
        }
        if (outcome === 'conflict') {
            expect(screen.findHostByTestId('connected-account:error')).not.toBeNull();
            expect(JSON.stringify(screen.tree.toJSON())).toContain('connectedServices.errors.credentialReferencedByGroup');
        }
        expect(onConnected).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(purposeBoundary!.readBindings(),
            JSON.stringify({ tree: screen.tree.toJSON(), scope: storage.getState().settingsScope, version: storage.getState().settingsVersion }))
            .toEqual(outcome === 'revoked' ? bindings.slice(2) : bindings));
    });

    it.each(['cancelled', 'deleted', 'failed'] as const)('clears exact pool purpose defaults only after confirmed successful deletion (%s)', async (outcome) => {
        const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1,
            ref: { service, groupId: 'work-pool' }, incarnation: 'pool-life', displayName: 'Work pool',
            policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: null,
            generation: 1, runtimeStateRevision: 0, state: {}, createdAt: 0, updatedAt: 0, members: [],
        });
        const bindings = await seedPurposeDefaults({ kind: 'group', ...group.ref });
        QualifiedConnectedAccountGroupListResponseV4Schema.parse({ groups: [group] });
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            features: { connectedServices: { enabled: true, accountGroups: { enabled: true } } },
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
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ConnectedAccountServiceView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-pool-detail:delete'),
            JSON.stringify({ tree: screen.tree.toJSON(), requests: httpRequests.map((url) => url.pathname) })).not.toBeNull());
        await screen.pressByTestIdAsync('connected-services-pool-detail:delete');
        await vi.waitFor(() => expect(platform.confirm).toHaveBeenCalledOnce());
        if (outcome !== 'cancelled') await vi.waitFor(() => expect(deletedRequests).toHaveLength(1));
        if (outcome === 'failed') await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-pool-detail:error')).not.toBeNull());
        await vi.waitFor(() => expect(purposeBoundary!.readBindings())
            .toEqual(outcome === 'deleted' ? bindings.slice(2) : bindings));
        if (outcome === 'cancelled') expect(deletedRequests).toEqual([]);
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
        await screen.pressByTestIdAsync('qualified-account-detail:refresh');
        await vi.waitFor(() => expect(httpRequests.some(url => url.pathname === '/v4/connect/qualified/quotas/refresh')).toBe(true));
        const refreshAdmission = vi.mocked(apiSocket.machineRPC).mock.calls.find(([, , payload]) => {
            const parsed = ConnectedAccountControlCommandRequestSchema.safeParse(payload);
            return parsed.success && parsed.data.command.operation === 'describeService'
                && parsed.data.command.requiredOperation === 'quota_refresh';
        });
        expect(refreshAdmission?.[0]).toBe(selection.selectedTarget!.machineId);
        expect(onConnected).not.toHaveBeenCalled();
    });
});
