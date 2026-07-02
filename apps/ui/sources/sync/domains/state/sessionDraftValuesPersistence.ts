import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { getPersistenceStorage } from './persistenceStorage';
import { sessionDraftValuesStorageKey } from './sessionLocalStateKeys';

export type RawSessionDraftValueEnvelope = Readonly<{
    v: number;
    updatedAt: number;
    lastEditedAt?: number;
    value: unknown;
}>;

export type RawSessionDraftValuesBySessionId = Record<string, Record<string, RawSessionDraftValueEnvelope>>;

export function loadRawSessionDraftValues(scope?: ServerAccountScope | null): RawSessionDraftValuesBySessionId {
    const raw = getPersistenceStorage().getString(sessionDraftValuesStorageKey(scope));
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed as RawSessionDraftValuesBySessionId;
    } catch {
        return {};
    }
}

export function saveRawSessionDraftValues(
    values: RawSessionDraftValuesBySessionId,
    scope?: ServerAccountScope | null,
): void {
    getPersistenceStorage().set(sessionDraftValuesStorageKey(scope), JSON.stringify(values));
}

export function deleteRawSessionDraftValues(scope?: ServerAccountScope | null): void {
    getPersistenceStorage().delete(sessionDraftValuesStorageKey(scope));
}
