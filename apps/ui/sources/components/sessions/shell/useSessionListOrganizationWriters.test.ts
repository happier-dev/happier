import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { buildSessionWorkspaceOrderScopeKey } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';

const boundary = vi.hoisted(() => ({ reorder: vi.fn(), credentials: vi.fn(), alert: vi.fn() }));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return await createTokenStorageModuleMock({ importOriginal, tokenStorage: { getCredentialsForServerUrl: boundary.credentials } });
});
vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return { ...actual, reorderSessionOrganization: boundary.reorder };
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: boundary.alert } }).module;
});

describe('mounted Session list organization writer bridge', () => {
    let scope: SessionOrganizationMutationScope;

    beforeEach(async () => {
        boundary.reorder.mockReset();
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
        const itemKey = `${scope.serverId}:session-a`;
        const hook = await renderHook(() => useSessionListOrganizationWriters({
            activeOrganizationServerId: scope.serverId,
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
        expect(Object.keys(getStorage().getState().sessionOrganizationOrderEntriesByKey)).toHaveLength(0);
        expect(boundary.credentials).not.toHaveBeenCalled();
    });
});
