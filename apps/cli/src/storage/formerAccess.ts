import { realpath } from 'node:fs/promises';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';
import type { SizedStorageCategoryItem } from './categories/types';
import type { StorageOperationActor, StorageServiceDeps } from './storageService';

export type FormerAccessSources = Readonly<{
    readMemberWorkspaces(): Promise<ReadonlyArray<Readonly<{ workspaceRoot: string; agentUid: number; accountId: string }>>>;
    readMachineAccess(signal?: AbortSignal): Promise<unknown>;
}>;

export function createFormerAccessProjection({ formerAccess, machineId, custodianAccountId }: StorageServiceDeps) {
    return async (rows: readonly StorageItemV1[], candidates: readonly SizedStorageCategoryItem[],
        actor?: StorageOperationActor, signal?: AbortSignal): Promise<ReadonlySet<string>> => {
        const retained = new Set<string>();
        if (!formerAccess || !actor || actor.sessionIds !== undefined || !machineId || !custodianAccountId) return retained;
        const paths = new Map(rows.filter(row => row.categoryId === 'sessionFolders').map(row => [row.itemId, row.path]));
        if (!paths.size) return retained;
        const allocated = candidates.filter(item => item.allocationPlacement && paths.get(item.itemId) === item.path);
        if (!allocated.length) return retained;

        const members = new Map((await formerAccess.readMemberWorkspaces()).map(member => [member.workspaceRoot, member]));
        const attributed = new Map<string, string>();
        for (const item of allocated) {
            const placement = item.allocationPlacement!;
            const member = members.get(placement.root);
            if (!member || member.agentUid !== placement.agentUid || member.accountId === custodianAccountId) continue;
            // A symlink replacement of the allocation or an ancestor cannot
            // supply physical evidence for this protected allocation record.
            if (await realpath(item.path).catch(() => undefined) !== item.path) continue;
            attributed.set(item.itemId, member.accountId);
        }
        signal?.throwIfAborted();
        if (!attributed.size) return retained;

        // Home has already resolved the effective audience (including roles
        // with pending key setup). An unavailable roster means unknown access.
        const raw = await formerAccess.readMachineAccess(signal).catch(() => undefined);
        signal?.throwIfAborted();
        const response = MachineAccessGrantsListResponseV1Schema.safeParse(raw);
        if (!response.success) return retained;
        const access = response.data;
        if (access.machineId !== machineId || access.custodian.accountId !== custodianAccountId
            || !access.canManage || access.access.accessState !== 'ready' || !access.currentRequesterDisplayIdentities) return retained;
        const current = new Set(access.currentRequesterDisplayIdentities.map(identity => identity.accountId));
        for (const [itemId, accountId] of attributed) if (!current.has(accountId)) retained.add(itemId);
        return retained;
    };
}

export function withFormerAccess(rows: StorageItemV1[], retained: ReadonlySet<string>): StorageItemV1[] {
    return retained.size ? rows.map(item => retained.has(item.itemId) ? { ...item, retainedFor: 'former_access' } : item) : rows;
}
