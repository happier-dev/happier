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
import { getSavedSecretCatalogSnapshot, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
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
    return createModalModuleMock().module;
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
    {
        resourceId: 'shared-preparing', encryptionMode: 'e2ee', storedContent: null, recipientEnvelope: null,
        entry: { ...readyEntry, ref: 'happier:shared-secret:v1:shared-preparing', name: 'Preparing key',
            encryptionMode: 'e2ee', materialStatus: 'preparing_encrypted_access',
            capabilities: { ...readyEntry.capabilities, use: false } },
    },
    { entry: { materialStatus: 'resource_corrupt', relationship: 'owner',
        repair: { kind: 'delete_resource', resourceId: 'opaque-corrupt-row', expectedRevision: 4 } } },
] });

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let scope: ServerAccountScope;
let materialUnavailable = false;
let writes: string[] = [];

/**
 * The picker is shared between callers that own the secret list (MCP value refs, provider
 * connections) and callers whose own flow carries the disclosure for writing a credential. Only the
 * first group may mutate a stored record from inside the picker.
 */
describe('SavedSecretPickerModal', () => {
    beforeAll(async () => {
        await loadSyncSingletonForTests();
    });

    beforeEach(async () => {
        materialUnavailable = false;
        writes = [];
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
                    if (materialUnavailable) return new Response('{}', { status: 503 });
                    return Response.json(materialReply);
                }
                return new Response('{}', { status: 404 });
            },
        });
        scope = { serverId: connection.home.id, accountId: 'account-a' };
        expect(storage.getState().settingsScope).toEqual(scope);
        storage.setState({ settingsVersion: 1 });
        primeServerFeaturesSnapshot({ serverId: scope.serverId, snapshot: { status: 'ready', features } });
        await refreshSavedSecretCatalog(scope);
    });

    afterEach(async () => {
        await standardCleanup();
        resetSavedSecretCatalogEngineForTests();
        resetSavedSecretCatalogSnapshotsForTests();
        await connection?.dispose();
        connection = undefined;
    });

    it('keeps rename, replace, delete and add for consumers that own the secret list', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');

        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose: vi.fn(),
            selectedId: null,
            onSelectId: vi.fn(),
        }));
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${privateRef}:rename`)).toBeTruthy());

        for (const action of ['rename', 'replace', 'delete']) {
            expect(screen.findByTestId(`saved-secret:${privateRef}:${action}`)).toBeTruthy();
        }
        expect(screen.findByTestId('saved-secret-add')).toBeTruthy();
        expect(screen.findByTestId('saved-secret:none')).toBeTruthy();
    });

    it('is a pure selector when the caller owns the credential write: select an existing id or dismiss', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');
        const onSelectId = vi.fn();
        const onClose = vi.fn();

        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose,
            selectedId: null,
            onSelectId,
            includeNoneRow: false,
            allowAdd: false,
            allowEdit: false,
        }));

        // Nothing in the tree can create, replace, rename or delete a stored record.
        for (const action of ['rename', 'replace', 'delete']) {
            expect(screen.findByTestId(`saved-secret:${privateRef}:${action}`)).toBeNull();
        }
        expect(screen.findByTestId('saved-secret-add')).toBeNull();
        expect(screen.findByTestId('saved-secret:none')).toBeNull();

        // Selecting an already-stored record stays the whole point of the surface.
        await vi.waitFor(() => expect(screen.findAllByTestId(`saved-secret:${privateRef}`)
            .some(node => typeof node.props.onPress === 'function')).toBe(true));
        screen.pressByTestId(`saved-secret:${privateRef}`);
        expect(onSelectId).toHaveBeenCalledWith(privateRef);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(writes).toEqual([]);
        expect(storage.getState().settings.secrets).toEqual([]);
    });

    it('settles reference-only selection with the current exact revision and no material in its result', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');
        const onSelect = vi.fn();
        const onSelectId = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose, selectedId: null, onSelectId,
            referenceSelection: { selected: null, onSelect },
        }));
        await vi.waitFor(() => expect(screen.findAllByTestId(`saved-secret:${readyEntry.ref}`)
            .find(node => typeof node.props.title === 'string')?.props.disabled).toBe(false));
        screen.pressByTestId('saved-secret:happier:shared-secret:v1:shared-ready');
        expect(onSelect).toHaveBeenCalledWith({ ref: readyEntry.ref, resourceRevision: readyEntry.revision });
        expect(onSelectId).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
        expect(writes).toEqual([]);
        expect(JSON.stringify(onSelect.mock.calls)).not.toContain('shared-value');
    });

    it('selects ready shared resources and keeps preparing access visible but disabled', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');
        const onSelectId = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose, selectedId: null, onSelectId,
        }));

        await vi.waitFor(() => expect(screen.findAllByTestId(`saved-secret:${readyEntry.ref}`)
            .find(node => typeof node.props.title === 'string')?.props.disabled).toBe(false));
        screen.pressByTestId('saved-secret:happier:shared-secret:v1:shared-ready');
        expect(onSelectId).toHaveBeenCalledWith('happier:shared-secret:v1:shared-ready');
        expect(onClose).toHaveBeenCalledTimes(1);

        const preparing = screen.findAllByTestId('saved-secret:happier:shared-secret:v1:shared-preparing')
            .find(node => typeof node.props.title === 'string');
        expect(preparing?.props.disabled).toBe(true);
        expect(preparing?.props.onPress).toBeUndefined();
        expect(screen.findByTestId('saved-secret-corrupt:owner:0')).toBeNull();
    });

    it('keeps retained stale metadata visible but unavailable, then restores selection after reload', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');
        const onSelectId = vi.fn();
        const onClose = vi.fn();
        const pickerProps = {
            onClose,
            selectedId: 'happier:shared-secret:v1:shared-ready',
            onSelectId,
        };
        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, pickerProps));
        await vi.waitFor(() => expect(screen.findAllByTestId(`saved-secret:${readyEntry.ref}`)
            .find(node => typeof node.props.title === 'string')?.props.disabled).toBe(false));
        materialUnavailable = true;
        await act(async () => {
            await expect(refreshSavedSecretCatalog(scope)).rejects.toThrow();
        });

        const staleRow = screen.findAllByTestId('saved-secret:happier:shared-secret:v1:shared-ready')
            .find(node => typeof node.props.title === 'string');
        expect(staleRow?.props.subtitle).toBe('secrets.catalog.status.temporarily_unavailable');
        expect(staleRow?.props.selected).toBe(true);
        expect(staleRow?.props.disabled).toBe(true);
        expect(staleRow?.props.onPress).toBeUndefined();
        expect(onClose).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-catalog-retry')).toBeTruthy());
        materialUnavailable = false;
        await screen.pressByTestIdAsync('saved-secret-catalog-retry');
        await act(async () => {
            await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready', stale: false }));
        });

        const restoredRow = screen.findAllByTestId('saved-secret:happier:shared-secret:v1:shared-ready')
            .find(node => typeof node.props.title === 'string');
        expect(restoredRow?.props.selected).toBe(true);
        expect(restoredRow?.props.disabled).toBe(false);
        screen.pressByTestId('saved-secret:happier:shared-secret:v1:shared-ready');
        expect(onSelectId).toHaveBeenCalledWith('happier:shared-secret:v1:shared-ready');
        expect(onClose).toHaveBeenCalledOnce();
    });
});
