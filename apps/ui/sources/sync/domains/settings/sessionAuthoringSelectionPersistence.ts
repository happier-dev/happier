import {
    ACCOUNT_SETTING_DEFINITIONS,
    type AccountSettingsDefaults,
} from '@happier-dev/protocol';

import {
    FavoriteModelSelectionV1Schema,
    getFavoriteModelRef,
    normalizeFavoriteModelId,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import {
    normalizeRememberedEngineSelectionScopeKey,
    RememberedEngineSelectionsByScopeV1Schema,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';

/** Protocol-owned bounded JSON carrier retained for Settings writeback. */
export type RetainedFavoriteModelSelectionsV1 = AccountSettingsDefaults['favoriteModelSelectionsV1'];

/** Protocol-owned bounded JSON carrier retained for Settings writeback. */
export type RetainedRememberedEngineSelectionsByScopeV1 =
    AccountSettingsDefaults['lastEngineSelectionsByScopeV1'];

type SettingsWithRetainedSessionAuthoringSelections = Readonly<{
    favoriteModelSelectionsV1?: RetainedFavoriteModelSelectionsV1;
    lastEngineSelectionsByScopeV1?: RetainedRememberedEngineSelectionsByScopeV1;
}>;

/** The sole typed runtime view of the retained Session-authoring carriers. */
export type CurrentSessionAuthoringSelectionsRuntimeProjection = Readonly<{
    currentFavoriteModelSelectionsV1: readonly FavoriteModelSelectionV1[];
    currentRememberedEngineSelectionsByScopeV1: RememberedEngineSelectionsByScopeV1;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read retained raw JSON only at the persistence-facing Settings boundary. */
export function readRetainedFavoriteModelSelectionsV1(
    settings: object,
): RetainedFavoriteModelSelectionsV1 {
    const value = (settings as SettingsWithRetainedSessionAuthoringSelections).favoriteModelSelectionsV1;
    return Array.isArray(value) ? value : [];
}

/** Read retained raw JSON only at the persistence-facing Settings boundary. */
export function readRetainedRememberedEngineSelectionsByScopeV1(
    settings: object,
): RetainedRememberedEngineSelectionsByScopeV1 {
    const value = (settings as SettingsWithRetainedSessionAuthoringSelections).lastEngineSelectionsByScopeV1;
    return isRecord(value) ? value : {};
}

function readCurrentFavoriteModelSelections(
    value: RetainedFavoriteModelSelectionsV1,
): readonly FavoriteModelSelectionV1[] {
    return value.flatMap((candidate) => {
        const parsed = FavoriteModelSelectionV1Schema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
    });
}

function readCurrentRememberedEngineSelections(
    value: RetainedRememberedEngineSelectionsByScopeV1,
): RememberedEngineSelectionsByScopeV1 {
    const parsed = RememberedEngineSelectionsByScopeV1Schema.safeParse(value);
    return parsed.success ? parsed.data : {};
}

/**
 * Attach non-persisted typed facts without replacing the Protocol raw roots.
 * The properties are deliberately non-enumerable so ordinary Settings
 * serialization/writeback continues to carry opaque legacy bytes unchanged.
 */
export function attachCurrentSessionAuthoringSelectionsRuntimeProjection<T extends object>(
    value: T,
): T & CurrentSessionAuthoringSelectionsRuntimeProjection {
    Object.defineProperties(value, {
        currentFavoriteModelSelectionsV1: {
            configurable: false,
            enumerable: false,
            value: readCurrentFavoriteModelSelections(readRetainedFavoriteModelSelectionsV1(value)),
            writable: false,
        },
        currentRememberedEngineSelectionsByScopeV1: {
            configurable: false,
            enumerable: false,
            value: readCurrentRememberedEngineSelections(
                readRetainedRememberedEngineSelectionsByScopeV1(value),
            ),
            writable: false,
        },
    });
    return value as T & CurrentSessionAuthoringSelectionsRuntimeProjection;
}

function favoriteSelectionKey(value: FavoriteModelSelectionV1): string {
    return JSON.stringify(value);
}

function favoriteSelectionIdentityKey(value: FavoriteModelSelectionV1): string {
    const ref = getFavoriteModelRef(value);
    return JSON.stringify([
        ref.agentTargetKey,
        ref.providerConnectionId,
        normalizeFavoriteModelId(ref.modelId),
    ]);
}

function groupFavoriteSelectionKeysByIdentity(
    values: readonly FavoriteModelSelectionV1[],
): ReadonlyMap<string, readonly string[]> {
    const grouped = new Map<string, string[]>();
    for (const value of values) {
        const identityKey = favoriteSelectionIdentityKey(value);
        const selections = grouped.get(identityKey) ?? [];
        selections.push(favoriteSelectionKey(value));
        grouped.set(identityKey, selections);
    }
    return grouped;
}

function favoriteSelectionKeyListsEqual(
    left: readonly string[] | undefined,
    right: readonly string[] | undefined,
): boolean {
    const leftValues = left ?? [];
    const rightValues = right ?? [];
    return leftValues.length === rightValues.length
        && leftValues.every((value, index) => value === rightValues[index]);
}

/**
 * Merge identity-local Favorite edits back into the retained array. A changed
 * identity is writable only while the CAS winner still matches the rendered
 * base; entries the typed projection cannot recognize remain opaque.
 */
export function mergeCurrentFavoriteModelSelectionsIntoRaw(params: Readonly<{
    rawFavorites: RetainedFavoriteModelSelectionsV1;
    currentFavorites: readonly FavoriteModelSelectionV1[];
    nextFavorites: readonly FavoriteModelSelectionV1[];
}>): RetainedFavoriteModelSelectionsV1 {
    const baseByIdentity = groupFavoriteSelectionKeysByIdentity(params.currentFavorites);
    const proposedByIdentity = groupFavoriteSelectionKeysByIdentity(params.nextFavorites);
    const winnerByIdentity = groupFavoriteSelectionKeysByIdentity(
        params.rawFavorites.flatMap((candidate) => {
            const parsed = FavoriteModelSelectionV1Schema.safeParse(candidate);
            return parsed.success ? [parsed.data] : [];
        }),
    );
    const changedIdentities = new Set([
        ...baseByIdentity.keys(),
        ...proposedByIdentity.keys(),
    ].filter((identityKey) => !favoriteSelectionKeyListsEqual(
        baseByIdentity.get(identityKey),
        proposedByIdentity.get(identityKey),
    )));
    const writableIdentities = new Set([...changedIdentities].filter((identityKey) => (
        favoriteSelectionKeyListsEqual(
            winnerByIdentity.get(identityKey),
            baseByIdentity.get(identityKey),
        )
    )));
    const retained: Array<RetainedFavoriteModelSelectionsV1[number]> = [];

    for (const candidate of params.rawFavorites) {
        const parsed = FavoriteModelSelectionV1Schema.safeParse(candidate);
        if (!parsed.success) {
            retained.push(candidate);
            continue;
        }
        if (writableIdentities.has(favoriteSelectionIdentityKey(parsed.data))) continue;
        retained.push(candidate);
    }

    for (const favorite of params.nextFavorites) {
        if (writableIdentities.has(favoriteSelectionIdentityKey(favorite))) retained.push(favorite);
    }

    const bounded = ACCOUNT_SETTING_DEFINITIONS.favoriteModelSelectionsV1.schema.safeParse(retained);
    if (!bounded.success || bounded.data.length !== retained.length) return params.rawFavorites;
    return bounded.data;
}

function rememberedSelectionKey(value: RememberedEngineSelectionsByScopeV1[string]): string {
    return JSON.stringify(value);
}

/**
 * A retained scope value is writable only when the current typed reader can
 * still recognize it. The projection schema intentionally drops malformed or
 * future authority-bearing values, so an absent projected scope means that
 * the CAS winner remains opaque to this UI writer.
 */
function readCurrentRememberedEngineSelectionAtScope(
    scopeKey: string,
    value: RetainedRememberedEngineSelectionsByScopeV1[string],
): RememberedEngineSelectionsByScopeV1[string] | null {
    const parsed = RememberedEngineSelectionsByScopeV1Schema.safeParse({ [scopeKey]: value });
    return parsed.success ? parsed.data[scopeKey] ?? null : null;
}

function rawScopeKeysForCanonicalScope(
    rawSelections: RetainedRememberedEngineSelectionsByScopeV1,
    canonicalScopeKey: string,
): readonly string[] {
    return Object.keys(rawSelections).filter((rawScopeKey) => (
        normalizeRememberedEngineSelectionScopeKey(rawScopeKey.trim()) === canonicalScopeKey
    ));
}

function rawRememberedScopeStillMatchesBase(params: Readonly<{
    rawSelections: RetainedRememberedEngineSelectionsByScopeV1;
    rawScopeKeys: readonly string[];
    canonicalScopeKey: string;
    base: RememberedEngineSelectionsByScopeV1[string] | undefined;
}>): boolean {
    if (params.base === undefined) return params.rawScopeKeys.length === 0;
    if (params.rawScopeKeys.length === 0) return false;
    const baseKey = rememberedSelectionKey(params.base);
    return params.rawScopeKeys.every((rawScopeKey) => {
        const current = readCurrentRememberedEngineSelectionAtScope(
            params.canonicalScopeKey,
            params.rawSelections[rawScopeKey]!,
        );
        return current !== null && rememberedSelectionKey(current) === baseKey;
    });
}

/**
 * The remembered-selection runtime schema intentionally retains nested
 * forward-compatible override data. Before that typed value crosses back into
 * the raw Settings carrier, ask the Protocol-owned setting definition whether
 * it is still a bounded persisted value. Its recovery schema yields `{}` for
 * an invalid present value, which lets this boundary fail closed without
 * replacing the CAS winner.
 */
function retainRememberedEngineSelectionForSettings(
    scopeKey: string,
    selection: RememberedEngineSelectionsByScopeV1[string],
): RetainedRememberedEngineSelectionsByScopeV1[string] | null {
    const parsed = ACCOUNT_SETTING_DEFINITIONS.lastEngineSelectionsByScopeV1.schema.safeParse({
        [scopeKey]: selection,
    });
    if (!parsed.success) return null;
    return parsed.data[scopeKey] ?? null;
}

/**
 * Merge scope-local remembered-selection edits back into the retained map. A
 * changed canonical scope is writable only while every equivalent raw key
 * still matches the rendered base; deletion, a newer typed value, or an opaque
 * value in the CAS winner remains authoritative.
 */
export function mergeCurrentRememberedEngineSelectionsIntoRaw(params: Readonly<{
    rawSelections: RetainedRememberedEngineSelectionsByScopeV1;
    currentSelections: RememberedEngineSelectionsByScopeV1;
    nextSelections: RememberedEngineSelectionsByScopeV1;
}>): RetainedRememberedEngineSelectionsByScopeV1 {
    const retained: Record<string, RetainedRememberedEngineSelectionsByScopeV1[string]> = {
        ...params.rawSelections,
    };

    const editedScopeKeys = new Set([
        ...Object.keys(params.currentSelections),
        ...Object.keys(params.nextSelections),
    ]);
    for (const scopeKey of editedScopeKeys) {
        if (normalizeRememberedEngineSelectionScopeKey(scopeKey.trim()) !== scopeKey) continue;
        const base = params.currentSelections[scopeKey];
        const proposed = params.nextSelections[scopeKey];
        if (base === undefined && proposed === undefined) continue;
        if (base !== undefined && proposed !== undefined
            && rememberedSelectionKey(base) === rememberedSelectionKey(proposed)) continue;

        const rawScopeKeys = rawScopeKeysForCanonicalScope(params.rawSelections, scopeKey);
        if (!rawRememberedScopeStillMatchesBase({
            rawSelections: params.rawSelections,
            rawScopeKeys,
            canonicalScopeKey: scopeKey,
            base,
        })) continue;

        const retainedSelection = proposed === undefined
            ? null
            : retainRememberedEngineSelectionForSettings(scopeKey, proposed);
        if (proposed !== undefined && retainedSelection === null) continue;
        for (const rawScopeKey of rawScopeKeys) delete retained[rawScopeKey];
        if (retainedSelection !== null) retained[scopeKey] = retainedSelection;
    }

    return retained;
}

/**
 * Replays one typed Favorite replacement intent against the raw CAS winner.
 * The rendered base identifies the user's edit; the winner remains the sole
 * source for opaque entries that appeared while that edit was in flight.
 */
export function replayFavoriteModelSelectionReplacementIntent(params: Readonly<{
    raw: Readonly<Record<string, unknown>>;
    base: readonly FavoriteModelSelectionV1[];
    proposed: readonly FavoriteModelSelectionV1[];
}>): Record<string, unknown> {
    return {
        ...params.raw,
        favoriteModelSelectionsV1: mergeCurrentFavoriteModelSelectionsIntoRaw({
            rawFavorites: readRetainedFavoriteModelSelectionsV1(params.raw),
            currentFavorites: params.base,
            nextFavorites: params.proposed,
        }),
    };
}

/**
 * Replays one typed remembered-selection replacement intent against the raw
 * CAS winner without granting the editor authority over opaque scope values.
 */
export function replayRememberedEngineSelectionReplacementIntent(params: Readonly<{
    raw: Readonly<Record<string, unknown>>;
    base: RememberedEngineSelectionsByScopeV1;
    proposed: RememberedEngineSelectionsByScopeV1;
}>): Record<string, unknown> {
    return {
        ...params.raw,
        lastEngineSelectionsByScopeV1: mergeCurrentRememberedEngineSelectionsIntoRaw({
            rawSelections: readRetainedRememberedEngineSelectionsByScopeV1(params.raw),
            currentSelections: params.base,
            nextSelections: params.proposed,
        }),
    };
}
