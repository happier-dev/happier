import type { ModelMode } from '../permissions/permissionTypes';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import type { Metadata } from '../state/storageTypes';
import type { AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import {
    getAgentStaticModels,
    isFreeformModelIdAllowed,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
    readMetadataAliasValue,
    resolveModelSelectionIntentFromSessionMetadata,
    SESSION_MODELS_STATE_KEY,
    type AgentModelConfig,
} from '@happier-dev/agents';

export type AgentType = AgentId;

export type ModelOption = Readonly<{
    value: ModelMode;
    label: string;
    description: string;
    extendedContextModelId?: string;
    modelOptions?: readonly AcpConfigOption[];
}>;

export type PreflightModelList = Readonly<{
    availableModels: ReadonlyArray<Readonly<{
        id: string;
        name: string;
        description?: string;
        extendedContextModelId?: string;
        modelOptions?: readonly AcpConfigOption[];
    }>>;
    supportsFreeform: boolean;
    unavailable?: boolean;
}>;

export function createUnavailablePreflightModelList(): PreflightModelList {
    return {
        availableModels: [],
        supportsFreeform: false,
        unavailable: true,
    };
}

type SessionModelListState = Readonly<{
    agentId?: string;
    availableModels?: Array<{
        id?: unknown;
        name?: unknown;
        description?: unknown;
        extendedContextModelId?: unknown;
        modelOptions?: unknown;
    }>;
}>;

function dedupeModelOptionsByValue(options: readonly ModelOption[]): readonly ModelOption[] {
    const seen = new Set<string>();
    return options.filter((option) => {
        if (seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
    });
}

export function readExtendedContextModelId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function mergeDynamicModelOptionWithCatalog(
    option: ModelOption,
    catalogByValue: ReadonlyMap<string, ModelOption>,
): ModelOption {
    const catalog = catalogByValue.get(option.value) ?? null;
    if (!catalog) return option;
    const hasModelOptions = Array.isArray(option.modelOptions) && option.modelOptions.length > 0;
    const hasDescription = typeof option.description === 'string' && option.description.trim().length > 0;
    const hasExtendedContextModelId = readExtendedContextModelId(option.extendedContextModelId) !== undefined;
    return {
        ...option,
        ...(!hasDescription && catalog.description ? { description: catalog.description } : {}),
        ...(!hasModelOptions && catalog.modelOptions ? { modelOptions: catalog.modelOptions } : {}),
        ...(!hasExtendedContextModelId && catalog.extendedContextModelId
            ? { extendedContextModelId: catalog.extendedContextModelId }
            : {}),
    };
}

function mergeModelOptionsWithCatalog(params: Readonly<{
    options: readonly ModelOption[];
    catalogOptions: readonly ModelOption[];
    appendMissingCatalogOptions: boolean;
}>): readonly ModelOption[] {
    const catalogByValue = new Map(params.catalogOptions.map((option) => [option.value, option] as const));
    const merged = dedupeModelOptionsByValue(params.options.map((option) => mergeDynamicModelOptionWithCatalog(option, catalogByValue)));

    if (!params.appendMissingCatalogOptions) return merged;

    const seen = new Set(merged.map((option) => option.value));
    return [
        ...merged,
        ...params.catalogOptions.filter((option) => {
            if (seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
        }),
    ];
}

function appendSelectedFreeformModelOption(params: Readonly<{
    options: readonly ModelOption[];
    selectedModelId: string;
    modelConfig: AgentModelConfig;
}>): readonly ModelOption[] {
    if (!isFreeformModelIdAllowed(params.modelConfig, params.selectedModelId)) return params.options;
    if (params.options.some((option) => option.value === params.selectedModelId)) return params.options;
    return [
        ...params.options,
        { value: params.selectedModelId, label: params.selectedModelId, description: '' },
    ];
}

function readSessionModelListState(metadata: Metadata | null | undefined): SessionModelListState | null {
    return readMetadataAliasValue<SessionModelListState>(
        (metadata as any) ?? {},
        SESSION_MODELS_STATE_KEY,
        LEGACY_ACP_SESSION_MODELS_STATE_KEY,
    ) ?? null;
}

function readSelectedModelOverrideId(agentType: AgentType, metadata: Metadata | null | undefined): string {
    const intent = resolveModelSelectionIntentFromSessionMetadata(
        metadata,
        buildAgentUniverseBackendTargetKey(agentType),
    );
    return typeof intent?.selection?.modelId === 'string' ? intent.selection.modelId.trim() : '';
}

function supportsDynamicSessionModelList(agentType: AgentType): boolean {
    return getAgentCore(agentType).model.dynamicProbe !== 'static-only';
}

function normalizeTargetKey(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function isPreflightListCurrentForTarget(params: Readonly<{
    preflightTargetKey?: string | null;
    currentTargetKey?: string | null;
}>): boolean {
    const preflightTargetKey = normalizeTargetKey(params.preflightTargetKey);
    const currentTargetKey = normalizeTargetKey(params.currentTargetKey);
    if (!currentTargetKey) return true;
    return Boolean(preflightTargetKey) && preflightTargetKey === currentTargetKey;
}

export function getModelOptionsForPreflightModelList(list: PreflightModelList): readonly ModelOption[] {
    const dynamic = (list.availableModels ?? [])
        .flatMap((m) => {
            const value = typeof m?.id === 'string' ? m.id.trim() : '';
            const label = typeof m?.name === 'string' ? m.name.trim() : '';
            if (!value || !label) return [];
            return [{
                value,
                label,
                description: typeof m.description === 'string' ? m.description : '',
                ...(readExtendedContextModelId(m.extendedContextModelId)
                    ? { extendedContextModelId: readExtendedContextModelId(m.extendedContextModelId) }
                    : {}),
                ...(Array.isArray(m.modelOptions) && m.modelOptions.length > 0 ? { modelOptions: m.modelOptions } : {}),
            }];
        });

    const withDefault: ModelOption[] = [
        { value: 'default', label: getModelLabel('default'), description: '' },
        ...dynamic.filter((m) => m.value !== 'default'),
    ];

    return dedupeModelOptionsByValue(withDefault);
}

export function hasDynamicModelListForSession(agentType: AgentType, metadata: Metadata | null | undefined): boolean {
    if (!supportsDynamicSessionModelList(agentType)) {
        return false;
    }
    const state = readSessionModelListState(metadata);
    return Boolean(
        state &&
        state.agentId === agentType &&
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
            return t('agentInput.model.useCliSettings');
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

function getStaticModelOptionsForAgentType(agentType: AgentType): readonly ModelOption[] {
    const seen = new Set<string>(['default']);
    const out: ModelOption[] = [
        { value: 'default', label: getModelLabel('default'), description: '' },
    ];

    for (const model of getAgentStaticModels(agentType)) {
        const value = typeof model.id === 'string' ? model.id.trim() : '';
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push({
            value,
            label: model.name,
            description: typeof model.description === 'string' ? model.description : '',
            ...(readExtendedContextModelId(model.extendedContextModelId)
                ? { extendedContextModelId: readExtendedContextModelId(model.extendedContextModelId) }
                : {}),
            ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0 ? { modelOptions: model.modelOptions } : {}),
        });
    }

    return out;
}

export function getModelOptionsForAgentType(agentType: AgentType): readonly ModelOption[] {
    const core = getAgentCore(agentType);
    if (core.model.supportsSelection !== true) return [];
    return getStaticModelOptionsForAgentType(agentType);
}

export function getModelOptionsForAgentTypeOrPreflight(params: {
    agentType: AgentType;
    preflight: PreflightModelList | null | undefined;
    preflightTargetKey?: string | null;
    currentTargetKey?: string | null;
}): readonly ModelOption[] {
    if (!isPreflightListCurrentForTarget(params)) {
        return getModelOptionsForAgentType(params.agentType);
    }
    if (params.preflight?.unavailable === true) {
        return [];
    }
    if (params.preflight && Array.isArray(params.preflight.availableModels) && params.preflight.availableModels.length > 0) {
        const preflightOptions = getModelOptionsForPreflightModelList(params.preflight);
        const catalogOptions = getModelOptionsForAgentType(params.agentType);
        return mergeModelOptionsWithCatalog({
            options: preflightOptions,
            catalogOptions,
            appendMissingCatalogOptions: params.preflight.supportsFreeform === true,
        });
    }
    return getModelOptionsForAgentType(params.agentType);
}

function resolveModelOptionsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly ModelOption[] {
    const modelConfig = getAgentCore(agentType).model;
    const supportsFreeform = supportsFreeformModelSelectionForSession(agentType, metadata);
    const selectedModelId = readSelectedModelOverrideId(agentType, metadata);
    const state = supportsDynamicSessionModelList(agentType) ? readSessionModelListState(metadata) : null;
    if (state && state.agentId === agentType && Array.isArray(state.availableModels) && state.availableModels.length > 0) {
        const catalogOptions = getModelOptionsForAgentType(agentType);

        const dynamic = state.availableModels
            .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
            .map((m) => {
                const value = String(m.id);
                const description = typeof m.description === 'string' ? m.description : '';
                const modelOptionsRaw = Array.isArray(m.modelOptions) && m.modelOptions.length > 0
                    ? (m.modelOptions as readonly AcpConfigOption[])
                    : null;

                return {
                    value,
                    label: String(m.name),
                    description,
                    ...(readExtendedContextModelId(m.extendedContextModelId)
                        ? { extendedContextModelId: readExtendedContextModelId(m.extendedContextModelId) }
                        : {}),
                    ...(modelOptionsRaw ? { modelOptions: modelOptionsRaw } : {}),
                };
            });

        return appendSelectedFreeformModelOption({
            options: mergeModelOptionsWithCatalog({
                options: [
                    { value: 'default', label: getModelLabel('default'), description: '' },
                    ...dynamic.filter((m) => m.value !== 'default'),
                ],
                catalogOptions,
                appendMissingCatalogOptions: supportsFreeform,
            }),
            selectedModelId,
            modelConfig,
        });
    }

    const base = getModelOptionsForAgentType(agentType);
    if (base.length === 0) return base;
    return appendSelectedFreeformModelOption({
        options: base,
        selectedModelId,
        modelConfig,
    });
}

export function getSelectableModelIdsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly string[] {
    return resolveModelOptionsForSession(agentType, metadata).map((option) => option.value);
}

export function isModelSelectableForSession(agentType: AgentType, metadata: Metadata | null | undefined, modelId: string): boolean {
    const normalized = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalized) return false;

    const allowed = getSelectableModelIdsForSession(agentType, metadata);
    if ((allowed as readonly string[]).includes(normalized)) return true;
    return isFreeformModelIdAllowed(getAgentCore(agentType).model, normalized);
}

export function getModelOptionsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly ModelOption[] {
    return resolveModelOptionsForSession(agentType, metadata);
}

/**
 * Finds the option matching either its base id or the exact extended-context id
 * declared by that descriptor. Undeclared bracket suffixes are intentionally not
 * treated as model aliases.
 */
export function findModelOptionForEffectiveModelId<T extends Readonly<{
    value: string;
    extendedContextModelId?: string;
}>>(
    options: readonly T[],
    effectiveModelId: string | null | undefined,
): T | null {
    const raw = typeof effectiveModelId === 'string' ? effectiveModelId.trim() : '';
    if (!raw) return null;
    const exact = options.find((option) => option.value === raw);
    if (exact) return exact;
    return options.find((option) => option.extendedContextModelId === raw) ?? null;
}
