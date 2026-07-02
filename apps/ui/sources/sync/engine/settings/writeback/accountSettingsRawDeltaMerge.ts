import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import type { Settings } from '@/sync/domains/settings/settings';

type NormalizeForPersistedStorage = (raw: Record<string, unknown>) => {
    value: Record<string, unknown>;
    changed: boolean;
};

const BLOCKED_RAW_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function toSafeRawRecord(raw: Record<string, unknown> | null): Record<string, unknown> {
    const next: Record<string, unknown> = {};
    if (!raw) return next;
    for (const [key, value] of Object.entries(raw)) {
        if (BLOCKED_RAW_KEYS.has(key)) continue;
        next[key] = value;
    }
    return next;
}

function toSafePendingRecord(pendingSettings: Partial<Settings>): Record<string, unknown> {
    const stripped = stripLocalOnlyAccountSettings(pendingSettings);
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(stripped)) {
        if (BLOCKED_RAW_KEYS.has(key)) continue;
        if (value === undefined || typeof value === 'function') continue;
        next[key] = value;
    }
    return next;
}

export function mergePendingSettingsIntoRawBaseline(params: {
    rawBaseline: Record<string, unknown> | null;
    pendingSettings: Partial<Settings>;
    normalizeForPersistedStorage: NormalizeForPersistedStorage;
}): {
    comparisonRaw: Record<string, unknown>;
    outgoingRaw: Record<string, unknown>;
    pendingRaw: Record<string, unknown>;
    comparisonChanged: boolean;
} {
    const safeBaseline = toSafeRawRecord(params.rawBaseline);
    const pendingRaw = params.normalizeForPersistedStorage(toSafePendingRecord(params.pendingSettings)).value;
    const merged = { ...safeBaseline, ...pendingRaw };
    const comparison = params.normalizeForPersistedStorage(safeBaseline);
    const outgoing = params.normalizeForPersistedStorage(merged);
    return {
        comparisonRaw: comparison.value,
        outgoingRaw: outgoing.value,
        pendingRaw,
        comparisonChanged: comparison.changed,
    };
}

export function removeCommittedPendingSettings(
    currentPendingSettings: Partial<Settings>,
    submittedPendingSettings: Partial<Settings>,
): Partial<Settings> {
    const nextPendingSettings: Partial<Settings> = {};
    for (const [key, currentValue] of Object.entries(currentPendingSettings)) {
        const submittedHasKey = Object.prototype.hasOwnProperty.call(submittedPendingSettings, key);
        const submittedValue = (submittedPendingSettings as Record<string, unknown>)[key];
        if (submittedHasKey && areAccountSettingsJsonValuesEqual(currentValue, submittedValue)) continue;
        (nextPendingSettings as Record<string, unknown>)[key] = currentValue;
    }
    return nextPendingSettings;
}
