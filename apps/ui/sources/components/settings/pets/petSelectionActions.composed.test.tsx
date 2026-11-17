import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AccountPetLibraryEntryV1Schema } from '@happier-dev/protocol/pets/accountLibrary';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from '@happier-dev/protocol/pets/constants';
import { ImportedLocalPetPackageV1Schema } from '@happier-dev/protocol/pets/daemonRpc';
import { normalizeLocalPetSourceMetadata } from '@/sync/domains/pets/normalizeLocalPetSources';
import { createClientActionReverseDispatcher } from '../../../../../cli/src/session/actions/clientActionReverseDispatch';
import { createCliActionExecutor } from '../../../../../cli/src/session/actions/createCliActionExecutor';
import { createActionSettingsProvider } from '../../../../../cli/src/settings/actionsSettingsProvider';

const routerPush = vi.hoisted(() => vi.fn());
const confirmAction = vi.hoisted(() => vi.fn(async () => false));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm: confirmAction } }).module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
const { useSelectedPetPackage } = await import('@/components/pets/source/useSelectedPetPackage');
const originalState = storage.getState();
const originalAuth = getCurrentAuth();
afterEach(() => { standardCleanup(); setCurrentAuth(originalAuth); storage.setState(originalState, true); routerPush.mockClear(); confirmAction.mockReset(); confirmAction.mockResolvedValue(false); });

const manifest = { id: 'local-cat', displayName: 'Local cat', description: 'A local cat companion.', spritesheetPath: 'spritesheet.webp' };
const localPet = ImportedLocalPetPackageV1Schema.parse({ sourceKey: 'managed:local-cat', petId: manifest.id,
    displayName: manifest.displayName, manifest,
    kind: 'happierManagedLocal', description: manifest.description, originLabel: 'This device',
    previewHandle: { kind: 'daemonSourceKey', sourceKey: 'managed:local-cat' },
    mediaType: 'image/webp', digest: 'sha256:local', sizeBytes: 100 });
const accountPet = AccountPetLibraryEntryV1Schema.parse({ accountPetId: 'account-cat', packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1, manifest,
    spritesheetAssetRef: { assetId: 'asset-cat', mediaType: 'image/webp', digest: 'sha256:account', sizeBytes: 100 },
    digest: 'sha256:account', sizeBytes: 100, createdAt: 1, updatedAt: 1, origin: { kind: 'manualImport' } });

async function setup(policy: 'off' | 'ask' | 'allowed') {
    const account = await createSecretSettingsTestHarness({
        serverIdentityId: 'srv_pet_selection',
        features: createRootLayoutFeaturesResponse({ features: { pets: { companion: { enabled: true }, sync: { enabled: true } } },
            capabilities: { serverIdentity: { serverIdentityId: 'srv_pet_selection' } } }),
        settings: settingsParse({ experiments: true, featureToggles: { 'pets.companion': true, 'pets.sync': true }, petsEnabled: true,
            petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
            actionsSettingsV1: { v: 1, ...(policy === 'off'
                ? { actions: { 'ui.pet.choose': { disabledSurfaces: ['ui', 'agent', 'mcp'] } } }
                : policy === 'ask' ? { actions: { 'ui.pet.choose': { approvalRequiredSurfaces: ['ui', 'agent', 'mcp'] } } }
                    : { approvalWaivedSurfaces: { 'ui.pet.choose': ['ui', 'agent', 'mcp'] } }) },
        }),
    });
    const request = account.request.getMockImplementation()!;
    account.request.mockImplementation(async (input, init) => new URL(String(input)).pathname === '/v1/account/pets'
        ? Response.json({ ok: true, pets: [accountPet] }) : request(input, init));
    storage.getState().upsertAccountPet(accountPet);
    storage.getState().upsertLocalPetSources(normalizeLocalPetSourceMetadata([localPet], { serverId: account.scope.serverId, machineId: 'pet-machine' }));
    storage.getState().applyLocalSettings({ petsSelectedPetOverride: { kind: 'happierManagedLocal', sourceKey: localPet.sourceKey } });
    return account;
}

describe('pet selection through the canonical Action', () => {
    it('admits mounted account selection under Off, rejected Ask, approved Ask and Allowed', async () => {
        const account = await setup('off');
        try {
            const screen = await renderScreen(<PetsSettingsScreen />);
            const selected = await renderHook(useSelectedPetPackage);
            const initialOverride = storage.getState().localSettings.petsSelectedPetOverride;
            const choose = () => screen.pressByTestIdAsync('settings-pets-built-in-source-milo');
            const agentChoose = () => createDefaultActionExecutor().execute('ui.pet.choose', { petRef: { kind: 'builtIn', petId: 'milo' } },
                { surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId,
                    actionCaller: { kind: 'host' }, actionRequestId: 'pet-agent-selection' });
            await choose();
            expect(await agentChoose()).toMatchObject({ ok: false });
            expect(account.persistedSettings.petsSelectedPetRef).toEqual({ kind: 'builtIn', petId: 'blink' });
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual(initialOverride);
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'ui.pet.choose': { approvalRequiredSurfaces: ['ui', 'agent'] } } },
            })); });
            const agentRequest = await agentChoose();
            expect({ ok: agentRequest.ok, ...(!agentRequest.ok ? { errorCode: agentRequest.errorCode } : {}) }).toEqual({ ok: true });
            if (!agentRequest.ok) throw new Error(agentRequest.errorCode);
            const agentApproval = ActionApprovalRequestCreatedResultSchema.parse(agentRequest.result);
            await decideApprovalAsInbox(account.scope.serverId, agentApproval.artifactId, 'reject');
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { void choose(); });
            await vi.waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual(initialOverride);
            expect(account.settingsWrites).toEqual([]);
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual(initialOverride);
            confirmAction.mockResolvedValue(true);
            await act(async () => { void choose(); });
            await vi.waitFor(() => expect(account.persistedSettings.petsSelectedPetRef).toEqual({ kind: 'builtIn', petId: 'milo' }));
            expect(confirmAction).toHaveBeenCalledTimes(2);
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual({ kind: 'inherit' });
            expect(selected.getCurrent().source).toMatchObject({ kind: 'builtIn', petId: 'milo' });
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'ui.pet.choose': ['ui'] } },
            })); });
            await screen.pressByTestIdAsync('settings-pets-built-in-source-fury');
            await vi.waitFor(() => expect(account.persistedSettings.petsSelectedPetRef).toEqual({ kind: 'builtIn', petId: 'fury' }));
            expect(account.persistedSettings.petsEnabled).toBe(true);
            expect(account.artifacts.list()).toHaveLength(1);
            expect(confirmAction).toHaveBeenCalledTimes(2);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('projects admitted Agent selection to the UI, validates catalog refs, and keeps failed account writes from clearing the override', async () => {
        const account = await setup('allowed');
        try {
            const selected = await renderHook(useSelectedPetPackage);
            const screen = await renderScreen(<PetsSettingsScreen />);
            let connected = true;
            const receive = createUiClientActionReverseHandler({ ...account.scope, isCurrent: () => true });
            const executor = createCliActionExecutor({ token: account.credentials.token, sessionId: '',
                credentials: { token: account.credentials.token, encryption: null, credentialProvenance: 'stored_session' },
                serverId: account.scope.serverId, serverHttpBaseUrl: new URL(String(account.request.mock.calls[0]![0])).origin,
                pluginActionExecutionOwner: 'current_process',
                actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => account.persistedSettings }),
                clientActionExecute: createClientActionReverseDispatcher(() => ({
                    hasConnectedClientRpcHandler: () => connected,
                    // Only the Machine-to-App network hop is substituted; both real executors and the carrier stay live.
                    callConnectedClientRpc: async (_method, payload, options) => {
                        // The server selects the receiver; a withdrawn App is typed absence before any client executes.
                        if (!connected) return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
                        options.onIssued();
                        return { ok: true, result: await receive(JSON.parse(JSON.stringify(payload)), { signal: new AbortController().signal }) };
                    },
                })),
            });
            const context = { surface: 'agent' as const, serverId: account.scope.serverId, authority: 'account_automation' as const };
            expect(getActionSpec('ui.pet.choose').surfaces).toMatchObject({ agent: true, mcp: true });
            await act(async () => { expect(await executor.execute('ui.pet.choose', { petRef: { kind: 'accountPet', accountPetId: accountPet.accountPetId } }, { ...context, surface: 'mcp' })).toMatchObject({ ok: true }); });
            expect(selected.getCurrent().source).toMatchObject({ kind: 'accountPet', accountPetId: accountPet.accountPetId });
            await screen.pressByTestIdAsync('settings-pets-select-source-local-local-cat');
            await vi.waitFor(() => expect(selected.getCurrent().source).toMatchObject({ kind: 'happierManagedLocal', sourceKey: localPet.sourceKey }));
            await act(async () => { expect(await executor.execute('ui.pet.choose', { deviceOverride: { kind: 'happierManagedLocal', sourceKey: localPet.sourceKey } }, context)).toMatchObject({ ok: true }); });
            expect(selected.getCurrent().source).toMatchObject({ kind: 'happierManagedLocal', sourceKey: localPet.sourceKey });
            const override = storage.getState().localSettings.petsSelectedPetOverride;
            for (const input of [{ petRef: { kind: 'builtIn', petId: 'absent' } }, { petRef: { kind: 'accountPet', accountPetId: 'absent' } },
                { deviceOverride: { kind: 'happierManagedLocal', sourceKey: 'absent' } }]) {
                expect(await executor.execute('ui.pet.choose', input, context)).toMatchObject({ ok: false, errorCode: 'pet_not_found' });
            }
            account.setRejectSettingsWrites(true);
            expect(await executor.execute('ui.pet.choose', { petRef: { kind: 'builtIn', petId: 'oli' } }, context)).toMatchObject({ ok: false });
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual(override);
            account.setRejectSettingsWrites(false);
            await act(async () => { expect(await executor.execute('ui.pet.choose', { deviceOverride: { kind: 'inherit' } }, context)).toMatchObject({ ok: true }); });
            expect(selected.getCurrent().source).toMatchObject({ kind: 'accountPet', accountPetId: accountPet.accountPetId });
            await screen.pressByTestIdAsync('settings-pets-select-source-account-local-cat');
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual({ kind: 'inherit' });
            expect(await createDefaultActionExecutor().execute('ui.pet.choose', {}, { surface: 'ui', serverId: account.scope.serverId })).toMatchObject({ ok: true });
            expect(routerPush).toHaveBeenCalledWith('/settings/pets');
            connected = false;
            expect(await executor.execute('ui.pet.choose', { petRef: { kind: 'builtIn', petId: 'blink' } }, context))
                .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
            expect(account.persistedSettings.petsSelectedPetRef).toEqual({ kind: 'accountPet', accountPetId: accountPet.accountPetId });
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('clears a selected local source through admission before its device removal', async () => {
        const account = await setup('off');
        try {
            const screen = await renderScreen(<PetsSettingsScreen />);
            await screen.pressByTestIdAsync('settings-pets-remove-from-device-local-cat');
            expect(storage.getState().localPetSourcesBySourceKey[localPet.sourceKey]).toBeDefined();
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual({ kind: 'happierManagedLocal', sourceKey: localPet.sourceKey });
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'ui.pet.choose': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await screen.pressByTestIdAsync('settings-pets-remove-from-device-local-cat');
            await vi.waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
            expect(storage.getState().localPetSourcesBySourceKey[localPet.sourceKey]).toBeDefined();
            expect(account.artifacts.list()).toEqual([]);
            expect(storage.getState().localPetSourcesBySourceKey[localPet.sourceKey]).toBeDefined();
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual({ kind: 'happierManagedLocal', sourceKey: localPet.sourceKey });
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'ui.pet.choose': ['ui'] } },
            })); });
            await screen.pressByTestIdAsync('settings-pets-remove-from-device-local-cat');
            await vi.waitFor(() => expect(storage.getState().localPetSourcesBySourceKey[localPet.sourceKey]).toBeUndefined());
            expect(storage.getState().localSettings.petsSelectedPetOverride).toEqual({ kind: 'inherit' });
        } finally { standardCleanup(); await account.dispose(); }
    });
});
