import type { Settings } from '@/sync/domains/settings/settings';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { accountSettingsArrayEntrySchemas } from '@/sync/domains/settings/parse/accountSettingsPerEntryParsers';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { pruneSecretBindings } from '@/sync/domains/settings/secretBindings';
import { HappyError } from '@/utils/errors/errors';
import { ProfileSecretBindingsSchema } from '@/sync/domains/settings/registry/account/accountProfilesSettingDefinitions';

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

function collectionWriteError(key: string, reason: 'invalid' | 'unreadable'): HappyError {
    return new HappyError(`Cannot save ${reason} account settings collection: ${key}`, false, {
        kind: 'config', code: 'account_settings_collection_invalid',
    });
}

function unreadableEntryIds(entries: readonly unknown[]): Set<string> {
    return new Set(entries.flatMap(entry => {
        if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') return [];
        return [entry.id];
    }));
}

function preserveUnreadableEntries(
    baseline: Record<string, unknown>,
    pending: Record<string, unknown>,
): Record<string, unknown> {
    const merged = { ...baseline, ...pending };
    if (!Object.hasOwn(pending, 'secretBindingsByProfileId')
        && !Array.from(accountSettingsArrayEntrySchemas.keys()).some(key => Object.hasOwn(pending, key))) return merged;
    const unreadable = new Map<string, unknown[]>();
    for (const [key, schema] of accountSettingsArrayEntrySchemas) {
        const original = baseline[key];
        const omitted = Array.isArray(original) ? original.filter(entry => !schema.safeParse(entry).success) : [];
        unreadable.set(key, omitted);
        if (!Object.hasOwn(pending, key)) continue;
        if (original !== undefined && !Array.isArray(original)) throw collectionWriteError(key, 'unreadable');
        const replacement = pending[key];
        if (!Array.isArray(replacement) || replacement.some(entry => !schema.safeParse(entry).success)) {
            throw collectionWriteError(key, 'invalid');
        }
        const unreadableIds = unreadableEntryIds(omitted);
        if (Array.from(unreadableEntryIds(replacement)).some(id => unreadableIds.has(id))) {
            throw collectionWriteError(key, 'unreadable');
        }
        // A runtime projection cannot authorize deletion of entries it could not read.
        merged[key] = [...replacement, ...omitted];
    }

    if (!Object.hasOwn(pending, 'secretBindingsByProfileId')) return merged;
    const originalBindings = ProfileSecretBindingsSchema.safeParse(baseline.secretBindingsByProfileId);
    const pendingBindings = ProfileSecretBindingsSchema.safeParse(pending.secretBindingsByProfileId);
    if (!originalBindings.success) throw collectionWriteError('secretBindingsByProfileId', 'unreadable');
    if (!pendingBindings.success) throw collectionWriteError('secretBindingsByProfileId', 'invalid');
    if (Object.keys(originalBindings.data).length === 0) return merged;

    for (const key of ['profiles', 'secrets']) {
        if (baseline[key] !== undefined && !Array.isArray(baseline[key])) throw collectionWriteError(key, 'unreadable');
    }
    const unreadableProfiles = unreadableEntryIds(unreadable.get('profiles') ?? []);
    const unreadableSecrets = unreadableEntryIds(unreadable.get('secrets') ?? []);
    const readableProfiles = Array.isArray(merged.profiles) ? merged.profiles.flatMap(entry => {
        const parsed = AIBackendProfileSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    }) : [];
    // Reuse the binding owner for requirements, built-ins and explicit profile deletions.
    const bindingsToUnreadableSecrets = pruneSecretBindings({
        profiles: readableProfiles,
        secrets: Array.from(unreadableSecrets, id => ({ id })),
        secretBindingsByProfileId: originalBindings.data,
    }).secretBindingsByProfileId;
    const preserved = Object.fromEntries(Object.entries(originalBindings.data).flatMap(([profileId, byEnv]) => {
        const bindings = unreadableProfiles.has(profileId) ? byEnv
            : Object.hasOwn(bindingsToUnreadableSecrets, profileId) ? bindingsToUnreadableSecrets[profileId] : {};
        return Object.keys(bindings).length > 0 ? [[profileId, bindings]] : [];
    }));
    const ids = new Set([...Object.keys(preserved), ...Object.keys(pendingBindings.data)]);
    merged.secretBindingsByProfileId = Object.fromEntries(Array.from(ids, id => [id, {
        ...(Object.hasOwn(preserved, id) ? preserved[id] : {}),
        ...(Object.hasOwn(pendingBindings.data, id) ? pendingBindings.data[id] : {}),
    }]));
    return merged;
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
    const merged = preserveUnreadableEntries(safeBaseline, pendingRaw);
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
