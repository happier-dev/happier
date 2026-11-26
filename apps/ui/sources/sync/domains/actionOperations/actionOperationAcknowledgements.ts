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

function writeActionOperationAcknowledgements(scope: ServerAccountScope, entries: readonly ActionOperationAcknowledgement[]): boolean {
    try {
        const storage = getPersistenceStorage();
        const key = storageKey(scope);
        const raw = JSON.stringify({ version: 1, entries });
        if (storage.getString(key) !== raw) storage.set(key, raw);
        return true;
    } catch (error) {
        log.log(`[actionOperations] Could not save local acknowledgements (${error instanceof Error ? error.name : 'unknown'})`);
        return false;
    }
}

export function saveActionOperationAcknowledgements(scope: ServerAccountScope, entries: readonly ActionOperationAcknowledgement[]): void {
    writeActionOperationAcknowledgements(scope, entries);
}

type PersistedAcknowledgementState = Readonly<{
    scopeKey: string;
    seenAt: number | undefined;
    seenRevision: number | undefined;
    dismissed: true | undefined;
}>;

/** Scoped local decisions; snapshots and transport observations stay in the live store. */
export function createActionOperationAcknowledgementPersistence() {
    const scopes = new Map<string, ServerAccountScope>();
    const metadataByKey = new Map<string, Readonly<{ scope: ServerAccountScope; scopeKey: string; operationId: string; machineId: string }>>();
    const persistedByKey = new Map<string, PersistedAcknowledgementState>();
    const dirtyScopes = new Set<string>();

    const recordOperationMetadata = (
        state: Pick<ActionOperationStoreSnapshot, 'operationsByKey'>,
        key: string,
    ) => {
        const operation = state.operationsByKey.get(key);
        if (!operation) return;
        const scope = { serverId: operation.serverId, accountId: operation.snapshot.scope.accountId };
        metadataByKey.set(key, {
            scope,
            scopeKey: serverAccountScopeKeySuffix(scope),
            operationId: operation.snapshot.operationId,
            machineId: operation.snapshot.scope.machineId,
        });
    };

    return {
        hydrate(scope: ServerAccountScope): readonly ActionOperationAcknowledgement[] {
            const scopeKey = serverAccountScopeKeySuffix(scope);
            if (scopes.has(scopeKey)) return [];
            scopes.set(scopeKey, scope);
            const entries = loadActionOperationAcknowledgements(scope);
            for (const entry of entries) {
                const key = actionOperationAddressKey({ serverId: scope.serverId, operationId: entry.operationId });
                metadataByKey.set(key, { scope, scopeKey, operationId: entry.operationId, machineId: entry.machineId });
                persistedByKey.set(key, {
                    scopeKey,
                    seenAt: entry.seenAt,
                    seenRevision: entry.seenRevision,
                    dismissed: entry.dismissed,
                });
            }
            return entries;
        },
        prune(scope: ServerAccountScope, retainMachine: (machineId: string) => boolean, retainedOperationKeys?: ReadonlySet<string>): readonly string[] {
            const removed: string[] = [];
            for (const [key, metadata] of metadataByKey) {
                if (metadata.scope.serverId !== scope.serverId || metadata.scope.accountId !== scope.accountId
                    || retainMachine(metadata.machineId) || retainedOperationKeys?.has(key)) continue;
                metadataByKey.delete(key);
                if (persistedByKey.has(key)) dirtyScopes.add(metadata.scopeKey);
                removed.push(key);
            }
            return removed;
        },
        save(state: Pick<ActionOperationStoreSnapshot, 'operationsByKey' | 'seenAtByOperationKey' | 'dismissedRecentOperationKeys'>): void {
            for (const key of state.seenAtByOperationKey.keys()) recordOperationMetadata(state, key);
            for (const key of state.dismissedRecentOperationKeys) recordOperationMetadata(state, key);

            for (const [key, metadata] of metadataByKey) {
                const seen = state.seenAtByOperationKey.get(key);
                const dismissed = state.dismissedRecentOperationKeys.has(key) ? true : undefined;
                const prev = persistedByKey.get(key);
                if (!seen && !dismissed) {
                    if (prev) dirtyScopes.add(metadata.scopeKey);
                    continue;
                }
                const seenAt = seen?.seenAt;
                const seenRevision = seen && seen.revision >= 0 ? seen.revision : undefined;
                if (!prev || prev.scopeKey !== metadata.scopeKey || prev.seenAt !== seenAt
                    || prev.seenRevision !== seenRevision || prev.dismissed !== dismissed) {
                    dirtyScopes.add(metadata.scopeKey);
                }
            }
            if (dirtyScopes.size === 0) return;

            const entriesByScope = new Map<string, ActionOperationAcknowledgement[]>();
            const nextPersistedByScope = new Map<string, Array<readonly [string, PersistedAcknowledgementState]>>();
            for (const [key, metadata] of metadataByKey) {
                if (!dirtyScopes.has(metadata.scopeKey)) continue;
                const seen = state.seenAtByOperationKey.get(key);
                const dismissed = state.dismissedRecentOperationKeys.has(key) ? true : undefined;
                if (!seen && !dismissed) continue;
                const seenAt = seen?.seenAt;
                const seenRevision = seen && seen.revision >= 0 ? seen.revision : undefined;
                const entries = entriesByScope.get(metadata.scopeKey) ?? [];
                entries.push({
                    operationId: metadata.operationId,
                    machineId: metadata.machineId,
                    seenAt,
                    seenRevision,
                    dismissed,
                });
                entriesByScope.set(metadata.scopeKey, entries);
                const nextPersisted = nextPersistedByScope.get(metadata.scopeKey) ?? [];
                nextPersisted.push([key, { scopeKey: metadata.scopeKey, seenAt, seenRevision, dismissed }]);
                nextPersistedByScope.set(metadata.scopeKey, nextPersisted);
            }
            for (const scopeKey of [...dirtyScopes]) {
                const scope = scopes.get(scopeKey);
                if (!scope) continue;
                if (!writeActionOperationAcknowledgements(scope, entriesByScope.get(scopeKey) ?? [])) continue;
                dirtyScopes.delete(scopeKey);
                for (const [key, prev] of persistedByKey) {
                    if (prev.scopeKey === scopeKey) persistedByKey.delete(key);
                }
                for (const [key, entry] of nextPersistedByScope.get(scopeKey) ?? []) {
                    persistedByKey.set(key, entry);
                }
            }
        },
        reset(): void {
            scopes.clear();
            metadataByKey.clear();
            persistedByKey.clear();
            dirtyScopes.clear();
        },
    };
}
