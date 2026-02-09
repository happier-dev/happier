import type { ModelMode } from '../permissions/permissionTypes';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '../state/storageTypes';

export type AgentType = AgentId;

export type ModelOption = Readonly<{
    value: ModelMode;
    label: string;
    description: string;
}>;

export type PreflightModelList = Readonly<{
    availableModels: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    supportsFreeform: boolean;
}>;

export function getModelOptionsForPreflightModelList(list: PreflightModelList): readonly ModelOption[] {
    const dynamic = (list.availableModels ?? [])
        .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
        .map((m) => ({
            value: String(m.id),
            label: String(m.name),
            description: typeof m.description === 'string' ? m.description : '',
        }));

    const withDefault: ModelOption[] = [
        { value: 'default', label: getModelLabel('default'), description: '' },
        ...dynamic.filter((m) => m.value !== 'default'),
    ];

    // De-duplicate by value while preserving order (default first).
    const seen = new Set<string>();
    return withDefault.filter((opt) => {
        if (seen.has(opt.value)) return false;
        seen.add(opt.value);
        return true;
    });
}

export function hasDynamicModelListForSession(agentType: AgentType, metadata: Metadata | null | undefined): boolean {
    const state = (metadata as any)?.acpSessionModelsV1 as
        | { provider?: unknown; availableModels?: Array<{ id?: unknown }> }
        | undefined;
    return Boolean(
        state &&
        state.provider === agentType &&
        Array.isArray(state.availableModels) &&
        state.availableModels.length > 0,
    );
}

export function supportsFreeformModelSelectionForSession(agentType: AgentType, metadata: Metadata | null | undefined): boolean {
    const core = getAgentCore(agentType);
    return core.model.supportsSelection === true && core.model.supportsFreeform === true;
}

function getModelLabel(mode: ModelMode): string {
    switch (mode) {
        case 'default':
            return t('agentInput.permissionMode.default');
        case 'gemini-2.5-pro':
            return t('agentInput.geminiModel.gemini25Pro.label');
        case 'gemini-2.5-flash':
            return t('agentInput.geminiModel.gemini25Flash.label');
        case 'gemini-2.5-flash-lite':
            return t('agentInput.geminiModel.gemini25FlashLite.label');
        default:
            return mode;
    }
}

function getModelDescription(mode: ModelMode): string {
    switch (mode) {
        case 'gemini-2.5-pro':
            return t('agentInput.geminiModel.gemini25Pro.description');
        case 'gemini-2.5-flash':
            return t('agentInput.geminiModel.gemini25Flash.description');
        case 'gemini-2.5-flash-lite':
            return t('agentInput.geminiModel.gemini25FlashLite.description');
        default:
            return '';
    }
}

export function getModelOptionsForModes(modes: readonly ModelMode[]): readonly ModelOption[] {
    return modes.map((mode) => ({
        value: mode,
        label: getModelLabel(mode),
        description: getModelDescription(mode),
    }));
}

export function getModelOptionsForAgentType(agentType: AgentType): readonly ModelOption[] {
    const core = getAgentCore(agentType);
    if (core.model.supportsSelection !== true) return [];
    const withDefault = ['default', ...core.model.allowedModes];
    const unique = Array.from(new Set(withDefault));
    return getModelOptionsForModes(unique);
}

export function getModelOptionsForAgentTypeOrPreflight(params: {
    agentType: AgentType;
    preflight: PreflightModelList | null | undefined;
}): readonly ModelOption[] {
    if (params.preflight && Array.isArray(params.preflight.availableModels) && params.preflight.availableModels.length > 0) {
        return getModelOptionsForPreflightModelList(params.preflight);
    }
    return getModelOptionsForAgentType(params.agentType);
}

export function getSelectableModelIdsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly string[] {
    const state = (metadata as any)?.acpSessionModelsV1 as
        | { provider?: string; availableModels?: Array<{ id?: unknown }> }
        | undefined;
    if (state && state.provider === agentType && Array.isArray(state.availableModels) && state.availableModels.length > 0) {
        const ids = state.availableModels
            .filter((m) => m && typeof m.id === 'string' && String(m.id).trim().length > 0)
            .map((m) => String(m.id));
        return ['default', ...ids];
    }

    const core = getAgentCore(agentType);
    if (core.model.supportsSelection !== true) return [];
    const withDefault = ['default', ...core.model.allowedModes];
    return Array.from(new Set(withDefault));
}

export function isModelSelectableForSession(agentType: AgentType, metadata: Metadata | null | undefined, modelId: string): boolean {
    const normalized = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalized) return false;

    const allowed = getSelectableModelIdsForSession(agentType, metadata);
    if ((allowed as readonly string[]).includes(normalized)) return true;
    return supportsFreeformModelSelectionForSession(agentType, metadata);
}

export function getModelOptionsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly ModelOption[] {
    const state = (metadata as any)?.acpSessionModelsV1 as
        | { provider?: string; availableModels?: Array<{ id?: unknown; name?: unknown; description?: unknown }> }
        | undefined;
    if (state && state.provider === agentType && Array.isArray(state.availableModels) && state.availableModels.length > 0) {
        const dynamic = state.availableModels
            .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
            .map((m) => ({
                value: String(m.id),
                label: String(m.name),
                description: typeof m.description === 'string' ? m.description : '',
            }));

        const metadataModelOverrideRaw = (metadata as any)?.modelOverrideV1 as { modelId?: unknown } | undefined;
        const selectedModelId =
            typeof metadataModelOverrideRaw?.modelId === 'string' ? metadataModelOverrideRaw.modelId.trim() : '';

        const extraSelected: ModelOption[] = selectedModelId && !dynamic.some((m) => m.value === selectedModelId)
            ? [{ value: selectedModelId, label: selectedModelId, description: '' }]
            : [];

        const withDefault: ModelOption[] = [
            { value: 'default', label: getModelLabel('default'), description: '' },
            ...dynamic.filter((m) => m.value !== 'default'),
            ...extraSelected,
        ];

        // De-duplicate by value while preserving order (default first).
        const seen = new Set<string>();
        return withDefault.filter((opt) => {
            if (seen.has(opt.value)) return false;
            seen.add(opt.value);
            return true;
        });
    }

    const base = getModelOptionsForAgentType(agentType);
    if (base.length === 0) return base;

    const metadataModelOverrideRaw = (metadata as any)?.modelOverrideV1 as { modelId?: unknown } | undefined;
    const selectedModelId =
        typeof metadataModelOverrideRaw?.modelId === 'string' ? metadataModelOverrideRaw.modelId.trim() : '';
    if (!selectedModelId) return base;
    if (base.some((opt) => opt.value === selectedModelId)) return base;
    if (!supportsFreeformModelSelectionForSession(agentType, metadata)) return base;

    return [...base, { value: selectedModelId, label: selectedModelId, description: '' }];
}
