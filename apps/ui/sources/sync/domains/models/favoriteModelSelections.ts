import { z } from 'zod';
import {
    ProviderConnectionDisplaySnapshotV1Schema,
    ProviderBoundModelRefSchema,
    SessionModelSelectionV1Schema,
    type ProviderConnectionDisplaySnapshotV1,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol';

import type { ModelOption, PreflightModelList } from '@/sync/domains/models/modelOptions';

const CanonicalFavoriteModelSelectionV1Schema = z.object({
    selection: SessionModelSelectionV1Schema,
    catalogAgentId: z.string().optional(),
    builtInAgentId: z.string().nullable().optional(),
    configuredBackendId: z.string().nullable().optional(),
    backendLabel: z.string().optional(),
    modelLabel: z.string().optional(),
    providerDisplaySnapshot: ProviderConnectionDisplaySnapshotV1Schema.optional(),
    addedAtMs: z.number().int().nonnegative().optional(),
}).superRefine((value, context) => {
    const ref = value.selection.ref;
    if (ref.providerConnectionId === null && ref.modelId.trim() === 'default') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['selection', 'ref', 'modelId'],
            message: 'Agent default is represented by the absence of a favorite selection',
        });
    }
});

export const FavoriteModelSelectionV1Schema = z.preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (record.selection !== undefined) return value;
    if (typeof record.backendTargetKey !== 'string' || typeof record.modelId !== 'string') return value;
    const addedAtMs = typeof record.addedAtMs === 'number' && Number.isFinite(record.addedAtMs)
        ? Math.max(0, Math.trunc(record.addedAtMs))
        : 0;
    const { backendTargetKey, modelId, ...presentation } = record;
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
}, CanonicalFavoriteModelSelectionV1Schema);

export type FavoriteModelSelectionV1 = z.infer<typeof FavoriteModelSelectionV1Schema>;
export type FavoriteProviderDisplaySnapshot = ProviderConnectionDisplaySnapshotV1;

export function getFavoriteModelRef(selection: FavoriteModelSelectionV1): ProviderBoundModelRef {
    return selection.selection.ref;
}

export type FavoriteModelBackendIdentity = Readonly<{
    backendTargetKey: string;
    catalogAgentId?: string | null;
    builtInAgentId?: string | null;
    configuredBackendId?: string | null;
}>;

export type FavoriteModelAvailabilityMode = 'dynamic' | 'static-only';

export type AvailableFavoriteModel = Readonly<{
    modelSelection: FavoriteModelSelectionV1['selection'];
    modelId: string;
    modelLabel: string;
    modelDescription: string;
    backendLabel?: string;
}>;

export type FavoriteModelAvailability = Readonly<Omit<AvailableFavoriteModel, 'modelSelection'>>;

function normalizeOptionalString(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

export function normalizeFavoriteModelId(value: string | null | undefined): string {
    return normalizeOptionalString(value) ?? '';
}

export function isFavoriteModelSelectableId(value: string | null | undefined): boolean {
    const modelId = normalizeFavoriteModelId(value);
    return modelId.length > 0 && modelId !== 'default';
}

export function isFavoriteModelRefSelectable(ref: ProviderBoundModelRef): boolean {
    const parsed = ProviderBoundModelRefSchema.parse(ref);
    const modelId = normalizeFavoriteModelId(parsed.modelId);
    return modelId.length > 0 && (parsed.providerConnectionId !== null || modelId !== 'default');
}

export function favoriteModelSelectionMatchesBackend(
    selection: FavoriteModelSelectionV1,
    backend: FavoriteModelBackendIdentity,
): boolean {
    const selectionTargetKey = normalizeOptionalString(getFavoriteModelRef(selection).agentTargetKey);
    const backendTargetKey = normalizeOptionalString(backend.backendTargetKey);
    if (selectionTargetKey && backendTargetKey) {
        return selectionTargetKey === backendTargetKey;
    }

    const selectionBuiltInAgentId = normalizeOptionalString(selection.builtInAgentId);
    const backendBuiltInAgentId = normalizeOptionalString(backend.builtInAgentId);
    if (selectionBuiltInAgentId && backendBuiltInAgentId && selectionBuiltInAgentId === backendBuiltInAgentId) {
        return true;
    }

    const selectionConfiguredBackendId = normalizeOptionalString(selection.configuredBackendId);
    const backendConfiguredBackendId = normalizeOptionalString(backend.configuredBackendId);
    return Boolean(
        selectionConfiguredBackendId
        && backendConfiguredBackendId
        && selectionConfiguredBackendId === backendConfiguredBackendId,
    );
}

function addModelOptionAvailability(
    out: Map<string, FavoriteModelAvailability>,
    option: ModelOption,
): void {
    const modelId = normalizeFavoriteModelId(option.value);
    if (!isFavoriteModelSelectableId(modelId) || out.has(modelId)) return;
    out.set(modelId, {
        modelId,
        modelLabel: option.label || modelId,
        modelDescription: option.description ?? '',
    });
    const extendedContextModelId = normalizeFavoriteModelId(option.extendedContextModelId);
    if (isFavoriteModelSelectableId(extendedContextModelId) && !out.has(extendedContextModelId)) {
        out.set(extendedContextModelId, {
            modelId: extendedContextModelId,
            modelLabel: option.label || modelId,
            modelDescription: option.description ?? '',
        });
    }
}

export function buildFavoriteModelAvailabilityById(params: Readonly<{
    mode: FavoriteModelAvailabilityMode;
    modelOptions: readonly ModelOption[];
    preflightModels: PreflightModelList | null | undefined;
}>): ReadonlyMap<string, FavoriteModelAvailability> {
    const out = new Map<string, FavoriteModelAvailability>();

    if (params.mode === 'static-only') {
        for (const option of params.modelOptions) {
            addModelOptionAvailability(out, option);
        }
        return out;
    }

    for (const model of params.preflightModels?.availableModels ?? []) {
        const modelId = normalizeFavoriteModelId(model.id);
        if (!isFavoriteModelSelectableId(modelId) || out.has(modelId)) continue;
        out.set(modelId, {
            modelId,
            modelLabel: model.name || modelId,
            modelDescription: model.description ?? '',
        });
        const extendedContextModelId = normalizeFavoriteModelId(model.extendedContextModelId);
        if (isFavoriteModelSelectableId(extendedContextModelId) && !out.has(extendedContextModelId)) {
            out.set(extendedContextModelId, {
                modelId: extendedContextModelId,
                modelLabel: model.name || modelId,
                modelDescription: model.description ?? '',
            });
        }
    }

    for (const option of params.modelOptions) {
        addModelOptionAvailability(out, option);
    }

    return out;
}

export function resolveAvailableFavoriteModelsForBackend(params: Readonly<{
    favorites: readonly FavoriteModelSelectionV1[];
    backend: FavoriteModelBackendIdentity;
    availabilityById: ReadonlyMap<string, FavoriteModelAvailability>;
    providerAvailabilityByRefKey?: ReadonlyMap<string, FavoriteModelAvailability>;
    backendLabel?: string | null;
}>): readonly AvailableFavoriteModel[] {
    const out: AvailableFavoriteModel[] = [];
    const seen = new Set<string>();

    for (const favorite of params.favorites) {
        if (!favoriteModelSelectionMatchesBackend(favorite, params.backend)) continue;
        const modelRef = getFavoriteModelRef(favorite);
        const modelId = normalizeFavoriteModelId(modelRef.modelId);
        if (!isFavoriteModelRefSelectable(modelRef)) continue;
        const identityKey = JSON.stringify([modelRef.agentTargetKey, modelRef.providerConnectionId, modelId]);
        if (seen.has(identityKey)) continue;

        const available = modelRef.providerConnectionId === null
            ? params.availabilityById.get(modelId)
            : params.providerAvailabilityByRefKey?.get(identityKey);
        if (!available) continue;
        seen.add(identityKey);
        out.push({
            modelSelection: favorite.selection,
            modelId,
            modelLabel: available.modelLabel || favorite.modelLabel || modelId,
            modelDescription: available.modelDescription,
            backendLabel: params.backendLabel ?? favorite.backendLabel,
        });
    }

    return out;
}

export function toggleFavoriteModelSelection(params: Readonly<{
    favorites: readonly FavoriteModelSelectionV1[];
    backend: FavoriteModelBackendIdentity;
    modelRef: ProviderBoundModelRef;
    modelLabel?: string | null;
    backendLabel?: string | null;
    providerDisplaySnapshot?: FavoriteProviderDisplaySnapshot | null;
    addedAtMs?: number;
}>): FavoriteModelSelectionV1[] {
    const modelRef = ProviderBoundModelRefSchema.parse(params.modelRef);
    if (modelRef.agentTargetKey !== params.backend.backendTargetKey) {
        throw new Error('Favorite model selection target mismatch');
    }
    const modelId = normalizeFavoriteModelId(modelRef.modelId);
    if (!isFavoriteModelRefSelectable(modelRef)) return [...params.favorites];

    const withoutExisting = params.favorites.filter((favorite) => (
        !favoriteModelSelectionMatchesBackend(favorite, params.backend)
        || getFavoriteModelRef(favorite).providerConnectionId !== modelRef.providerConnectionId
        || normalizeFavoriteModelId(getFavoriteModelRef(favorite).modelId) !== modelId
    ));
    if (withoutExisting.length !== params.favorites.length) {
        return withoutExisting;
    }

    const catalogAgentId = normalizeOptionalString(params.backend.catalogAgentId);
    const builtInAgentId = normalizeOptionalString(params.backend.builtInAgentId);
    const configuredBackendId = normalizeOptionalString(params.backend.configuredBackendId);
    const backendLabel = normalizeOptionalString(params.backendLabel);
    const modelLabel = normalizeOptionalString(params.modelLabel);
    const providerDisplaySnapshot = modelRef.providerConnectionId !== null
        && params.providerDisplaySnapshot
        ? ProviderConnectionDisplaySnapshotV1Schema.parse(params.providerDisplaySnapshot)
        : null;

    return [
        ...params.favorites,
        {
            selection: {
                v: 1,
                updatedAt: typeof params.addedAtMs === 'number' && Number.isFinite(params.addedAtMs)
                    ? Math.max(0, Math.trunc(params.addedAtMs))
                    : Date.now(),
                ref: modelRef,
            },
            ...(catalogAgentId ? { catalogAgentId } : {}),
            ...(builtInAgentId ? { builtInAgentId } : {}),
            ...(configuredBackendId ? { configuredBackendId } : {}),
            ...(backendLabel ? { backendLabel } : {}),
            ...(modelLabel ? { modelLabel } : {}),
            ...(providerDisplaySnapshot ? { providerDisplaySnapshot } : {}),
            ...(typeof params.addedAtMs === 'number' && Number.isFinite(params.addedAtMs)
                ? { addedAtMs: Math.trunc(params.addedAtMs) }
                : {}),
        },
    ];
}
