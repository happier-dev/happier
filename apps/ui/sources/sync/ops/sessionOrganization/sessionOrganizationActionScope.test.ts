import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateOrUpdateSessionOrganizationFolderRequestSchema, CreateOrUpdateSessionOrganizationTagRequestSchema,
    ReorderSessionOrganizationRequestSchema, SetSessionFolderAssignmentRequestSchema, MutateSessionTagAssignmentsRequestSchema} from '@happier-dev/protocol/sessions/organization/mutations';
import {
    type SessionOrganizationFolder} from '@happier-dev/protocol/sessions/organization/folders';
import { type SessionOrganizationTag } from '@happier-dev/protocol/sessions/organization/tags';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

// Network and device credentials are the genuine boundaries; encryption-mode
// admission, the organization owner, and its store projection remain real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Charge the real executor graph's cold transform to collection, not an operation timeout.
await import('@/sync/ops/actions/defaultActionExecutor');
beforeEach(async () => { await home.reset(); });
afterEach(() => standardCleanup());

describe('Session organization Action scope', () => {
    it('does not infer an empty section list or prior assignment from missing-route compatibility data', async () => {
        const accountId = 'account-missing-organization';
        const serverId = await home.addHome({ name: 'Missing organization', serverUrl: 'https://missing-org.example', accountId });
        let assignmentWrites = 0;
        home.answer(serverId, 'GET /v2/session-organization', { status: 404, body: { error: 'Not found' } });
        // Characterize an unavailable read independently of an otherwise reachable mutation leaf.
        home.answer(serverId, 'PUT /v2/session-organization/folder-assignments/session-a', { select: () => {
            assignmentWrites += 1;
            return { body: { sessionId: 'session-a', folderId: 'destination' } };
        } });
        const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
        const execute = scopedHomeActionExecutor({ serverId, accountId });
        const context = { serverId, surface: 'ui' as const, authority: 'present_user' as const };
        expect(await execute('session.sections.list', {}, context))
            .toMatchObject({ ok: false, errorCode: 'section_membership_unavailable' });
        expect(await execute('session.section.set', { sessionId: 'session-a', sectionId: 'destination' }, context))
            .toMatchObject({ ok: false, errorCode: 'section_membership_unavailable' });
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[
            buildSessionOrganizationSessionKey(serverId, 'session-a')]).toBeUndefined();
        expect(assignmentWrites).toBe(0);
    });

    it('checks current membership on Undo activation and preserves intervening changes and Account scope', async () => {
        const accountId = 'account-undo';
        const serverId = await home.addHome({ name: 'Undo Home', serverUrl: 'https://undo.example', accountId });
        let sectionId: string | null = 'destination';
        let assignmentWrites = 0;
        home.answer(serverId, 'GET /v2/session-organization', { select: () => ({ body: { snapshot: {
            schemaVersion: 1, version: 1, pins: [], tags: [], tagAssignments: [], orderEntries: [], labels: [], folders: [],
            folderAssignments: sectionId ? [{ sessionId: 'session-a', folderId: sectionId }] : [],
        } } }) });
        home.answer(serverId, 'PUT /v2/session-organization/folder-assignments/session-a', { select: input => {
            assignmentWrites += 1;
            sectionId = SetSessionFolderAssignmentRequestSchema.parse(input).folderId;
            return { body: { sessionId: 'session-a', folderId: sectionId } };
        } });
        const { readAcknowledgedActionResult } = await import('@/components/approvals/actionResultFacts');
        const { executeAcknowledgedActionInverse } = await import('@/sync/ops/actions/executeAcknowledgedActionInverse');
        const fact = readAcknowledgedActionResult({ actionId: 'session.section.set', result: {
            sessionId: 'session-a', sectionId: 'destination', previousSectionId: null,
        } })!;
        expect(home.requests.filter(row => row.path.startsWith('/v2/session-organization'))).toHaveLength(0);
        expect(await executeAcknowledgedActionInverse(fact, { serverId, accountId }))
            .toMatchObject({ ok: true, result: { sessionId: 'session-a', sectionId: null } });
        sectionId = 'changed-after-result';
        expect(await executeAcknowledgedActionInverse(fact, { serverId, accountId }))
            .toMatchObject({ ok: false, errorCode: 'section_membership_changed' });
        expect(sectionId).toBe('changed-after-result');
        expect(await executeAcknowledgedActionInverse(fact, { serverId, accountId: 'foreign-account' }))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(assignmentWrites).toBe(1);
    });

    it('uses the scoped Action front door for section creation, editing, filing, ordering and removal', async () => {
        const accountId = 'account-sections';
        const serverId = await home.addHome({ name: 'Sections Home', serverUrl: 'https://sections.example', accountId });
        let folders: SessionOrganizationFolder[] = [];
        const assignments = new Map<string, string>();
        home.answer(serverId, 'GET /v2/session-organization', { select: (_input, request) => {
            const query = new URL(request.url).searchParams;
            const folderIds = query.get('folderIds')?.split(',');
            const sessionIds = query.get('assignmentSessionIds')?.split(',');
            return { body: { snapshot: {
                schemaVersion: 1, version: 1, pins: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
                folders: query.get('includeFolders') === 'false' ? [] : folders.filter(folder => !folderIds || folderIds.includes(folder.folderId)),
                folderAssignments: [...assignments].flatMap(([sessionId, folderId]) =>
                    (query.get('includeAllFolderAssignments') === 'true' || folderIds?.includes(folderId) || sessionIds?.includes(sessionId))
                        ? [{ sessionId, folderId }] : []),
            } } };
        } });
        home.answer(serverId, 'POST /v2/session-organization/folders', { select: input => {
            const request = CreateOrUpdateSessionOrganizationFolderRequestSchema.parse(input);
            if (!request.folderId) throw new Error('Section owner must allocate its identity before dispatch');
            const folder: SessionOrganizationFolder = {
                ...request, folderId: request.folderId, folderKey: request.folderKey ?? request.folderId,
                parentFolderId: request.parentFolderId ?? null, parentFolderKey: request.parentFolderKey ?? null,
                sortKey: request.sortKey ?? null, display: request.display ?? null,
                archivedAt: null, createdAt: 1, updatedAt: 2,
            };
            folders = [...folders.filter(current => current.folderId !== folder.folderId), folder];
            return { body: { folder } };
        } });
        home.answer(serverId, 'PUT /v2/session-organization/folder-assignments/session-a', { select: input => {
            const request = SetSessionFolderAssignmentRequestSchema.parse(input);
            if (request.folderId === null) assignments.delete('session-a');
            else assignments.set('session-a', request.folderId);
            return { body: { sessionId: 'session-a', folderId: request.folderId } };
        } });
        const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
        const execute = scopedHomeActionExecutor({ serverId, accountId });
        const context = { serverId, surface: 'ui' as const, authority: 'present_user' as const };
        expect(await execute('session.sections.create', { name: 'Launch', icon: 'rocket-outline' }, context))
            .toMatchObject({ ok: true, result: { section: { displayState: { status: 'available', value: { name: 'Launch', icon: 'rocket-outline' } } } } });
        const sectionId = folders[0]!.folderId;
        expect(await execute('session.sections.update', { sectionId, name: 'Release' }, context))
            .toMatchObject({ ok: true, result: { section: { displayState: { value: { name: 'Release', icon: 'rocket-outline' } } } } });
        expect(await execute('session.section.set', { sessionId: 'session-a', sectionId }, context))
            .toEqual({ ok: true, result: { sessionId: 'session-a', sectionId, previousSectionId: null } });
        // Historical QA rows have the same nullable display admitted by 0.2's
        // physical folder DTO; the host must not confuse absent text with lost bytes.
        const retained = ['qa-live2-intake', 'qa-live2-questions', 'qa-live3b-intake', 'qa-live3b-questions']
            .map((folderId): SessionOrganizationFolder => ({ folderId, folderKey: folderId,
                parentFolderId: null, parentFolderKey: null, sortKey: null, display: null,
                archivedAt: null, createdAt: 1, updatedAt: 1 }));
        folders.push(...retained);
        expect(await execute('session.sections.list', {}, context)).toMatchObject({ ok: true, result: {
            sections: expect.arrayContaining(retained.map(folder => expect.objectContaining({ sectionId: folder.folderId,
                displayState: { status: 'locked', reason: 'invalid_stored_display' } }))),
        } });
        expect(await execute('session.sections.reorder', { sectionId, beforeSectionId: null }, context))
            .toMatchObject({ ok: true, result: { sectionId } });
        expect(folders.filter(folder => retained.some(row => row.folderId === folder.folderId))
            .map(({ sortKey: _sortKey, updatedAt: _updatedAt, ...folder }) => folder))
            .toEqual(retained.map(({ sortKey: _sortKey, updatedAt: _updatedAt, ...folder }) => folder));
        expect(await execute('session.section.set', { sessionId: 'session-a', sectionId: null }, context))
            .toEqual({ ok: true, result: { sessionId: 'session-a', sectionId: null, previousSectionId: sectionId } });
        const namedSection = folders.find(folder => folder.folderId === sectionId)!;
        folders.push({ ...namedSection, folderId: 'legacy-child', folderKey: 'legacy-child-key',
            parentFolderId: sectionId, parentFolderKey: namedSection.folderKey,
            sortKey: null, display: { t: 'plain', v: { name: 'Child' } } });
        expect(await execute('session.sections.list', {}, context))
            .toMatchObject({ ok: true, result: { sections: expect.arrayContaining([
                expect.objectContaining({ sectionId, displayState: { status: 'available', value: { name: 'Release', icon: 'rocket-outline' } } }),
            ]) } });
        home.answer(serverId, `DELETE /v2/session-organization/folders/${sectionId}`, { select: () => {
            folders = folders.filter(folder => folder.folderId !== sectionId).map(folder => folder.parentFolderId === sectionId
                ? { ...folder, parentFolderId: null, parentFolderKey: null } : folder);
            const affectedAssignmentCount = assignments.size;
            assignments.clear();
            return { body: { deletedFolderIds: [sectionId], assignmentTargetFolderId: null, affectedAssignmentCount } };
        } });
        expect(await execute('session.sections.delete', { sectionId }, context))
            .toEqual({ ok: true, result: { sectionId, removed: true, affectedAssignmentCount: 0 } });
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionOrganizationServerKey } = await import('@/sync/domains/session/organization/keys');
        expect(getStorage().getState().sessionOrganizationFoldersByFolderKey[buildSessionOrganizationServerKey(serverId, 'legacy-child')])
            .toMatchObject({ parentFolderId: null, parentFolderKey: null });
    });
    it('admits section membership, tag-label assignment and attention through Actions before writing', async () => {
        const serverId = await home.addHome({ name: 'Info Home', serverUrl: 'https://info-home.example', accountId: 'account-a' });
        home.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'session.section.set': { enabled: false }, 'session.tags.create': { enabled: false }, 'session.tags.set': { enabled: false }, 'session.attention.set': { enabled: false } } },
        } } } });
        const { resolveSessionOrganizationMutationScope, writeSessionOrganizationTagLabels, writeSessionOrganizationFolderAssignment } = await import('./sessionOrganizationMutationOwner');
        const resolved = await resolveSessionOrganizationMutationScope(serverId);
        if (!resolved.ok) throw new Error('Expected test Home scope');
        home.answer(serverId, 'GET /v2/session-organization', { body: { snapshot: {
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [],
        } } });
        const writes: string[] = [];
        home.answer(serverId, 'PUT /v2/session-organization/tag-assignments/source', { select: () => {
            writes.push('tags'); return { body: { sessionId: 'source', tagIds: [] } };
        } });
        home.answer(serverId, 'PUT /v2/session-organization/folder-assignments/source', { select: () => {
            writes.push('section'); return { body: { sessionId: 'source', folderId: 'folder-a' } };
        } });
        home.answer(serverId, 'PUT /v2/session-organization/attention-standings/source', { select: () => {
            writes.push('attention'); return { body: { standing: { sessionId: 'source', standing: true, updatedAt: 1 } } };
        } });
        home.answer(serverId, 'POST /v2/session-organization/tags', { select: input => {
            writes.push('create-tag');
            const request = CreateOrUpdateSessionOrganizationTagRequestSchema.parse(input);
            const tagId = request.tagId ?? 'new-tag';
            return { body: { tag: { ...request, tagId, tagKey: request.tagKey ?? tagId,
                sortKey: request.sortKey ?? null, display: request.display ?? null,
                archivedAt: null, createdAt: 1, updatedAt: 1 } } };
        } });
        await expect(writeSessionOrganizationFolderAssignment({ scope: resolved.scope, sessionId: 'source', folderId: 'folder-a' })).rejects.toThrow();
        await expect(writeSessionOrganizationTagLabels({ scope: resolved.scope, sessionId: 'source', tags: [] })).rejects.toThrow();
        await expect(writeSessionOrganizationTagLabels({ scope: resolved.scope, sessionId: 'source', tags: ['New'] })).rejects.toThrow();
        const { sessionSetAttentionStandingWithServerScope } = await import('./setSessionAttentionStanding');
        expect(await sessionSetAttentionStandingWithServerScope('source', true, { serverId })).toMatchObject({ success: false });
        expect(writes).toEqual([]);
    });
    it('resolves labels through the existing tag owner and reads back Action-assigned ids', async () => {
        const serverId = await home.addHome({ name: 'Tags Home', serverUrl: 'https://tags-home.example', accountId: 'account-tags' });
        let tags: SessionOrganizationTag[] = [{ tagId: 'existing', tagKey: 'existing', sortKey: null,
            display: { t: 'plain', v: { label: 'Existing' } }, archivedAt: null, createdAt: 1, updatedAt: 1 }];
        let assigned: string[] = [];
        home.answer(serverId, 'GET /v2/session-organization', { select: () => ({ body: { snapshot: {
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags,
            tagAssignments: [{ sessionId: 'source', tagIds: assigned }], orderEntries: [], labels: [],
        } } }) });
        home.answer(serverId, 'POST /v2/session-organization/tags', { select: input => {
            const request = CreateOrUpdateSessionOrganizationTagRequestSchema.parse(input);
            if (!request.tagId || !request.tagKey) throw new Error('Expected allocated tag identity');
            const tag: SessionOrganizationTag = { ...request, tagId: request.tagId, tagKey: request.tagKey,
                sortKey: request.sortKey ?? null, display: request.display ?? null,
                archivedAt: null, createdAt: 2, updatedAt: 2 };
            tags = [...tags, tag];
            return { body: { tag } };
        } });
        home.answer(serverId, 'PUT /v2/session-organization/tag-assignments/source', { select: input => {
            const mutation = MutateSessionTagAssignmentsRequestSchema.parse(input);
            assigned = 'tagIds' in mutation ? mutation.tagIds : [...new Set([
                ...assigned.filter(id => !mutation.removeTagIds.includes(id)), ...mutation.addTagIds,
            ])];
            return { body: { sessionId: 'source', tagIds: assigned } };
        } });
        const { resolveSessionOrganizationMutationScope, writeSessionOrganizationTagLabels } = await import('./sessionOrganizationMutationOwner');
        const resolved = await resolveSessionOrganizationMutationScope(serverId);
        if (!resolved.ok) throw new Error('Expected tags scope');
        await writeSessionOrganizationTagLabels({ scope: resolved.scope, sessionId: 'source', tags: ['Existing', 'New'] });
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
        expect(tags).toHaveLength(2);
        const expectedIds = tags.map(tag => tag.tagId);
        expect(getStorage().getState().sessionOrganizationTagAssignmentsBySessionKey[buildSessionOrganizationSessionKey(serverId, 'source')])
            .toEqual({ sessionId: 'source', tagIds: expectedIds });
        await writeSessionOrganizationTagLabels({ scope: resolved.scope, sessionId: 'source', tags: ['Existing', 'New'] });
        expect(tags).toHaveLength(2);
        const definitions = home.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v2/session-organization');
        expect(definitions).toHaveLength(2);
        expect(new URL(definitions[0]!.path, definitions[0]!.serverUrl).searchParams.get('includeFolders')).toBe('false');
    });
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
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().applySessionFolderAssignments(serverId, [{ sessionId: 'session-a', folderId: null }]);
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
        }) : createSessionOrganizationResourceAction(account)({ actionId: 'session.section.set',
            input: { sessionId: 'session-a', sectionId: 'folder-a' }, context: {} });
        const result = writing.then(() => 'completed', () => 'retired');
        await started.promise;
        await home.switchAccount(serverId, 'account-b');
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
    it('projects the section-set acknowledgement and captured prior membership through the scoped writer', async () => {
        const serverId = await home.addHome({ name: 'Folder Home', serverUrl: 'https://folder-home.example', accountId: 'account-a' });
        home.answer(serverId, 'PUT /v2/session-organization/folder-assignments/session-a', {
            select: input => ({ body: { sessionId: 'session-a', folderId: SetSessionFolderAssignmentRequestSchema.parse(input).folderId } }),
        });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().applySessionFolderAssignments(serverId, [{ sessionId: 'session-a', folderId: 'previous' }]);
        const { createSessionOrganizationResourceAction, isSessionOrganizationResourceAction } = await import('./sessionOrganizationAction');
        expect(isSessionOrganizationResourceAction('session.section.set')).toBe(true);
        const execute = createSessionOrganizationResourceAction(account);
        expect(await execute({ actionId: 'session.section.set', input: { sessionId: 'session-a', sectionId: 'folder-a' }, context: {} }))
            .toEqual({ sessionId: 'session-a', sectionId: 'folder-a', previousSectionId: 'previous' });
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization');
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[buildSessionOrganizationSessionKey(serverId, 'session-a')])
            .toEqual(expect.objectContaining({ sessionId: 'session-a', folderId: 'folder-a' }));
        account.dispose();
    });

});
