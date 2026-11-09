import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AccountSettingsV2GetResponseSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import {
    CurrentCursorResponseSchema} from '@happier-dev/protocol/changes';
import {
    FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    SavedSecretCatalogEntryV1Schema,
    SavedSecretResourceMaterialsResponseV1Schema} from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import {
    sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { refreshSavedSecretCatalog, resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const privateRef = 'happier:shared-secret:v1:secret-1';

// Native/window and modal adapters remain boundaries; all settings/catalog/UI owners stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1280, height: 900, scale: 1, fontScale: 1 }),
    });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
const readyEntry = SavedSecretCatalogEntryV1Schema.parse({
    ref: 'happier:shared-secret:v1:shared-ready', source: 'shared_resource', relationship: 'recipient',
    name: 'Team key', kind: 'apiKey', encryptionMode: 'plain', ownerAccountId: 'owner-a', revision: 1,
    materialStatus: 'ready',
    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
});
const materialReply = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [
    {
        resourceId: 'secret-1', encryptionMode: 'plain', recipientEnvelope: null,
        entry: {
            ...readyEntry, ref: privateRef, relationship: 'owner', ownerAccountId: 'account-a',
            name: 'qa_saved_secret', audience: { accounts: [], teams: [], groups: [] },
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
        },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'secret-1', mode: 'plain',
            content: { v: 1, name: 'qa_saved_secret', kind: 'apiKey', value: 'sk-stored' } }),
    },
    {
        resourceId: 'shared-ready', encryptionMode: 'plain', entry: readyEntry,
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'shared-ready', mode: 'plain',
            content: { v: 1, name: 'Team key', kind: 'apiKey', value: 'shared-value' } }),
        recipientEnvelope: null,
    },
] });

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let scope: ServerAccountScope;
let writes: string[] = [];
let materialReads = 0;

/** Real catalog and picker owners, with only native, modal and authenticated HTTP boundaries adapted. */
describe('ConnectedAccountConfigurationForm Saved Secrets', () => {
    beforeAll(async () => {
        await loadSyncSingletonForTests();
    });

    beforeEach(async () => {
        writes = [];
        materialReads = 0;
        resetSavedSecretCatalogEngineForTests();
        resetSavedSecretCatalogSnapshotsForTests();
        resetServerFeaturesClientForTests();
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://secret-picker.example.test', accountId: 'account-a',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const bootstrap = createEmptyAccountBootstrapHttpResponse(path, init);
                if (bootstrap) return bootstrap;
                if (path === '/v1/account/project-rows/list') return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
                if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
                if (init?.method && init.method !== 'GET') {
                    writes.push(path);
                    return new Response('{}', { status: 405 });
                }
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features') return Response.json(features);
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
                    content: { t: 'plain', v: { secrets: [], experiments: true } }, version: 1,
                }));
                if (path === '/v1/account/saved-secrets/resources') {
                    return Response.json({ resources: materialReply.resources.map(resource => resource.entry) });
                }
                if (path === '/v1/account/saved-secrets/resources/materials') {
                    materialReads += 1;
                    return Response.json(materialReply);
                }
                return new Response('{}', { status: 404 });
            },
        });
        scope = { serverId: connection.home.id, accountId: 'account-a' };
        expect(storage.getState().settingsScope).toEqual(scope);
        storage.setState({ settingsVersion: 1 });
        primeServerFeaturesSnapshot({ serverId: scope.serverId, snapshot: { status: 'ready', features } });
        await refreshSavedSecretCatalog(scope, { includeMaterial: false });
    });

    afterEach(async () => {
        const { Modal } = await import('@/modal');
        await act(async () => { Modal.hideAll(); });
        const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        clearActiveUnsavedChangesGuard();
        await standardCleanup();
        resetSavedSecretCatalogEngineForTests();
        resetSavedSecretCatalogSnapshotsForTests();
        await connection?.dispose();
        connection = undefined;
    });

    it('settles manual Saved Secret selection without render churn and submits only the reference', async () => {
        const { ModalProvider } = await import('@/modal');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { ConnectedAccountManualForm } = await import('./ConnectedAccountManualForm');
        const { ConnectedAccountAuthenticationCommandSchemas } = await import('@happier-dev/protocol/connect/connectedAccountDaemonRpcV1');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected active Account lifetime');
        const onSubmit = vi.fn<React.ComponentProps<typeof ConnectedAccountManualForm>['onSubmit']>(async () => true);
        let commits = 0;
        const fields = [{ id: 'token', title: 'API key', secret: true,
            schema: { type: 'string', pattern: '^sk-' } }] as const;
        const form = (manualFields: React.ComponentProps<typeof ConnectedAccountManualForm>['fields']) => (
            <ModalProvider><React.Profiler id="manual-saved-secret" onRender={() => {
                commits += 1;
                // Fail an actual feedback loop instead of leaving the test worker spinning.
                if (commits > 50) throw new Error('Manual Saved Secret selection did not settle within 50 commits');
            }}><ConnectedAccountManualForm
            title="API key" fields={manualFields}
            accountLifetime={accountLifetime} submitting={false} onSubmit={onSubmit}
        /></React.Profiler></ModalProvider>);
        const screen = await renderScreen(form(fields));
        await screen.pressByTestIdAsync('connected-account-manual:token:choose');
        await vi.waitFor(() => expect(screen.findAllByTestId(`saved-secret:${privateRef}`)
            .find(node => typeof node.props.title === 'string')?.props.disabled).toBe(false));
        commits = 0;
        await screen.pressByTestIdAsync(`saved-secret:${privateRef}`);
        const settledCommits = commits;
        await act(async () => {});
        expect(commits).toBe(settledCommits);
        expect(settledCommits).toBeLessThan(5);
        // Descriptor discovery may reorder equal object keys without changing the mode.
        await screen.update(form([{ schema: { pattern: '^sk-', type: 'string' },
            secret: true, title: 'API key', id: 'token' }]));
        const afterDescriptor = commits;
        await act(async () => {});
        expect(commits).toBe(afterDescriptor);
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(onSubmit).toHaveBeenLastCalledWith({ fields: {},
            selectedSecrets: { token: { ref: privateRef, resourceRevision: 1 } } });
        expect(ConnectedAccountAuthenticationCommandSchemas.submitManual.parse({
            operation: 'submitManual', attemptId: 'attempt-1', ...onSubmit.mock.calls.at(-1)?.[0],
        }).selectedSecrets).toEqual({ token: { ref: privateRef, resourceRevision: 1 } });
        expect(screen.findHostByTestId('connected-account-manual:token')).toBeNull();
        await screen.pressByTestIdAsync('connected-account-manual:token:clear');
        await act(async () => {
            screen.findHostByTestId('connected-account-manual:token')!.props.onChangeText('sk-entered');
        });
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(onSubmit).toHaveBeenLastCalledWith({ fields: { token: 'sk-entered' } });
        expect(materialReads).toBe(0);
        expect(writes).toEqual([]);
        expect(JSON.stringify(onSubmit.mock.calls)).not.toContain('sk-stored');
    });

    it('offers the shared reference picker for every bundled manual secret descriptor', async () => {
        const { ModalProvider } = await import('@/modal');
        const { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { ConnectedAccountManualForm } = await import('./ConnectedAccountManualForm');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected active Account lifetime');
        const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
        for (const [service, { descriptor }] of Object.entries(BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS)) {
            for (const mode of descriptor.authentication?.modes ?? []) {
                if (mode.kind !== 'manual' || !mode.fields.some(field => field.secret === true)) continue;
                await screen.update(<ModalProvider><ConnectedAccountManualForm
                    title={service} fields={mode.fields} accountLifetime={accountLifetime}
                    submitting={false} onSubmit={() => true}
                /></ModalProvider>);
                for (const field of mode.fields) {
                    const choices = screen.findAllByTestId(`connected-account-manual:${field.id}:choose`);
                    expect(choices.some(node => typeof node.props.onPress === 'function'),
                        `${service}/${mode.id}/${field.id}`).toBe(field.secret === true);
                }
            }
        }
        expect(materialReads).toBe(0);
    });

    it('stages choose, replace, cancel and clear until Save without acquiring any secret material', async () => {
        const { Modal, ModalProvider } = await import('@/modal');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected active Account lifetime');
        const onSubmit = vi.fn(async () => true);
        const screen = await renderScreen(<ModalProvider><ConnectedAccountConfigurationForm
            title="Configuration"
            fields={[{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }]}
            values={{}} configuredSecretFieldIds={[]} secretRefs={{}} accountLifetime={accountLifetime}
            saving={false} onSubmit={onSubmit}
        /></ModalProvider>, { wrapper: React.StrictMode });
        const pick = async (ref: string) => {
            await screen.pressByTestIdAsync('connected-account-configuration:token:choose');
            await vi.waitFor(() => expect(screen.findAllByTestId(`saved-secret:${ref}`)
                .find(node => typeof node.props.title === 'string')?.props.disabled).toBe(false));
            await screen.pressByTestIdAsync(`saved-secret:${ref}`);
        };
        expect(screen.findHostByTestId('connected-account-configuration:token')).toBeNull();
        await pick(privateRef);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        expect(onSubmit).toHaveBeenLastCalledWith({ values: {}, secretValues: {},
            selectedSecrets: { token: { ref: privateRef, resourceRevision: 1 } } });
        await pick(readyEntry.ref);
        await vi.waitFor(() => expect(screen.tree.find(node =>
            node.props.testID === 'connected-account-configuration:token:choose'
            && typeof node.props.title === 'string').props.detail).toBe('Team key'));
        expect(onSubmit).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('connected-account-configuration:token:choose');
        const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        await act(async () => { config?.onRequestClose?.(); });
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        expect(onSubmit).toHaveBeenLastCalledWith({ values: {}, secretValues: {},
            selectedSecrets: { token: { ref: readyEntry.ref, resourceRevision: 1 } } });
        await screen.pressByTestIdAsync('connected-account-configuration:token:clear');
        expect(onSubmit).toHaveBeenCalledTimes(2);
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        expect(onSubmit).toHaveBeenLastCalledWith({ values: {}, secretValues: {}, selectedSecrets: { token: null } });
        await act(async () => { await getActiveUnsavedChangesGuard()?.onDiscard?.(); });
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current ?? false).toBe(false);
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        expect(onSubmit).toHaveBeenLastCalledWith({ values: {}, secretValues: {}, selectedSecrets: {} });
        expect(materialReads).toBe(0);
        expect(writes).toEqual([]);
        expect(JSON.stringify(onSubmit.mock.calls)).not.toContain('shared-value');
        expect(JSON.stringify(onSubmit.mock.calls)).not.toContain('sk-stored');
    });

    it('retires open pickers on Save and unmount without applying a late selection', async () => {
        const { ModalProvider } = await import('@/modal');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const { SavedSecretPickerModal } = await import('@/components/ui/forms/valueRefs/SavedSecretPickerModal');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected active Account lifetime');
        const onSubmit = vi.fn(async () => true);
        const form = (saving: boolean) => <ModalProvider><ConnectedAccountConfigurationForm
            title="Configuration" fields={[{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }]}
            values={{}} configuredSecretFieldIds={[]} secretRefs={{}} accountLifetime={accountLifetime}
            saving={saving} onSubmit={onSubmit}
        /></ModalProvider>;
        const screen = await renderScreen(form(false));
        await screen.pressByTestIdAsync('connected-account-configuration:token:choose');
        const lateSelect = screen.tree.findByType(SavedSecretPickerModal).props.referenceSelection.onSelect;
        await screen.update(form(true));
        expect(screen.tree.findAllByType(SavedSecretPickerModal)).toHaveLength(0);
        await act(async () => { lateSelect({ ref: readyEntry.ref, resourceRevision: 1 }); });
        await screen.update(form(false));
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        expect(onSubmit).toHaveBeenLastCalledWith({ values: {}, secretValues: {}, selectedSecrets: {} });
        await screen.pressByTestIdAsync('connected-account-configuration:token:choose');
        expect(screen.tree.findAllByType(SavedSecretPickerModal)).toHaveLength(1);
        await screen.update(<ModalProvider>{null}</ModalProvider>);
        expect(screen.tree.findAllByType(SavedSecretPickerModal)).toHaveLength(0);
        expect(materialReads).toBe(0);
    });
});
