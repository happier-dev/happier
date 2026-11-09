import * as z from 'zod/mini';
import { log } from '@/log';
import { actionOperationAddressKey } from './qualifiedActionOperation';
import type { ActionOperationStoreSnapshot } from './actionOperationStore';
import { getPersistenceStorage } from '../state/persistenceStorage';
import { serverAccountScopedStorageKey, serverAccountScopeKeySuffix, type ServerAccountScope } from '../scope/serverAccountScope';

const acknowledgementSchema = z.object({
    operationId: z.string().check(z.minLength(1)),
    machineId: z.string().check(z.minLength(1)),
    seenAt: z.optional(z.number()),
    seenRevision: z.optional(z.int().check(z.minimum(0))),
    dismissed: z.optional(z.literal(true)),
});
const acknowledgementsSchema = z.object({ version: z.literal(1), entries: z.array(acknowledgementSchema) });
export type ActionOperationAcknowledgement = z.infer<typeof acknowledgementSchema>;

function storageKey(scope: ServerAccountScope): string {
    return serverAccountScopedStorageKey('action-operation-acknowledgements-v1', scope);
}

export function loadActionOperationAcknowledgements(scope: ServerAccountScope): readonly ActionOperationAcknowledgement[] {
    try {
        const raw = getPersistenceStorage().getString(storageKey(scope));
        return raw ? acknowledgementsSchema.parse(JSON.parse(raw)).entries : [];
    } catch (error) {
        log.log(`[actionOperations] Could not load local acknowledgements (${error instanceof Error ? error.name : 'unknown'})`);
        return [];
    }
}

export function saveActionOperationAcknowledgements(scope: ServerAccountScope, entries: readonly ActionOperationAcknowledgement[]): void {
    try {
        const storage = getPersistenceStorage();
        const key = storageKey(scope);
        const raw = JSON.stringify({ version: 1, entries });
        if (storage.getString(key) !== raw) storage.set(key, raw);
    } catch (error) {
        log.log(`[actionOperations] Could not save local acknowledgements (${error instanceof Error ? error.name : 'unknown'})`);
    }
}

/** Scoped local decisions; snapshots and transport observations stay in the live store. */
export function createActionOperationAcknowledgementPersistence() {
    const scopes = new Map<string, ServerAccountScope>();
    const metadataByKey = new Map<string, Readonly<{ scope: ServerAccountScope; operationId: string; machineId: string }>>();
    return {
        hydrate(scope: ServerAccountScope): readonly ActionOperationAcknowledgement[] {
            const scopeKey = serverAccountScopeKeySuffix(scope);
            if (scopes.has(scopeKey)) return [];
            scopes.set(scopeKey, scope);
            const entries = loadActionOperationAcknowledgements(scope);
            for (const entry of entries) metadataByKey.set(actionOperationAddressKey({ serverId: scope.serverId, operationId: entry.operationId }), {
                scope, operationId: entry.operationId, machineId: entry.machineId,
            });
            return entries;
        },
        prune(scope: ServerAccountScope, retainMachine: (machineId: string) => boolean, retainedOperationKeys?: ReadonlySet<string>): readonly string[] {
            const removed: string[] = [];
            for (const [key, metadata] of metadataByKey) {
                if (metadata.scope.serverId !== scope.serverId || metadata.scope.accountId !== scope.accountId
                    || retainMachine(metadata.machineId) || retainedOperationKeys?.has(key)) continue;
                metadataByKey.delete(key);
                removed.push(key);
            }
            return removed;
        },
        save(state: Pick<ActionOperationStoreSnapshot, 'operationsByKey' | 'seenAtByOperationKey' | 'dismissedRecentOperationKeys'>): void {
            for (const [key, operation] of state.operationsByKey) {
                if (!state.seenAtByOperationKey.has(key) && !state.dismissedRecentOperationKeys.has(key)) continue;
                metadataByKey.set(key, { scope: { serverId: operation.serverId, accountId: operation.snapshot.scope.accountId },
                    operationId: operation.snapshot.operationId, machineId: operation.snapshot.scope.machineId });
            }
            const entriesByScope = new Map<string, ActionOperationAcknowledgement[]>();
            for (const [key, metadata] of metadataByKey) {
                const seen = state.seenAtByOperationKey.get(key);
                const dismissed = state.dismissedRecentOperationKeys.has(key);
                if (!seen && !dismissed) continue;
                const scopeKey = serverAccountScopeKeySuffix(metadata.scope);
                const entries = entriesByScope.get(scopeKey) ?? [];
                entries.push({ operationId: metadata.operationId, machineId: metadata.machineId, seenAt: seen?.seenAt,
                    seenRevision: seen && seen.revision >= 0 ? seen.revision : undefined,
                    dismissed: dismissed ? true : undefined });
                entriesByScope.set(scopeKey, entries);
            }
            for (const [scopeKey, scope] of scopes) saveActionOperationAcknowledgements(scope, entriesByScope.get(scopeKey) ?? []);
        },
        reset(): void { scopes.clear(); metadataByKey.clear(); },
    };
}
