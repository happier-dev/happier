import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Unused native Markdown renderer is an external package boundary in this host test.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in Connect'); },
}));

import { Modal } from '@/modal';
import { presentConnectSheet } from './ConnectedServiceSetupModal';
import { presentShareSheet } from '@/components/sharing/presentShareSheet';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const account = { service, accountId: 'work' };

afterEach(async () => { vi.clearAllMocks(); await standardCleanup(); });

describe('presentConnectSheet result lifecycle', () => {
    it.each(['connected', 'selected'] as const)('closes and returns the %s account without navigation', async kind => {
        const result = presentConnectSheet({ service, account });
        const modal = vi.mocked(Modal.show).mock.calls.at(-1)![0];
        modal.props?.onResult({ kind, account });
        await expect(result).resolves.toEqual({ kind, account });
        expect(Modal.hide).toHaveBeenCalledWith('modal-id');
        // A shared dismissal arriving after success must not overwrite the outcome.
        modal.onRequestClose?.();
        await expect(result).resolves.toEqual({ kind, account });
    });

    it.each(['onRequestClose', 'onHostUnmount'] as const)('settles dismissal through %s', async close => {
        const result = presentConnectSheet({ service });
        vi.mocked(Modal.show).mock.calls.at(-1)![0][close]?.();
        await expect(result).resolves.toEqual({ kind: 'dismissed' });
    });

    it('returns the canonical key reference without copying key material', async () => {
        const result = presentConnectSheet({ service: { kind: 'key', suggestedName: 'Inference key' } });
        vi.mocked(Modal.show).mock.calls.at(-1)![0].props?.onResult({ kind: 'selected', secretRef: 'shared:inference' });
        await expect(result).resolves.toEqual({ kind: 'selected', secretRef: 'shared:inference' });
    });

    it('uses the Share presentation owner for anchored desktop and phone sheet chrome', () => {
        const anchor = { kind: 'rect' as const, rect: { left: 100, top: 200, height: 30 } };
        const result = presentConnectSheet({ service, anchor });
        const connect = vi.mocked(Modal.show).mock.calls.at(-1)![0];
        function Body() { return React.createElement('Body'); }
        presentShareSheet({ component: Body, props: {}, title: 'Share', testID: 'share', anchor });
        const share = vi.mocked(Modal.show).mock.calls.at(-1)![0];
        expect(connect.chrome).toMatchObject({ kind: 'card', phonePresentation: 'sheet', anchor });
        expect(share.chrome).toMatchObject({ kind: 'card', phonePresentation: 'sheet', anchor });
        connect.onRequestClose?.();
        return result;
    });
});

// The real Account lifecycle below owns sockets; replace only the external SDK factory.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

it('keeps the invoking Machine over the remembered target with zero RPC until a method is chosen', async () => {
    const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { renderScreen, flushHookEffects } = await import('@/dev/testkit');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
    const { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } =
        await import('@/sync/domains/connectedServices/connectedServiceRegistry');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { ConnectedAccountControlCommandRequestSchema } = await import('@happier-dev/protocol/connect/connectedAccountDaemonRpcV1');
    const scopedService = { pluginId: 'acme.connect-count', localId: 'login' };
    const authentication = { defaultModeId: 'manual', modes: [
        { id: 'manual', title: 'API token', kind: 'manual' as const, outcomeReconciliation: 'none' as const,
            fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' as const, minLength: 1 } }] },
        { id: 'device', title: 'Device sign-in', kind: 'oauthDeviceCode' as const, outcomeReconciliation: 'none' as const },
    ] };
    const account = await restoreServerAccountForTest({ serverUrl: 'https://connect-count.test', accountId: 'connect-owner',
        serverIdentityId: 'srv_connect_count', request: async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'connect-owner' });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            return null;
        } });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime> = null;
    const nativeCommands: Array<{ machineId: string; method: string; operation: string }> = [];
    const rpc = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async <R, A>(_machineId: string, method: string, payload: A): Promise<R> => {
        const request = ConnectedAccountControlCommandRequestSchema.parse(payload);
        nativeCommands.push({ machineId: _machineId, method, operation: request.command.operation });
        const response = request.command.operation === 'describeService' ? {
            status: 'described', service: scopedService,
            descriptor: { id: scopedService.localId, title: 'Counted login', authentication },
            occurrenceId: 'counted-login', sourceCustody: { kind: 'managed', immutableGenerationId: 'counted-artifact', installSource: 'npm' },
            accounts: [], operationTransport: { kind: 'v4' },
        } : { status: 'pendingAttempts', attempts: [] };
        // RPC bytes are unknown at the genuine transport boundary; the caller parses the schema.
        return response as R;
    });
    try {
        await (await import('@/sync/sync')).sync.awaitBootstrapForegroundAcquisition();
        lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the restored Account lifetime');
        const scope = lifetime.scope;
        storage.getState().activateProfileScope(scope);
        await storage.getState().activateSettingsScope(scope);
        storage.getState().applyProfile({ ...profileDefaults, id: scope.accountId });
        const machine = createMachineFixture({ id: 'connect-count-machine', activeAt: Date.now() });
        const target = { serverIdentityId: account.home.serverIdentityId!, machineId: machine.id };
        storage.setState({ settings: { ...settingsDefaults,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: { ...target, machineId: 'remembered-machine' } } }, settingsVersion: 1,
            isDataReady: true });
        storage.getState().applyMachines([machine, createMachineFixture({ id: 'remembered-machine', activeAt: Date.now() })],
            true, { sourceServerId: scope.serverId });
        installConnectedAccountDescriptorProjection({ scopeKey: scope.serverId, status: 'ready', conflicts: [], errorReason: null,
            descriptors: [{ id: scopedService.localId, serviceId: 'counted-login', pluginId: scopedService.pluginId, title: 'Counted login',
                provenance: 'external', sourceKind: 'installed', authentication, capabilities: [],
                availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] }, lifetime);
        const result = presentConnectSheet({ scope, service: scopedService, initialMachineTarget: target });
        const modal = vi.mocked(Modal.show).mock.calls.at(-1)![0];
        if (!modal.component) throw new Error('Expected the composed Connect body');
        screen = await renderScreen(<InjectedAuthProvider credentials={null}>{React.createElement(modal.component,
            { ...modal.props, onClose: () => modal.onRequestClose?.() })}</InjectedAuthProvider>);
        await flushHookEffects({ cycles: 10 });
        await vi.waitFor(() => expect(screen!.findByTestId('connected-service-setup:method:manual'),
            JSON.stringify({ nativeCommands, text: screen!.getTextContent() })).not.toBeNull());
        expect(nativeCommands).toEqual([]);
        await screen.pressByTestIdAsync('connected-service-setup:method:manual');
        await vi.waitFor(() => expect(nativeCommands.length).toBeGreaterThan(0));
        expect(nativeCommands.every(command => command.machineId === target.machineId)).toBe(true);
        modal.onRequestClose?.();
        await expect(result).resolves.toEqual({ kind: 'dismissed' });
    } finally {
        await screen?.unmount();
        rpc.mockRestore();
        if (lifetime) retireConnectedAccountDescriptorProjection(lifetime);
        await account.dispose();
        vi.unstubAllGlobals();
    }
}, 180_000);
