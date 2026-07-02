import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { agentInputLocalUiStateStorageKey } from './sessionLocalStateKeys';
import { getPersistenceStorage } from './persistenceStorage';

export type RawAgentInputLocalUiStateEntry = Readonly<Record<string, unknown>>;
export type RawAgentInputLocalUiStateByOwnerKey = Record<string, RawAgentInputLocalUiStateEntry>;

export function loadRawAgentInputLocalUiState(scope?: ServerAccountScope | null): RawAgentInputLocalUiStateByOwnerKey {
    const raw = getPersistenceStorage().getString(agentInputLocalUiStateStorageKey(scope));
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed as RawAgentInputLocalUiStateByOwnerKey;
    } catch {
        return {};
    }
}

export function saveRawAgentInputLocalUiState(
    state: RawAgentInputLocalUiStateByOwnerKey,
    scope?: ServerAccountScope | null,
): void {
    getPersistenceStorage().set(agentInputLocalUiStateStorageKey(scope), JSON.stringify(state));
}

export function deleteRawAgentInputLocalUiState(scope?: ServerAccountScope | null): void {
    getPersistenceStorage().delete(agentInputLocalUiStateStorageKey(scope));
}
