import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReorderSessionOrganizationRequestSchema } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

// Network and device credentials are the genuine boundaries; encryption-mode
// admission, the organization owner, and its store projection remain real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
beforeEach(async () => { await home.reset(); });
afterEach(() => standardCleanup());

describe('Session organization Action scope', () => {
    it('does not apply an acknowledged order response into a replacement Account', async () => {
        const serverId = await home.addHome({ name: 'Order Home', serverUrl: 'https://order-home.example', accountId: 'account-a' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const started = createDeferred<void>();
        const response = createDeferred<void>();
        home.answer(serverId, 'PUT /v2/session-organization/order', {
            select: input => {
                started.resolve();
                const request = ReorderSessionOrganizationRequestSchema.parse(input);
                return { body: { orderEntries: request.entries.map(entry => ({ ...entry, scopeKind: request.scopeKind, scopeKey: request.scopeKey })) }, respondAfter: response.promise };
            },
        });
        const { writeSessionOrganizationGroupOrder } = await import('./sessionOrganizationMutationOwner');
        const itemKey = `${serverId}:session-a`;
        const writing = writeSessionOrganizationGroupOrder({
            scope: { credentials: account.credentials, serverId, serverUrl: 'https://order-home.example', serverIdAliases: [], requestAtEndpoint: account.request, assertCurrent: account.assertCurrent },
            next: { project: [itemKey] },
            orderItemAddressByItemKey: { [itemKey]: { itemKind: 'session', serverId, sessionId: 'session-a' } },
        });
        const result = writing.then(() => 'completed', () => 'retired');
        await started.promise;
        await home.switchAccount(serverId, 'account-b');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const replacementOrder = getStorage().getState().sessionOrganizationOrderEntriesByScopeKey;
        response.resolve();
        expect(await result).toBe('retired');
        expect(getStorage().getState().sessionOrganizationOrderEntriesByScopeKey).toBe(replacementOrder);
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
});
