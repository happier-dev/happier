import { buildServerScopedSessionKey, type VisibleSessionNavigationEntry } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import {
    buildSessionListSelectionScopeSignature,
    type SessionListSelectionScopeEligibility,
    type SessionListViewFilters,
} from '../search/sessionListViewFilters';

export type SessionListSelectionKeyInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
}>;

export type SessionListSelectionScopeKeyInput = Readonly<{
    filterSignature: string;
    storageKind: string;
    includeInactive: boolean;
}>;

export type SessionListSelectionScopeForViewInput = Readonly<{
    filters: SessionListViewFilters;
    eligibility: SessionListSelectionScopeEligibility;
    storageKind: string;
    includeInactive: boolean;
}>;

function normalizeScopePart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function buildSessionListSelectionKey(input: SessionListSelectionKeyInput): string {
    return buildServerScopedSessionKey(input.sessionId, input.serverId);
}

export function readSessionListSelectionKeysFromVisibleEntries(
    entries: readonly VisibleSessionNavigationEntry[],
): string[] {
    return [...new Set(entries.map((entry) => entry.sessionKey))];
}

export function readSessionListSelectionRowsFromVisibleEntries(entries: readonly VisibleSessionNavigationEntry[]): Readonly<{
    visibleOrderedKeys: readonly string[];
    entityKeysByOccurrenceKey: ReadonlyMap<string, string>;
}> {
    return {
        visibleOrderedKeys: entries.map((entry) => entry.occurrenceKey ?? entry.sessionKey),
        entityKeysByOccurrenceKey: new Map(entries.map((entry) => [entry.occurrenceKey ?? entry.sessionKey, entry.sessionKey])),
    };
}

export function buildSessionListSelectionScopeKey(input: SessionListSelectionScopeKeyInput): string {
    return JSON.stringify({
        filterSignature: input.filterSignature,
        storageKind: normalizeScopePart(input.storageKind),
        includeInactive: input.includeInactive,
    });
}

export function buildSessionListSelectionScopeKeyForView(
    input: SessionListSelectionScopeForViewInput,
): string {
    return buildSessionListSelectionScopeKey({
        filterSignature: buildSessionListSelectionScopeSignature(input.filters, input.eligibility),
        storageKind: input.storageKind,
        includeInactive: input.includeInactive,
    });
}
