import { basename, dirname, join } from 'node:path';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG } from '@/transfers/targets/resolveSessionMediaTransferTarget';
import { check, directoriesAtDepth, entries, exists, inUse, item, unavailableDirectory, opaqueItemTitle } from './filesystem';
import { StorageCategoryAdapterError } from './types';
import type { StorageCategoryContext, StorageCategoryDefinition, StorageCategoryVerdict, StorageCategoryAdapter, StorageCategoryCatalogDeps } from './types';
import { bindFilesystemItem, filesystemAdapterForEntry } from './filesystemAdapters';
import { readStoragePathIdentity, removeStoragePath } from '../trash/removeStoragePath';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { MachineStoragePolicyV1Schema } from '@happier-dev/protocol/storage/storageV1';

const AllocationOwnerDataSchema = z.strictObject({ kind: z.literal('allocation'), allocationId: z.string().check(z.regex(/^[a-f0-9]{64}$/u)) });
const StoredAllocationOwnerDataSchema = createStoredReadSchema(AllocationOwnerDataSchema);
async function allocationAdapter(data: JsonValue, deps: StorageCategoryCatalogDeps): Promise<StorageCategoryAdapter> {
    const parsed = StoredAllocationOwnerDataSchema.safeParse(data);
    if (!parsed.success) throw new StorageCategoryAdapterError('owner_data_invalid');
    const owner = deps.managedSessionDirectories;
    if (!owner?.retireToTrash || !owner.reinstateFromTrash || !owner.discardFromTrash || !owner.removeAllocation) {
        throw new StorageCategoryAdapterError('owner_unavailable');
    }
    const { allocationId } = parsed.data;
    const record = (await owner.listRecords({ includeTrashed: true })).find(record => record.allocationId === allocationId);
    return { ownerData: parsed.data, restorable: Boolean(record),
        ...(record?.sessionId ? { sessionId: record.sessionId } : {}),
        retire: async input => {
            if (!record) throw new StorageCategoryAdapterError('owner_unavailable');
            return owner.retireToTrash!({ allocationId, ...input });
        },
        reinstate: async input => {
            if (!record) throw new StorageCategoryAdapterError('owner_unavailable');
            return owner.reinstateFromTrash!({ allocationId, ...input });
        },
        discard: async ({ payloadPath, beforeEffect }) => {
            if (payloadPath) await owner.discardFromTrash!({ allocationId, payloadPath, beforeEffect, removePayload: async () => {
                const expectedIdentity = await readStoragePathIdentity(payloadPath);
                await removeStoragePath(payloadPath, { allowedRoot: dirname(payloadPath), expectedIdentity });
            } });
            else {
                if (!record) throw new StorageCategoryAdapterError('owner_unavailable');
                const directory = record.directory;
                await owner.removeAllocation!(allocationId, { throwOnFailure: true, beforeEffect, removeDirectory: async () => {
                    const expectedIdentity = await readStoragePathIdentity(directory);
                    await removeStoragePath(directory, { allowedRoot: dirname(directory), expectedIdentity });
                } });
            }
        },
    };
}

export function sessionFolderCanGo(sessionId: string | null, context: StorageCategoryContext): StorageCategoryVerdict {
    const session = context.sessions.find(session => session.sessionId === sessionId);
    if (!session) return check;
    if (session.running) return { ...inUse, categoryGroup: { id: 'recent' } };
    if (session.stoppedAt === undefined) return check;
    if (session.stoppedAt > context.unusedBefore) return { verdict: 'keep', reason: { code: 'recent' }, collectable: true, categoryGroup: { id: 'recent' } };
    return { verdict: 'caution', reason: { code: 'attachments_go' }, collectable: true, loses: [{ code: 'attachments_go' }],
        categoryGroup: { id: 'stopped', olderThanDays: context.deps.readPolicy?.().suggestUnusedAfterDays
            ?? MachineStoragePolicyV1Schema.parse({}).suggestUnusedAfterDays } };
}
function uploadRoots(context: StorageCategoryContext) {
    return [...new Set([...context.sessions.map(session => session.cwd), ...context.projects.map(project => project.repositoryRoot),
        ...context.worktrees.flatMap(worktree => [worktree.path, worktree.repositoryRoot])])]
        .map(root => join(root, DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG.workspaceRelativeDir));
}
export const sessionFolders: StorageCategoryDefinition = {
    id: 'sessionFolders',
    descendantCleanup: 'whole-item-only',
    roots: context => [join(context.deps.activeServerDir, 'session-directories'), ...uploadRoots(context)],
    async bindAdapter(item, context) {
        const record = context.allocations.find(record => record.directory === item.path && !record.inTrash);
        if (record) return allocationAdapter({ kind: 'allocation', allocationId: record.allocationId }, context.deps);
        if (item.sessionId && item.evidence.includes('session_workspace_upload')) return bindFilesystemItem(item);
        throw new StorageCategoryAdapterError('owner_unavailable');
    },
    async adapterForEntry(data, deps) {
        return StoredAllocationOwnerDataSchema.safeParse(data).success ? allocationAdapter(data, deps) : filesystemAdapterForEntry(data);
    },
    async items(context) {
        const result = [];
        const managedRoot = join(context.deps.activeServerDir, 'session-directories');
        const byPath = new Map(context.allocations.map(entry => [entry.directory, entry]));
        for (const path of await directoriesAtDepth(managedRoot, 1, unavailableDirectory(context, 'sessionFolders'))) {
            if (basename(path) === '.owners') continue;
            const record = byPath.get(path);
            if (record?.inTrash) continue;
            result.push({ ...item('sessionFolders', path, record ? sessionFolderCanGo(record.sessionId, context) : check,
                { title: opaqueItemTitle(path, 'Session folder'), evidence: record ? ['managed_session_directory_record'] : ['managed_session_directory_record_unavailable'] }),
                ...(record?.sessionId ? { sessionId: record.sessionId } : {}) });
        }
        // The ownership record may name an allocation omitted by a transient directory relist.
        for (const record of context.allocations) if (!record.inTrash && !result.some(value => value.path === record.directory) && await exists(record.directory)) {
            result.push({ ...item('sessionFolders', record.directory, sessionFolderCanGo(record.sessionId, context),
                { title: opaqueItemTitle(record.directory, 'Session folder'), evidence: ['managed_session_directory_record'] }),
                ...(record.sessionId ? { sessionId: record.sessionId } : {}) });
        }
        for (const root of uploadRoots(context)) for (const category of await entries(root, unavailableDirectory(context, 'sessionFolders'))) {
            for (const path of await directoriesAtDepth(category, 1, unavailableDirectory(context, 'sessionFolders'))) {
                const sessionId = context.sessions.find(session => session.sessionId === basename(path))?.sessionId;
                result.push({ ...item('sessionFolders', path, sessionFolderCanGo(sessionId ?? null, context),
                    { title: opaqueItemTitle(path, 'Session attachments'), evidence: ['session_workspace_upload'] }),
                    ...(sessionId ? { sessionId } : {}) });
            }
        }
        return result;
    },
};
