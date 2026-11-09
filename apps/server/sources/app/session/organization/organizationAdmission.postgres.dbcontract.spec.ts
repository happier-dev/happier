import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_ORGANIZATION_MAX_FOLDERS, SESSION_ORGANIZATION_MAX_LABELS, SESSION_ORGANIZATION_MAX_PINNED_SESSIONS, SESSION_ORGANIZATION_MAX_TAGS } from '@happier-dev/protocol/sessions/organization/constants';
import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import type { Tx } from '@/storage/inTx';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { hashSessionOrganizationKey } from './hashKeys';
import { deleteSessionOrganizationFolder, deleteSessionOrganizationTag, importLegacySessionOrganization, setSessionPin, upsertSessionOrganizationFolder, upsertSessionOrganizationLabel, upsertSessionOrganizationTag } from './organizationMutations';
import { reorderSessionOrganization } from './organizationOrdering';
import { createOrRejoinLayout1SessionByTag } from '@/app/session/create/createOrRejoinLayout1SessionByTag';
import { prepareLayout1SessionCreate } from '@/app/session/create/prepareLayout1SessionCreate';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionOrganizationRoutes } from '@/app/api/routes/session/registerSessionOrganizationRoutes';
import { DeleteSessionOrganizationFolderResponseSchema } from '@happier-dev/protocol/sessions/organization/mutations';

/** Keep aggregate decisions real; rendezvous only at the PostgreSQL transport. */
async function interleavePair<T>(params: Readonly<{
    delegate: 'sessionPin' | 'sessionOrganizationFolder' | 'sessionOrganizationTag' | 'sessionOrganizationLabel' | 'sessionOrganizationOrderEntry';
    method: 'count' | 'findMany' | 'deleteMany';
    matches?: (args: readonly unknown[]) => boolean;
    operations: readonly [() => Promise<T>, () => Promise<T>];
}>): Promise<readonly [T, T]> {
    const originalTransaction = db.$transaction;
    const pids: number[] = [];
    const finished = new Set<number>();
    let entered = 0;
    let paused = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>(resolve => { release = resolve; });
    db.$transaction = new Proxy(originalTransaction, {
        apply(target, thisArg, args) {
            const operation: unknown = args[0];
            if (typeof operation !== 'function' || entered >= 2) return Reflect.apply(target, thisArg, args);
            const index = entered++;
            const options: unknown = args[1];
            return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
                pids[index] = pid;
                if (pids.filter(Boolean).length === 2) release();
                await bothEntered;
                let didPause = false;
                const delegate = new Proxy(tx[params.delegate], {
                    get(owner, property, receiver) {
                        const method: unknown = Reflect.get(owner, property, receiver);
                        if (property !== params.method || typeof method !== 'function') return method;
                        return async (...values: unknown[]) => {
                            const result: unknown = await Reflect.apply(method, owner, values);
                            if (!didPause && (params.matches?.(values) ?? true)) {
                                didPause = true;
                                paused++;
                                // A correct early Account fence blocks the peer before
                                // its decision read. Admit that serial schedule too.
                                while (paused < 2 && !finished.has(1 - index)) {
                                    const [{ waiting }] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting",
                                        pids[1 - index],
                                    );
                                    if (waiting) break;
                                }
                            }
                            return result;
                        };
                    },
                });
                try {
                    return await Reflect.apply(operation, undefined, [new Proxy(tx, {
                        get(owner, property, receiver) {
                            return property === params.delegate ? delegate : Reflect.get(owner, property, receiver);
                        },
                    })]);
                } finally { finished.add(index); }
            }, { ...(typeof options === 'object' && options !== null ? options : {}), isolationLevel: 'ReadCommitted' }]);
        },
    });
    try { return await Promise.all([params.operations[0](), params.operations[1]()]); }
    finally { release(); db.$transaction = originalTransaction; }
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session organization aggregate admission', () => {
    const authentication = createPresentUserSessionAccessAuthentication();
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres(); await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each([false, true])('removes only the named folder through PostgreSQL HTTP (nested=%s)', async nested => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const createFolder = async (key: string, parentKey: string | null) => await db.sessionOrganizationFolder.create({
            data: { accountId: account.id, folderKey: key, folderHash: hashSessionOrganizationKey(key),
                parentKey, parentHash: parentKey === null ? null : hashSessionOrganizationKey(parentKey), sortKey: key },
        });
        const parent = nested ? await createFolder('parent', null) : null;
        const removed = await createFolder('removed', parent?.folderKey ?? null);
        const child = await createFolder('child', removed.folderKey);
        const grandchild = await createFolder('grandchild', child.folderKey);
        const neighbor = await createFolder('neighbor', null);
        const sessions = await Promise.all([removed, child, grandchild, neighbor].map(async folder => {
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', agentState: null } });
            await db.sessionFolderAssignment.create({ data: { accountId: account.id, sessionId: session.id, folderId: folder.id } });
            return session;
        }));
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': account.id };
        const url = `/v2/session-organization/folders/${removed.id}`;
        try {
            const response = await app.inject({ method: 'DELETE', url, headers,
                payload: { folderId: removed.id, assignmentBehavior: 'moveAssignmentsToParent' } });
            expect(response.statusCode).toBe(200);
            expect(DeleteSessionOrganizationFolderResponseSchema.parse(response.json())).toEqual({
                deletedFolderIds: [removed.id], assignmentTargetFolderId: parent?.id ?? null, affectedAssignmentCount: 1,
            });
            const retained = await db.sessionOrganizationFolder.findMany({ where: { accountId: account.id, archivedAt: null },
                select: { id: true, parentKey: true, parentHash: true } });
            expect(retained).toEqual(expect.arrayContaining([
                { id: child.id, parentKey: parent?.folderKey ?? null, parentHash: parent?.folderHash ?? null },
                { id: grandchild.id, parentKey: child.folderKey, parentHash: child.folderHash },
                { id: neighbor.id, parentKey: null, parentHash: null },
            ]));
            expect(retained).toHaveLength(nested ? 4 : 3);
            const assignments = await db.sessionFolderAssignment.findMany({ where: { accountId: account.id },
                select: { sessionId: true, folderId: true }, orderBy: { sessionId: 'asc' } });
            expect(assignments).toEqual([
                ...(parent ? [{ sessionId: sessions[0]!.id, folderId: parent.id }] : []),
                ...[child, grandchild, neighbor].map((folder, index) => ({ sessionId: sessions[index + 1]!.id, folderId: folder.id })),
            ].sort((left, right) => left.sessionId.localeCompare(right.sessionId)));
            expect(await db.session.count({ where: { accountId: account.id } })).toBe(4);
            const repeated = await app.inject({ method: 'DELETE', url, headers,
                payload: { folderId: removed.id, assignmentBehavior: 'moveAssignmentsToParent' } });
            expect(repeated.statusCode).toBe(200);
            expect(DeleteSessionOrganizationFolderResponseSchema.parse(repeated.json())).toEqual({
                deletedFolderIds: [], assignmentTargetFolderId: null, affectedAssignmentCount: 0,
            });
        } finally {
            await app.close();
            await db.sessionFolderAssignment.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.sessionOrganizationFolder.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(['folder', 'tag'] as const)('rejects birth placement after %s deletion wins before Account admission', async resource => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const folder = await db.sessionOrganizationFolder.create({ data: { accountId: account.id, folderKey: 'intake', folderHash: hashSessionOrganizationKey('intake') } });
        const tag = await db.sessionOrganizationTag.create({ data: { accountId: account.id, tagKey: 'incoming', tagHash: hashSessionOrganizationKey('incoming') } });
        const preparation = prepareLayout1SessionCreate({ accountId: account.id, tag: randomUUID(), metadata: '{"v":1}',
            ownerMetadata: { t: 'plain', v: { v: 1 } }, agentState: null, dataEncryptionKey: null,
            requestedEncryptionMode: 'plain', requestedStorageState: undefined, accountEncryptionMode: 'plain',
            storagePolicy: 'optional', defaultAccountMode: 'plain', originKind: 'none',
            organizationPlacement: { folderId: folder.id, tagIds: [tag.id] } });
        if (!preparation.ok) throw new Error('Invalid Session creation fixture');
        const transaction = db.$transaction;
        let deletionStarted = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback: unknown = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(owner, property, innerReceiver) {
                if (property !== '$queryRawUnsafe') return Reflect.get(owner, property, innerReceiver);
                return (query: string, ...values: unknown[]) => {
                    const native = owner.$queryRawUnsafe(query, ...values);
                    if (deletionStarted || !query.includes('FROM "Account"') || !query.includes('FOR KEY SHARE')) return native;
                    deletionStarted = true;
                    let scheduled: Promise<unknown> | undefined;
                    const run = () => scheduled ??= (async () => {
                        if (resource === 'folder') await deleteSessionOrganizationFolder({ accountId: account.id, request: { folderId: folder.id, assignmentBehavior: 'moveAssignmentsToParent' } });
                        else await deleteSessionOrganizationTag({ accountId: account.id, request: { tagId: tag.id, assignmentBehavior: 'removeAssignments' } });
                        return await native;
                    })();
                    // Preserve Prisma's lazy query and inTx statement-budget boundary.
                    return new Proxy(native, { get(promise, method, promiseReceiver) {
                        if (method !== 'then' && method !== 'catch' && method !== 'finally') return Reflect.get(promise, method, promiseReceiver);
                        return (...callbacks: unknown[]) => {
                            const scheduledQuery = run();
                            return Reflect.apply(Reflect.get(scheduledQuery, method, scheduledQuery), scheduledQuery, callbacks);
                        };
                    } });
                };
            } })), ...args.slice(1)]);
        } });
        try {
            const result = await createOrRejoinLayout1SessionByTag(preparation.prepared, authentication);
            expect(deletionStarted).toBe(true);
            expect(result).toMatchObject({ kind: 'rejected', rejection: { reason: 'invalid-organization-placement' } });
            expect(await db.session.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.sessionFolderAssignment.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.sessionTagAssignment.count({ where: { accountId: account.id } })).toBe(0);
        } finally {
            db.$transaction = transaction;
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.sessionOrganizationFolder.deleteMany({ where: { accountId: account.id } });
            await db.sessionOrganizationTag.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('retains one admission cohort through a legacy import composed from ordinary owners', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        try {
            const result = await importLegacySessionOrganization({ accountId: account.id, authentication, request: {
                pins: [{ sessionId: session.id, sortKey: 'a' }],
                folders: [{ folderKey: 'imported', parentFolderId: null, parentFolderKey: null, sortKey: 'a', display: null }],
                tags: [{ tagKey: 'imported', sortKey: 'a', display: null }], tagAssignments: [],
                labels: [{ labelKind: 'workspace', scopeKey: 'imported', display: null }],
                orderEntries: [{ scopeKind: 'pinned', scopeKey: 'root', itemKind: 'session', itemKey: session.id, sortKey: 'a' }],
            } });
            expect(result).toMatchObject({ imported: { pins: 1, folders: 1, tags: 1, labels: 1, orderEntries: 1 } });
            expect(await db.sessionPin.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.sessionOrganizationFolder.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.sessionOrganizationTag.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.sessionOrganizationLabel.count({ where: { accountId: account.id } })).toBe(1);
        } finally {
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.sessionOrganizationFolder.deleteMany({ where: { accountId: account.id } });
            await db.sessionOrganizationTag.deleteMany({ where: { accountId: account.id } });
            await db.sessionOrganizationLabel.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(['folder', 'tag', 'label'] as const)('retains the %s quota under concurrent disjoint inserts at ReadCommitted', async kind => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const limit = kind === 'folder' ? SESSION_ORGANIZATION_MAX_FOLDERS : kind === 'tag' ? SESSION_ORGANIZATION_MAX_TAGS : SESSION_ORGANIZATION_MAX_LABELS;
        const keys = Array.from({ length: limit - 1 }, (_, index) => `retained-${index}`);
        try {
            if (kind === 'folder') await db.sessionOrganizationFolder.createMany({ data: keys.map(key => ({ accountId: account.id, folderKey: key, folderHash: hashSessionOrganizationKey(key) })) });
            else if (kind === 'tag') await db.sessionOrganizationTag.createMany({ data: keys.map(key => ({ accountId: account.id, tagKey: key, tagHash: hashSessionOrganizationKey(key) })) });
            else await db.sessionOrganizationLabel.createMany({ data: keys.map(key => ({ accountId: account.id, labelKind: 'workspace', scopeKey: key, scopeHash: hashSessionOrganizationKey(key) })) });
            const write = async (key: string) => {
                const result = kind === 'folder'
                    ? await upsertSessionOrganizationFolder({ accountId: account.id, request: { folderKey: key, parentFolderId: null, parentFolderKey: null, sortKey: null, display: null } })
                    : kind === 'tag'
                        ? await upsertSessionOrganizationTag({ accountId: account.id, request: { tagKey: key, sortKey: null, display: null } })
                        : await upsertSessionOrganizationLabel({ accountId: account.id, request: { labelKind: 'workspace', scopeKey: key, display: null } });
                return 'error' in result ? result : { created: true };
            };
            const delegate = kind === 'folder' ? 'sessionOrganizationFolder' : kind === 'tag' ? 'sessionOrganizationTag' : 'sessionOrganizationLabel';
            const results = await interleavePair({ delegate, method: 'count', operations: [() => write('left'), () => write('right')] });
            expect(results.filter(result => 'error' in result)).toEqual([{ error: `session-organization-${kind}-limit-exceeded` }]);
            const activeCount = kind === 'folder'
                ? await db.sessionOrganizationFolder.count({ where: { accountId: account.id, archivedAt: null } })
                : kind === 'tag' ? await db.sessionOrganizationTag.count({ where: { accountId: account.id, archivedAt: null } })
                    : await db.sessionOrganizationLabel.count({ where: { accountId: account.id, archivedAt: null } });
            expect(activeCount).toBe(limit);
        } finally {
            await db.sessionOrganizationFolder.deleteMany({ where: { accountId: account.id } });
            await db.sessionOrganizationTag.deleteMany({ where: { accountId: account.id } });
            await db.sessionOrganizationLabel.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('admits disjoint pins beyond the former quota at ReadCommitted', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const ids = Array.from({ length: SESSION_ORGANIZATION_MAX_PINNED_SESSIONS + 1 }, () => randomUUID());
        try {
            await db.session.createMany({ data: ids.map(id => ({ id, accountId: account.id, tag: id, metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted' })) });
            await db.sessionPin.createMany({ data: ids.slice(0, -2).map(sessionId => ({ accountId: account.id, sessionId })) });
            const write = (sessionId: string) => setSessionPin({ accountId: account.id, sessionId, request: { pinned: true }, authentication });
            const results = await interleavePair({ delegate: 'sessionPin', method: 'count', operations: [() => write(ids.at(-2)!), () => write(ids.at(-1)!)] });
            expect(results.filter(result => 'error' in result)).toEqual([]);
            expect(await db.sessionPin.count({ where: { accountId: account.id } })).toBe(ids.length);
        } finally {
            await db.sessionPin.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('rejects one side of a concurrent folder-parent cycle at ReadCommitted', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const left = await db.sessionOrganizationFolder.create({ data: { accountId: account.id, folderKey: 'left', folderHash: hashSessionOrganizationKey('left') } });
        const right = await db.sessionOrganizationFolder.create({ data: { accountId: account.id, folderKey: 'right', folderHash: hashSessionOrganizationKey('right') } });
        try {
            const write = (folder: typeof left, parent: typeof left) => upsertSessionOrganizationFolder({ accountId: account.id, request: {
                folderId: folder.id, folderKey: folder.folderKey, parentFolderId: parent.id, parentFolderKey: parent.folderKey, sortKey: null, display: null,
            } });
            const results = await interleavePair({ delegate: 'sessionOrganizationFolder', method: 'findMany',
                matches: values => typeof values[0] === 'object' && values[0] !== null && Reflect.has(Reflect.get(values[0], 'select') ?? {}, 'parentKey'),
                operations: [() => write(left, right), () => write(right, left)],
            });
            expect(results.filter(result => 'error' in result)).toEqual([{ error: 'invalid-parent-folder' }]);
            expect(await db.sessionOrganizationFolder.count({ where: { accountId: account.id, parentKey: null } })).toBe(1);
        } finally {
            await db.sessionOrganizationFolder.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('keeps a whole order replacement rather than merging concurrent disjoint replacements at ReadCommitted', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        try {
            const write = (itemKey: string) => reorderSessionOrganization({ accountId: account.id, authentication,
                request: { scopeKind: 'group', scopeKey: 'root', entries: [{ itemKind: 'group', itemKey, sortKey: 'a' }] } });
            const results = await interleavePair({ delegate: 'sessionOrganizationOrderEntry', method: 'deleteMany', operations: [() => write('left'), () => write('right')] });
            expect(results.every(result => !('error' in result))).toBe(true);
            const rows = await db.sessionOrganizationOrderEntry.findMany({ where: { accountId: account.id }, select: { itemKey: true } });
            expect(rows).toHaveLength(1);
            expect(['left', 'right']).toContain(rows[0]?.itemKey);
        } finally {
            await db.sessionOrganizationOrderEntry.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
