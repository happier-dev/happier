export type NewSessionModelConfig = Readonly<{
    defaultMode: string;
    allowedModes: readonly string[];
    supportsFreeform?: boolean;
}>;

export type NewSessionPreflightModels = Readonly<{
    availableModels: ReadonlyArray<Readonly<{ id: string }>>;
    supportsFreeform: boolean;
}>;

function normalizeModelId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function resolveInitialNewSessionModelMode(params: Readonly<{
    draftModelMode: string | null | undefined;
    modelConfig: NewSessionModelConfig;
}>): string {
    const draft = normalizeModelId(params.draftModelMode);
    if (draft) {
        if (params.modelConfig.supportsFreeform === true) return draft;
        const allowed = new Set<string>(['default', ...(params.modelConfig.allowedModes ?? [])]);
        if (allowed.has(draft)) return draft;
    }

    return normalizeModelId(params.modelConfig.defaultMode) || 'default';
}

export function coerceNewSessionModelMode(params: Readonly<{
    modelMode: string | null | undefined;
    modelConfig: NewSessionModelConfig;
    preflight: NewSessionPreflightModels | null | undefined;
}>): string {
    const mode = normalizeModelId(params.modelMode);
    if (!mode) return normalizeModelId(params.modelConfig.defaultMode) || 'default';
    if (mode === 'default') return mode;

    const preflight = params.preflight;
    if (preflight && Array.isArray(preflight.availableModels) && preflight.availableModels.length > 0) {
        if (preflight.supportsFreeform === true) return mode;
        const allowed = new Set<string>(['default', ...preflight.availableModels.map((m) => normalizeModelId(m.id)).filter(Boolean)]);
        return allowed.has(mode) ? mode : (normalizeModelId(params.modelConfig.defaultMode) || 'default');
    }

    if (params.modelConfig.supportsFreeform === true) return mode;

    const allowed = new Set<string>(['default', ...(params.modelConfig.allowedModes ?? [])]);
    return allowed.has(mode) ? mode : (normalizeModelId(params.modelConfig.defaultMode) || 'default');
}

