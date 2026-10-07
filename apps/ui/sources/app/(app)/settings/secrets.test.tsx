import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { computeContentPublicKeyFingerprint, McpServersSettingsV1Schema, SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { SecretsSettingsPage, type SecretsSettingsPageProps } from '@/components/settings/secrets/SecretsSettingsPage';
import { SavedSecretAccessEditor } from '@/components/secrets/SavedSecretAccessEditor';
import { SavedSecretCreateEditor } from '@/components/secrets/SavedSecretCreateEditor';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { encodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import Screen from './secrets';

installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-crypto', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-crypto')>(),
    // Node has no Expo native module; keep real randomness at that SDK boundary.
    randomUUID: () => crypto.randomUUID(),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: vi.fn() } }).module;
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
await loadSyncSingletonForTests();

const PageComponent = Reflect.get(SecretsSettingsPage, 'type') as React.ComponentType<SecretsSettingsPageProps>;
const AccessComponent = Reflect.get(SavedSecretAccessEditor, 'type') as React.ComponentType<React.ComponentProps<typeof SavedSecretAccessEditor>>;
const CreateComponent = Reflect.get(SavedSecretCreateEditor, 'type') as React.ComponentType<React.ComponentProps<typeof SavedSecretCreateEditor>>;
const ownerCorrupt = {
    materialStatus: 'resource_corrupt', relationship: 'owner',
    repair: { kind: 'delete_resource', resourceId: 'opaque-corrupt-row', expectedRevision: -3 },
} as const;

describe('SecretsSettingsScreen shared feature decision', () => {
    let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
    const screens: Array<Awaited<ReturnType<typeof renderScreen>>> = [];
    const initialStorage = storage.getState();
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(async () => {
        for (const screen of screens.splice(0).reverse()) await screen.unmount();
        resetSavedSecretCatalogEngineForTests();
        resetSavedSecretCatalogSnapshotsForTests();
        await account?.dispose();
        account = undefined;
        storage.setState(initialStorage, true);
    });
    async function render(options: Parameters<typeof createSecretSettingsTestHarness>[0] = {}, resourceMode?: 'plain' | 'e2ee') {
        account = await createSecretSettingsTestHarness(options);
        if (resourceMode) await account.addOwnerResource(resourceMode);
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><Screen /></InjectedAuthProvider>);
        screens.push(screen);
        const page = (): SecretsSettingsPageProps => screen.tree.findByType<typeof PageComponent>(PageComponent).props;
        if (options.sharedEnabled !== false && !options.rejectSettingsWrites) {
            await vi.waitFor(() => expect(page().onSharePersonal).toBeTypeOf('function'));
        }
        if (resourceMode) await vi.waitFor(() => expect(page().sharedEntries).toHaveLength(1));
        return { screen, page, account };
    }
    async function nextAccount() {
        for (const screen of screens.splice(0).reverse()) await screen.unmount();
        resetSavedSecretCatalogEngineForTests();
        resetSavedSecretCatalogSnapshotsForTests();
        await account?.dispose();
        account = undefined;
    }

    it('opens the grant picker for a still-personal secret and converts nothing until it is saved', async () => {
        const { screen, page, account } = await render();
        const secret = page().personalSecrets[0];
        const settingsWritesBeforeOpening = [...account.settingsWrites];
        await act(async () => { page().onSharePersonal?.(secret); });
        const editor = screen.tree.findByType(AccessComponent).props;
        expect(storage.getState().settingsScope).toEqual(account.scope);
        expect(storage.getState().settingsVersion).not.toBeNull();
        expect(editor.target).toEqual({ kind: 'personal', secret, expectedSettingsVersion: storage.getState().settingsVersion });
        expect(editor.scope).toEqual(account.scope);
        expect(page().accessEditor?.key).toBe(secret.id);
        expect(account.settingsWrites).toEqual(settingsWritesBeforeOpening);
        expect(account.resources).toEqual([]);
        await act(async () => { editor.onClose(); });
        expect(page().accessEditor).toBeNull();
        expect(screen.tree.findAllByType(AccessComponent)).toHaveLength(0);
        expect(account.settingsWrites).toEqual(settingsWritesBeforeOpening);
        expect(account.request.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/promote'))).toBe(false);
    });

    it('keeps personal editing available while hiding every shared mutation when disabled', async () => {
        const { screen, page } = await render({ sharedEnabled: false });
        expect(page().onRenamePersonal).toBeTypeOf('function');
        expect(page().onRotatePersonal).toBeTypeOf('function');
        expect(page().onDeletePersonal).toBeTypeOf('function');
        await act(async () => { page().onAdd(); });
        const editor = screen.tree.findByType(CreateComponent).props;
        expect(editor.onCreatePersonal).toBeTypeOf('function');
        expect(editor.sharedAvailable).toBe(false);
        expect(page().onSharePersonal).toBeUndefined();
        expect(page().onRenameShared).toBeUndefined();
        expect(page().onRotateShared).toBeUndefined();
        expect(page().onManageAccessShared).toBeUndefined();
        expect(page().onDeleteShared).toBeUndefined();
        expect(page().onRetrySharedCatalog).toBeUndefined();
        expect(page().approvalId).toBeNull();
    });

    it('exposes shared mutations when the exact Home decision is enabled', async () => {
        const { screen, page } = await render();
        await act(async () => { page().onAdd(); });
        expect(screen.tree.findByType(CreateComponent).props.sharedAvailable).toBe(true);
        expect(page().onSharePersonal).toBeTypeOf('function');
        expect(page().onRenameShared).toBeTypeOf('function');
        expect(page().onRotateShared).toBeTypeOf('function');
        expect(page().onManageAccessShared).toBeTypeOf('function');
        expect(page().onDeleteShared).toBeTypeOf('function');
    });

    it('keeps collision-rekey recovery reachable while shared hydration is blocked', async () => {
        const settings = settingsParse({ secrets: [{ id: 'happier:shared-secret:v1:resource-a',
            name: 'Personal collision', kind: 'token', encryptedValue: { _isSecretValue: true, value: 'personal-value' },
            createdAt: 1, updatedAt: 1 }] });
        const { screen, page, account } = await render({ settings, rejectSettingsWrites: true });
        await vi.waitFor(() => expect(account.settingsWrites.length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(page().onRetrySharedCatalog).toBeTypeOf('function'));
        expect(storage.getState().settings.secrets[0].id).toBe('happier:shared-secret:v1:resource-a');
        await act(async () => { page().onAdd(); });
        expect(screen.tree.findByType(CreateComponent).props.sharedAvailable).toBe(false);
    });

    it('preserves exact shared-secret rotation bytes, including an all-whitespace value', async () => {
        const { page, account } = await render({}, 'plain');
        await act(async () => { await page().onRotateShared?.(page().sharedEntries[0], '  token\n'); });
        await vi.waitFor(() => expect(account.updates).toHaveLength(1));
        expect(account.updates[0].storedContent).toEqual({ t: 'plain', v: { v: 1, name: 'Shared token', kind: 'token', value: '  token\n' } });
        await vi.waitFor(() => expect(page().sharedEntries[0].revision).toBe(4));
        await act(async () => { await page().onRotateShared?.(page().sharedEntries[0], '   '); });
        await vi.waitFor(() => expect(account.updates).toHaveLength(2));
        expect(account.updates[1].storedContent).toEqual({ t: 'plain', v: { v: 1, name: 'Shared token', kind: 'token', value: '   ' } });
        expect(account.resources[0]).toEqual(expect.objectContaining({ storedContent: account.updates[1].storedContent }));
    });

    it('confirms the trust change before an end-to-end encrypted secret becomes Home-managed', async () => {
        const { page, account } = await render({ mode: 'e2ee' }, 'e2ee');
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        await act(async () => { page().onMakeSharedHomeManaged?.(page().sharedEntries[0]); });
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(account.updates).toEqual([]);
        expect(account.resources[0]).toEqual(expect.objectContaining({ encryptionMode: 'e2ee' }));
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        await act(async () => { page().onMakeSharedHomeManaged?.(page().sharedEntries[0]); });
        await vi.waitFor(() => expect(account.updates).toHaveLength(1));
        expect(account.updates[0]).toEqual(expect.objectContaining({ resourceId: 'resource-a', expectedRevision: 3, toMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Shared token', kind: 'token', value: 'shared-value' } } }));
        await vi.waitFor(() => expect(page().sharedEntries[0].encryptionMode).toBe('plain'));
        await act(async () => { page().onEncryptShared?.(page().sharedEntries[0]); });
        await vi.waitFor(() => expect(account.updates).toHaveLength(2));
        expect(account.updates[1]).toEqual(expect.objectContaining({ expectedRevision: 4, toMode: 'e2ee', storedContent: { t: 'encrypted', c: expect.any(String) } }));
        expect(JSON.stringify(account.updates[1])).not.toContain('shared-value');
        await vi.waitFor(() => expect(page().resolveSharedReference('happier:shared-secret:v1:resource-a')).toEqual(expect.objectContaining({
            status: 'ready', revision: 5,
            secret: expect.objectContaining({ encryptedValue: { _isSecretValue: true, value: 'shared-value' } }),
        })));
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
    });

    it('offers each conversion direction only where the Account and the Home policy allow it', async () => {
        const plain = await render();
        expect(plain.page().onEncryptShared).toBeUndefined();
        expect(plain.account.encryption).toBeNull();
        await nextAccount();
        const requiredE2ee = await render({ mode: 'e2ee', plaintextStorageEnabled: false });
        expect(requiredE2ee.page().onMakeSharedHomeManaged).toBeUndefined();
        expect(requiredE2ee.page().onEncryptShared).toBeTypeOf('function');
        await nextAccount();
        const both = await render({ mode: 'e2ee', plaintextStorageEnabled: true });
        expect(both.page().onMakeSharedHomeManaged).toBeTypeOf('function');
        expect(both.page().onEncryptShared).toBeTypeOf('function');
    });

    async function renderCorrupt(settings?: ReturnType<typeof settingsParse>) {
        account = await createSecretSettingsTestHarness({ settings });
        account.resources.push(SavedSecretResourceMaterialV1Schema.parse({ entry: ownerCorrupt }),
            SavedSecretResourceMaterialV1Schema.parse({ entry: { materialStatus: 'resource_corrupt', relationship: 'recipient', repair: null } }));
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><Screen /></InjectedAuthProvider>);
        screens.push(screen);
        const page = (): SecretsSettingsPageProps => screen.tree.findByType<typeof PageComponent>(PageComponent).props;
        await vi.waitFor(() => expect(page().corruptEntries).toHaveLength(2));
        return { page, account };
    }
    it('confirms owner corrupt-row deletion and sends its exact opaque identity and revision', async () => {
        const { page, account } = await renderCorrupt();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        await act(async () => { page().onDeleteCorruptShared?.(ownerCorrupt); });
        await vi.waitFor(() => expect(account.deletes).toEqual([{ resourceId: 'opaque-corrupt-row', expectedRevision: -3 }]));
        expect(Modal.confirm).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ destructive: true }));
        expect(account.resources).toHaveLength(1);
        expect(account.resources[0].entry.relationship).toBe('recipient');
    });

    it('names the bindings when the owner reference census refuses a corrupt-row deletion', async () => {
        const settings = settingsParse({ mcpServersSettingsV1: McpServersSettingsV1Schema.parse({ v: 1, strictMode: false,
            servers: [{ id: 'srv', name: 'server', transport: 'stdio', stdio: { command: 'node', args: [] },
                env: { TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:opaque-corrupt-row' } }, createdAt: 1, updatedAt: 1 }], bindings: [] }) });
        const { page, account } = await renderCorrupt(settings);
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        await act(async () => { page().onDeleteCorruptShared?.(ownerCorrupt); });
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('mcpServersSettingsV1.servers[0].env.TOKEN')));
        expect(account.deletes).toEqual([]);
        expect(account.resources).toHaveLength(2);
    });

    it('prepares the envelopes this custodian owes when the surface is opened', async () => {
        account = await createSecretSettingsTestHarness({ mode: 'e2ee' });
        const { resourceDataKey } = await account.addOwnerResource('e2ee');
        const recipient = await createEncryptionFromAuthCredentials({ token: 'recipient-token', secret: encodeBase64(new Uint8Array(32).fill(9), 'base64url') });
        account.recipients.push({ account: { kind: 'account', accountId: 'account-b', firstName: 'Bob', lastName: null, username: null, avatarUrl: null },
            readiness: { status: 'available', contentPublicKey: encodeBase64(recipient.contentDataKey, 'base64'),
                contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.contentDataKey) }, envelopeStatus: 'missing' });
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><Screen /></InjectedAuthProvider>);
        screens.push(screen);
        await vi.waitFor(() => expect(account?.repairs).toHaveLength(1));
        const repair = account.repairs[0];
        expect(repair).toEqual({ resourceId: 'resource-a', expectedRevision: 3,
            keyEnvelopes: [{ recipientAccountId: 'account-b', encryptedDataKey: expect.any(String),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.contentDataKey) }] });
        expect(await recipient.decryptEncryptionKey(repair.keyEnvelopes[0].encryptedDataKey, account.scope)).toEqual(resourceDataKey);
        expect(JSON.stringify(repair)).not.toContain(encodeBase64(resourceDataKey, 'base64'));
        expect(account.updates).toEqual([]);
    });

    it('asks a plaintext Account for nothing, since it custodies no envelopes at all', async () => {
        const { account } = await render({}, 'plain');
        expect(account.encryption).toBeNull();
        expect('secret' in account.credentials).toBe(false);
        expect(account.repairs).toEqual([]);
        expect(account.request.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/envelope-census'))).toBe(false);
    });
});
