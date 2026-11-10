import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { ProviderConnectionDisplaySnapshotV1Schema } from './sessions/bindingMetadataV1.js';
import { SessionModelSelectionV1Schema } from './selection/v1.js';
import { ACCOUNT_SETTING_DEFINITIONS, type AccountSettingsDefaults } from '../account/settings/accountSettings.js';

const CanonicalFavoriteModelSelectionV1Schema = z.strictObject({
    selection: SessionModelSelectionV1Schema,
    catalogAgentId: z.optional(z.string()),
    builtInAgentId: z.optional(z.nullable(z.string())),
    configuredBackendId: z.optional(z.nullable(z.string())),
    backendLabel: z.optional(z.string()),
    modelLabel: z.optional(z.string()),
    providerDisplaySnapshot: z.optional(ProviderConnectionDisplaySnapshotV1Schema),
    addedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
}).check(z.superRefine((value, context) => {
    const ref = value.selection.ref;
    if (ref.providerConnectionId === null && ref.modelId.trim() === 'default') {
        context.addIssue({
            code: "custom",
            path: ['selection', 'ref', 'modelId'],
            message: 'Agent default is represented by the absence of a favorite selection',
        });
    }
}));

const LegacyFavoriteModelSelectionV1Keys = new Set([
    'backendTargetKey',
    'modelId',
    'catalogAgentId',
    'providerAgentId',
    'builtInAgentId',
    'configuredBackendId',
    'backendLabel',
    'modelLabel',
    'providerDisplaySnapshot',
    'addedAtMs',
]);

function hasOnlyLegacyFavoriteModelSelectionKeys(record: Readonly<Record<string, unknown>>): boolean {
    return Object.keys(record).every((key) => LegacyFavoriteModelSelectionV1Keys.has(key));
}

function copyLegacyFavoritePresentation(
    record: Readonly<Record<string, unknown>>,
    storedRead: boolean,
): Record<string, unknown> | null {
    if (!storedRead && !hasOnlyLegacyFavoriteModelSelectionKeys(record)) return null;

    const catalogAgentId = record.catalogAgentId;
    const providerAgentId = record.providerAgentId;
    if (catalogAgentId !== undefined && providerAgentId !== undefined && catalogAgentId !== providerAgentId) {
        return null;
    }

    return {
        ...(catalogAgentId !== undefined || providerAgentId !== undefined
            ? { catalogAgentId: catalogAgentId ?? providerAgentId }
            : {}),
        ...(record.builtInAgentId !== undefined ? { builtInAgentId: record.builtInAgentId } : {}),
        ...(record.configuredBackendId !== undefined ? { configuredBackendId: record.configuredBackendId } : {}),
        ...(record.backendLabel !== undefined ? { backendLabel: record.backendLabel } : {}),
        ...(record.modelLabel !== undefined ? { modelLabel: record.modelLabel } : {}),
        ...(record.providerDisplaySnapshot !== undefined
            ? { providerDisplaySnapshot: record.providerDisplaySnapshot }
            : {}),
        ...(record.addedAtMs !== undefined ? { addedAtMs: record.addedAtMs } : {}),
    };
}

function normalizeFavoriteModelSelection(value: unknown, storedRead = false): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (record.selection !== undefined) return value;
    const backendTargetKey = record.backendTargetKey;
    const modelId = record.modelId;
    if (typeof backendTargetKey !== 'string' || typeof modelId !== 'string') return value;
    const presentation = copyLegacyFavoritePresentation(record, storedRead);
    if (!presentation) return value;
    const addedAtMs = typeof record.addedAtMs === 'number' && Number.isFinite(record.addedAtMs)
        ? Math.max(0, Math.trunc(record.addedAtMs))
        : 0;
    return {
        ...presentation,
        selection: {
            v: 1,
            updatedAt: addedAtMs,
            ref: {
                agentTargetKey: backendTargetKey,
                providerConnectionId: null,
                modelId,
            },
        },
    };
}

export const FavoriteModelSelectionV1Schema = defineStoredReadProjection(
    (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(value => normalizeFavoriteModelSelection(value)), CanonicalFavoriteModelSelectionV1Schema),
    () => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(value => normalizeFavoriteModelSelection(value, true)), createStoredReadSchema(CanonicalFavoriteModelSelectionV1Schema)),
);
export const StoredFavoriteModelSelectionV1Schema = createStoredReadSchema(FavoriteModelSelectionV1Schema);

export type FavoriteModelSelectionV1 = z.infer<typeof FavoriteModelSelectionV1Schema>;
export type RetainedFavoriteModelSelectionsV1 = AccountSettingsDefaults['favoriteModelSelectionsV1'];

export const ModelFavoriteMutationV1Schema = z.strictObject({ selection: CanonicalFavoriteModelSelectionV1Schema, favorite: z.boolean() });
export type ModelFavoriteMutationV1 = z.infer<typeof ModelFavoriteMutationV1Schema>;

/** Exact-tuple membership intent; unrelated and unreadable retained entries stay untouched. */
export function setModelFavoriteV1(raw: Readonly<Record<string, unknown>>, input: ModelFavoriteMutationV1): Record<string, unknown> {
    const intent = ModelFavoriteMutationV1Schema.parse(input);
    const rawFavorites: RetainedFavoriteModelSelectionsV1 = Array.isArray(raw.favoriteModelSelectionsV1) ? raw.favoriteModelSelectionsV1 : [];
    const currentFavorites = rawFavorites.flatMap(value => {
        const parsed = StoredFavoriteModelSelectionV1Schema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
    });
    const identity = favoriteSelectionIdentityKey(intent.selection);
    const present = currentFavorites.some(value => favoriteSelectionIdentityKey(value) === identity);
    if (present === intent.favorite) return { ...raw };
    const nextFavorites = intent.favorite ? [...currentFavorites, intent.selection]
        : currentFavorites.filter(value => favoriteSelectionIdentityKey(value) !== identity);
    const retained = mergeCurrentFavoriteModelSelectionsIntoRaw({ rawFavorites, currentFavorites, nextFavorites });
    if (retained === rawFavorites) throw Object.assign(new Error('Account favorites capacity reached'), { code: 'favorite_model_capacity_exceeded' });
    return { ...raw, favoriteModelSelectionsV1: retained };
}

function favoriteSelectionKey(value: FavoriteModelSelectionV1): string {
    return JSON.stringify(value);
}

function favoriteSelectionIdentityKey(value: FavoriteModelSelectionV1): string {
    const ref = value.selection.ref;
    return JSON.stringify([
        ref.agentTargetKey,
        ref.providerConnectionId,
        ref.modelId.trim(),
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
            const parsed = StoredFavoriteModelSelectionV1Schema.safeParse(candidate);
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
        const parsed = StoredFavoriteModelSelectionV1Schema.safeParse(candidate);
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


