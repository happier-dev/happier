import { z } from 'zod/mini';
import { ProviderConnectionDisplaySnapshotV1Schema, type ProviderConnectionDisplaySnapshotV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { ProviderBoundModelRefSchema, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import { FavoriteModelSelectionV1Schema } from '@happier-dev/protocol/providers/modelFavoritesV1';

import type { ModelOption, PreflightModelList } from '@/sync/domains/models/modelOptions';

export { FavoriteModelSelectionV1Schema, StoredFavoriteModelSelectionV1Schema } from '@happier-dev/protocol/providers/modelFavoritesV1';

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
    reasoningEffort?: FavoriteModelSelectionV1['reasoningEffort'];
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
            ...(favorite.reasoningEffort === undefined ? {} : { reasoningEffort: favorite.reasoningEffort }),
            modelId,
            modelLabel: available.modelLabel || favorite.modelLabel || modelId,
            modelDescription: available.modelDescription,
            backendLabel: params.backendLabel ?? favorite.backendLabel,
        });
    }

    return out;
}

export function rememberFavoriteModelReasoningEffort(
    favorites: readonly FavoriteModelSelectionV1[],
    ref: ProviderBoundModelRef,
    reasoningEffort: string,
): FavoriteModelSelectionV1[] | null {
    const target = favorites.find(favorite => {
        const current = getFavoriteModelRef(favorite);
        return current.agentTargetKey === ref.agentTargetKey
            && current.providerConnectionId === ref.providerConnectionId
            && normalizeFavoriteModelId(current.modelId) === normalizeFavoriteModelId(ref.modelId);
    });
    if (!target || target.reasoningEffort === reasoningEffort) return null;
    return favorites.map(favorite => favorite === target ? { ...favorite, reasoningEffort } : favorite);
}

export function toggleFavoriteModelSelection(params: Readonly<{
    favorites: readonly FavoriteModelSelectionV1[];
    backend: FavoriteModelBackendIdentity;
    modelRef: ProviderBoundModelRef;
    modelLabel?: string | null;
    backendLabel?: string | null;
    providerDisplaySnapshot?: FavoriteProviderDisplaySnapshot | null;
    reasoningEffort?: FavoriteModelSelectionV1['reasoningEffort'];
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
    const reasoningEffort = normalizeOptionalString(params.reasoningEffort);
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
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(providerDisplaySnapshot ? { providerDisplaySnapshot } : {}),
            ...(typeof params.addedAtMs === 'number' && Number.isFinite(params.addedAtMs)
                ? { addedAtMs: Math.trunc(params.addedAtMs) }
                : {}),
        },
    ];
}
