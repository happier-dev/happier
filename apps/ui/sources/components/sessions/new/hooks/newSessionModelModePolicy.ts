import {
    hasConstrainedFreeformModelIds,
    isFreeformModelIdAllowed,
} from '@happier-dev/agents';

export type NewSessionModelConfig = Readonly<{
    defaultMode: string | null | undefined;
    allowedModes: readonly string[];
    supportsFreeform?: boolean;
    freeformModelIdPrefixes?: readonly string[];
    dynamicProbe?: 'auto' | 'static-only';
}>;

export type NewSessionPreflightModels = Readonly<{
    targetKey?: string | null;
    availableModels: ReadonlyArray<Readonly<{ id: string; name?: string | null }>>;
    supportsFreeform: boolean;
    unavailable?: boolean;
}>;

function normalizeModelId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function resolveFallbackModelMode(modelConfig: NewSessionModelConfig): string {
    return normalizeModelId(modelConfig.defaultMode) || 'default';
}

function canKeepUnknownModelMode(modelConfig: NewSessionModelConfig, modelMode: string): boolean {
    if (isFreeformModelIdAllowed(modelConfig, modelMode)) return true;
    if (hasConstrainedFreeformModelIds(modelConfig)) return false;
    return modelConfig.dynamicProbe === 'auto';
}

function resolveUniquePreflightModelAlias(params: Readonly<{
    modelMode: string;
    availableModels: NewSessionPreflightModels['availableModels'];
}>): string | null {
    const mode = normalizeModelId(params.modelMode);
    if (!mode) return null;

    let match: string | null = null;
    for (const model of params.availableModels) {
        const id = normalizeModelId(model.id);
        if (!id) continue;
        const name = normalizeModelId(model.name);
        if (name !== mode) continue;
        if (match !== null && match !== id) return null;
        match = id;
    }
    return match && match !== mode ? match : null;
}

export function resolveInitialNewSessionModelMode(params: Readonly<{
    draftModelMode: string | null | undefined;
    modelConfig: NewSessionModelConfig;
}>): string {
    const draft = normalizeModelId(params.draftModelMode);
    if (draft) {
        const allowed = new Set<string>(['default', ...(params.modelConfig.allowedModes ?? [])]);
        if (allowed.has(draft)) return draft;
        if (canKeepUnknownModelMode(params.modelConfig, draft)) return draft;
    }

    return resolveFallbackModelMode(params.modelConfig);
}

export function coerceNewSessionModelMode(params: Readonly<{
    modelMode: string | null | undefined;
    modelConfig: NewSessionModelConfig;
    preflight: NewSessionPreflightModels | null | undefined;
    currentTargetKey?: string | null;
}>): string {
    const mode = normalizeModelId(params.modelMode);
    if (!mode) return resolveFallbackModelMode(params.modelConfig);
    if (mode === 'default') return mode;

    const preflight = (() => {
        const candidate = params.preflight;
        if (!candidate) return null;
        const candidateTargetKey = normalizeModelId(candidate.targetKey);
        const currentTargetKey = normalizeModelId(params.currentTargetKey);
        if (candidateTargetKey && currentTargetKey && candidateTargetKey !== currentTargetKey) {
            return null;
        }
        return candidate;
    })();
    if (preflight?.unavailable === true) {
        return resolveFallbackModelMode(params.modelConfig);
    }
    if (preflight && Array.isArray(preflight.availableModels) && preflight.availableModels.length > 0) {
        const allowed = new Set<string>(['default', ...preflight.availableModels.map((m) => normalizeModelId(m.id)).filter(Boolean)]);
        if (allowed.has(mode)) return mode;
        const aliasedModelId = resolveUniquePreflightModelAlias({
            modelMode: mode,
            availableModels: preflight.availableModels,
        });
        if (aliasedModelId) return aliasedModelId;
        if (preflight.supportsFreeform === true && isFreeformModelIdAllowed(params.modelConfig, mode)) return mode;
        if (!hasConstrainedFreeformModelIds(params.modelConfig) && params.modelConfig.dynamicProbe === 'auto') return mode;
        return resolveFallbackModelMode(params.modelConfig);
    }

    if (canKeepUnknownModelMode(params.modelConfig, mode)) return mode;

    const allowed = new Set<string>(['default', ...(params.modelConfig.allowedModes ?? [])]);
    return allowed.has(mode) ? mode : resolveFallbackModelMode(params.modelConfig);
}
