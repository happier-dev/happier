import { z } from 'zod';
import { log } from '@/log';

import { getPersistenceStorage } from '../state/persistence';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '../scope/serverAccountScope';

const acknowledgementSchema = z.object({
    operationId: z.string().min(1),
    machineId: z.string().min(1),
    seenAt: z.number().finite().optional(),
    dismissed: z.literal(true).optional(),
});
const acknowledgementsSchema = z.object({
    version: z.literal(1),
    entries: z.array(acknowledgementSchema),
});

export type ActionOperationAcknowledgement = z.infer<typeof acknowledgementSchema>;

function storageKey(scope: ServerAccountScope): string {
    return serverAccountScopedStorageKey('action-operation-acknowledgements-v1', scope);
}

export function loadActionOperationAcknowledgements(scope: ServerAccountScope): readonly ActionOperationAcknowledgement[] {
    try {
        const raw = getPersistenceStorage().getString(storageKey(scope));
        if (!raw) return [];
        return acknowledgementsSchema.parse(JSON.parse(raw)).entries;
    } catch (error) {
        log.log(`[actionOperations] Could not load local acknowledgements (${error instanceof Error ? error.name : 'unknown error'})`);
        return [];
    }
}

export function saveActionOperationAcknowledgements(
    scope: ServerAccountScope,
    entries: readonly ActionOperationAcknowledgement[],
): void {
    try {
        const storage = getPersistenceStorage();
        const key = storageKey(scope);
        const raw = JSON.stringify({ version: 1, entries });
        if (storage.getString(key) !== raw) storage.set(key, raw);
    } catch (error) {
        log.log(`[actionOperations] Could not save local acknowledgements (${error instanceof Error ? error.name : 'unknown error'})`);
    }
}
