import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReorderSessionOrganizationRequestSchema, SetSessionFolderAssignmentRequestSchema } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

// Network and device credentials are the genuine boundaries; encryption-mode
// admission, the organization owner, and its store projection remain real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
beforeEach(async () => { await home.reset(); });
afterEach(() => standardCleanup());

describe('Session organization Action scope', () => {
    it('returns the published unavailable result when the captured Account retires before dispatch', async () => {
        const serverId = await home.addHome({ name: 'Retired Home', serverUrl: 'https://retired-home.example', accountId: 'account-a' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const { createSessionOrganizationMutationScopeForAccount } = await import('./sessionOrganizationMutationOwner');
        const mutationScope = createSessionOrganizationMutationScopeForAccount(account);
        await home.switchAccount(serverId, 'account-b');
        const { createSessionListOrganizationActionAdapter } = await import('@/components/sessions/shell/drag/sessionListOrganizationAction');
        const execute = createSessionListOrganizationActionAdapter(() => null);
        expect(await execute({ mutationScope, input: {
            scope: { serverId, accountId: 'account-a' }, sourceRowId: 'session-a', sourceKind: 'leaf',
            instructionKind: 'move-to-root', targetRowId: null, containerId: null, parentRowId: null, depth: null, edge: null,
        } })).toEqual({ status: 'unavailable' });
        account.dispose();
    });

    it.each(['order', 'folder assignment'] as const)('does not apply an acknowledged %s response into a replacement Account', async (kind) => {
        const serverId = await home.addHome({ name: 'Order Home', serverUrl: 'https://order-home.example', accountId: 'account-a' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const started = createDeferred<void>();
        const response = createDeferred<void>();
        home.answer(serverId, kind === 'order' ? 'PUT /v2/session-organization/order' : 'PUT /v2/session-organization/folder-assignments/session-a', {
            select: input => {
                started.resolve();
                if (kind === 'order') {
                    const request = ReorderSessionOrganizationRequestSchema.parse(input);
                    return { body: { orderEntries: request.entries.map(entry => ({ ...entry, scopeKind: request.scopeKind, scopeKey: request.scopeKey })) }, respondAfter: response.promise };
                }
                return { body: { sessionId: 'session-a', folderId: SetSessionFolderAssignmentRequestSchema.parse(input).folderId }, respondAfter: response.promise };
            },
        });
        const { createSessionOrganizationMutationScopeForAccount, writeSessionOrganizationGroupOrder } = await import('./sessionOrganizationMutationOwner');
        const { createSessionOrganizationResourceAction } = await import('./sessionOrganizationAction');
        const itemKey = `${serverId}:session-a`;
        const scope = createSessionOrganizationMutationScopeForAccount(account);
        const writing = kind === 'order' ? writeSessionOrganizationGroupOrder({
            scope,
            next: { project: [itemKey] },
            orderItemAddressByItemKey: { [itemKey]: { itemKind: 'session', serverId, sessionId: 'session-a' } },
        }) : createSessionOrganizationResourceAction(account)({ actionId: 'session.folder.set',
            input: { sessionId: 'session-a', folderId: 'folder-a' }, context: {} });
        const result = writing.then(() => 'completed', () => 'retired');
        await started.promise;
        await home.switchAccount(serverId, 'account-b');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const readProjection = () => kind === 'order'
            ? getStorage().getState().sessionOrganizationOrderEntriesByScopeKey
            : getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey;
        const replacementProjection = readProjection();
        response.resolve();
        expect(await result).toBe('retired');
        expect(readProjection()).toBe(replacementProjection);
        account.dispose();
    });

    it('does not project a folder result into a retired Account after its exact Home write', async () => {
        const serverId = await home.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-a' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        let issued!: () => void;
        const started = new Promise<void>(resolve => { issued = resolve; });
        let release!: () => void;
        const respondAfter = new Promise<void>(resolve => { release = resolve; });
        const folder = { folderId: 'folder-a', folderKey: 'folder-a', parentFolderId: null, parentFolderKey: null,
            sortKey: null, display: { t: 'plain' as const, v: { name: 'Leads' } }, archivedAt: null, createdAt: 1, updatedAt: 1 };
        home.answer(serverId, 'POST /v2/session-organization/folders', {
            select: () => { issued(); return { body: { folder }, respondAfter }; },
        });
        const { upsertSessionFolder } = await import('./upsertSessionFolder');
        const params = { credentials: account.credentials, serverId, serverUrl: 'https://home-a.example',
            requestAtEndpoint: account.request, assertCurrent: account.assertCurrent,
            request: { folderId: folder.folderId, folderKey: folder.folderKey, parentFolderId: null,
                parentFolderKey: null, sortKey: null, display: folder.display } };
        const writing = upsertSessionFolder(params);
        const settled = writing.then(() => 'completed', () => 'retired');
        await started;
        await home.switchAccount(serverId, 'account-b');
        release();
        expect(await settled).toBe('retired');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        expect(Object.values(getStorage().getState().sessionOrganizationFoldersByFolderKey)
            .some(value => value.folderId === folder.folderId)).toBe(false);
        account.dispose();
    });
    it('projects the folder-set Action acknowledgement through the scoped organization writer', async () => {
        const serverId = await home.addHome({ name: 'Folder Home', serverUrl: 'https://folder-home.example', accountId: 'account-a' });
        home.answer(serverId, 'PUT /v2/session-organization/folder-assignments/session-a', {
            select: input => ({ body: { sessionId: 'session-a', folderId: SetSessionFolderAssignmentRequestSchema.parse(input).folderId } }),
        });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const { createSessionOrganizationResourceAction, isSessionOrganizationResourceAction } = await import('./sessionOrganizationAction');
        expect(isSessionOrganizationResourceAction('session.folder.set')).toBe(true);
        const execute = createSessionOrganizationResourceAction(account);
        expect(await execute({ actionId: 'session.folder.set', input: { sessionId: 'session-a', folderId: 'folder-a' }, context: {} }))
            .toEqual({ sessionId: 'session-a', folderId: 'folder-a' });
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization');
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[buildSessionOrganizationSessionKey(serverId, 'session-a')])
            .toEqual(expect.objectContaining({ sessionId: 'session-a', folderId: 'folder-a' }));
        account.dispose();
    });

});
