import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { buildSessionWorkspaceOrderScopeKey } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import type { SessionFolderV1 } from '@/sync/domains/session/folders/types';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { treeRowId } from './drop-resolution/treeRowId';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

const boundary = vi.hoisted(() => ({ reorder: vi.fn(), upsertFolder: vi.fn(), credentials: vi.fn(), alert: vi.fn() }));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return await createTokenStorageModuleMock({ importOriginal, tokenStorage: { getCredentialsForServerUrl: boundary.credentials } });
});
vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return { ...actual, reorderSessionOrganization: boundary.reorder, upsertSessionOrganizationFolder: boundary.upsertFolder };
});
vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => {
    const { createAccountEncryptionModeModuleMock } = await import('@/dev/testkit/mocks/accountEncryptionMode');
    return await createAccountEncryptionModeModuleMock({ importOriginal, overrides: { fetchAccountEncryptionMode: async () => ({ mode: 'plain', updatedAt: 0 }) } });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: boundary.alert } }).module;
});

describe('mounted Session list organization writer bridge', () => {
    let scope: SessionOrganizationMutationScope;

    beforeEach(async () => {
        boundary.reorder.mockReset();
        boundary.upsertFolder.mockReset();
        boundary.credentials.mockReset();
        boundary.alert.mockClear();
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = await profiles.upsertServerProfile({ serverUrl: 'https://list-write.example.test', name: 'Writer Home' });
        scope = { credentials: { token: 'captured-account-token', secret: 'captured-secret' }, serverId: profile.id, serverIdAliases: [], serverUrl: profile.serverUrl };
        boundary.credentials.mockResolvedValue({ token: 'replacement-account-token', secret: 'replacement-secret' });
    });
    afterEach(standardCleanup);

    it.each(['group', 'workspace'] as const)('keeps %s acknowledgement pending and propagates a real API rejection with captured credentials', async (kind) => {
        const { useSessionListOrganizationWriters } = await import('./useSessionListOrganizationWriters');
        const requestReached = createDeferred<void>();
        const response = createDeferred<Awaited<ReturnType<typeof import('@/sync/api/session/sessionOrganizationApi').reorderSessionOrganization>>>();
        boundary.reorder.mockImplementation(() => { requestReached.resolve(); return response.promise; });
        const itemKey = sessionAddressKey({ serverId: scope.serverId, sessionId: 'session-a' });
        const hook = await renderHook(() => useSessionListOrganizationWriters({
            availableSessionFoldersV1: { v: 1, folders: [] },
            orderItemAddressByItemKey: { [itemKey]: { itemKind: 'session', serverId: scope.serverId, sessionId: 'session-a' } },
        }));
        const writer = kind === 'group' ? hook.getCurrent().setSessionListGroupOrderV1 : hook.getCurrent().setSessionWorkspaceOrderV1;
        const next = kind === 'group' ? { 'project-a': [itemKey] } : { [buildSessionWorkspaceOrderScopeKey(scope.serverId)]: ['workspace-a'] };
        const write = writer(next, scope);
        // This is the Action-facing production callback, not a fixture returning a made-up promise.
        expect(write).toBeInstanceOf(Promise);
        let settled = false;
        const outcome = Promise.resolve(write).then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
        await requestReached.promise;
        expect(settled).toBe(false);
        expect(boundary.reorder.mock.calls[0]?.[0]).toMatchObject({ credentials: scope.credentials, serverUrl: scope.serverUrl });
        response.reject(new Error('Network acknowledgement lost'));
        expect(await outcome).toMatchObject({ code: 'session_organization_write_failed' });
        expect(boundary.alert).not.toHaveBeenCalled();
        expect(Object.keys(getStorage().getState().sessionOrganizationOrderEntriesByScopeKey)).toHaveLength(0);
        expect(boundary.credentials).not.toHaveBeenCalled();
    });

    it('awaits the captured Home folder write while excluding changed same-id folders from another Home', async () => {
        const { useSessionListOrganizationWriters } = await import('./useSessionListOrganizationWriters');
        const folder = (serverId: string, name: string): SessionFolderV1 => ({
            id: 'same-folder', name, parentId: null, createdAt: 1, updatedAt: 1,
            workspace: { t: 'workspaceScope', serverId, machineId: 'machine-a', rootPath: '/repo' },
        });
        const requestReached = createDeferred<void>();
        const response = createDeferred<Awaited<ReturnType<typeof import('@/sync/api/session/sessionOrganizationApi').upsertSessionOrganizationFolder>>>();
        boundary.upsertFolder.mockImplementation(() => { requestReached.resolve(); return response.promise; });
        const hook = await renderHook(() => useSessionListOrganizationWriters({
            availableSessionFoldersV1: { v: 1, folders: [folder(scope.serverId, 'Before'), folder('foreign-home', 'Foreign before')] },
            orderItemAddressByItemKey: {},
        }));
        const pending = hook.getCurrent().setSessionFoldersV1({ v: 1, folders: [folder(scope.serverId, 'After'), folder('foreign-home', 'Foreign after')] }, scope);
        let settled = false;
        const outcome = Promise.resolve(pending).then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
        await requestReached.promise;
        expect(settled).toBe(false);
        expect(boundary.upsertFolder.mock.calls.map(([request]) => request)).toEqual([expect.objectContaining({
            credentials: scope.credentials,
            serverUrl: scope.serverUrl,
            request: expect.objectContaining({ folderId: 'same-folder', display: expect.objectContaining({ v: expect.objectContaining({ name: 'After' }) }) }),
        })]);
        response.reject(new Error('Folder acknowledgement lost'));
        expect(await outcome).toMatchObject({ code: 'session_organization_write_failed' });
        expect(boundary.alert).not.toHaveBeenCalled();
        expect(boundary.credentials).not.toHaveBeenCalled();
    });

    it('keeps the mounted organization Action pending until the real bridge reports the rejected write as unknown', async () => {
        const { useSessionListOrganizationWriters } = await import('./useSessionListOrganizationWriters');
        const { createSessionListOrganizationActionAdapter, registerMountedSessionListOrganizationAction, invokeSessionListOrganizationAction } = await import('./drag/sessionListOrganizationAction');
        const { writeSessionOrganizationFolderAssignment } = await import('@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner');
        const requestReached = createDeferred<void>();
        const response = createDeferred<Awaited<ReturnType<typeof import('@/sync/api/session/sessionOrganizationApi').reorderSessionOrganization>>>();
        boundary.reorder.mockImplementation(() => { requestReached.resolve(); return response.promise; });
        const entityScope = { serverId: scope.serverId, accountId: 'captured-account' };
        const workspace = { t: 'workspaceScope' as const, serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' };
        const latestItems: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Project', groupKey: 'project-a', workspaceKey: 'project-a', workspace, serverId: scope.serverId },
            ...['session-a', 'session-b'].map((sessionId) => ({ type: 'session' as const, sessionId, serverId: scope.serverId, groupKey: 'project-a', groupKind: 'project' as const, workspace, storageKind: 'persisted' as const, folderId: null, folderDepth: 0 })),
        ];
        const addresses = Object.fromEntries(['session-a', 'session-b'].map((sessionId) => [sessionAddressKey({ serverId: scope.serverId, sessionId }), { itemKind: 'session' as const, serverId: scope.serverId, sessionId }]));
        await renderHook(() => {
            const writers = useSessionListOrganizationWriters({ availableSessionFoldersV1: { v: 1, folders: [] }, orderItemAddressByItemKey: addresses });
            React.useEffect(() => registerMountedSessionListOrganizationAction(createSessionListOrganizationActionAdapter(() => ({
                scope: entityScope, latestItems, sessionFoldersV1: { v: 1, folders: [] }, sessionListGroupOrderV1: {}, sessionWorkspaceOrderV1: {},
                sessionListOrderingModeV1: 'custom', sessionListSectionModeV1: 'activity', manualSessionOrderingEnabled: true,
                isFolderOrganizationEnabled: () => true, now: () => 1,
                setSessionListGroupOrderV1: next => writers.setSessionListGroupOrderV1(next, scope),
                setSessionWorkspaceOrderV1: next => writers.setSessionWorkspaceOrderV1(next, scope),
                setSessionFoldersV1: next => writers.setSessionFoldersV1(next, scope),
                setSessionFolderAssignment: input => writeSessionOrganizationFolderAssignment({ scope, sessionId: input.sessionId, folderId: input.folderId }),
            }))), [writers.setSessionListGroupOrderV1, writers.setSessionWorkspaceOrderV1, writers.setSessionFoldersV1]);
        });
        const pending = invokeSessionListOrganizationAction({ mutationScope: scope, input: {
            scope: entityScope, sourceRowId: treeRowId.session(scope.serverId, 'session-b'), sourceKind: 'leaf', instructionKind: 'reorder-before',
            targetRowId: treeRowId.session(scope.serverId, 'session-a'), containerId: treeRowId.workspaceRoot('project-a'), parentRowId: null, depth: 0, edge: 'top',
        } });
        let settled = false;
        void pending.then(() => { settled = true; });
        expect(await Promise.race([requestReached.promise.then(() => null), pending])).toBeNull();
        expect(settled).toBe(false);
        response.reject(new Error('Acknowledgement lost'));
        expect(await pending).toEqual({ status: 'unknown', reason: 'organization_write_outcome_unknown' });
        expect(boundary.alert).not.toHaveBeenCalled();
    });
});
