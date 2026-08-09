import type { ModelMode } from '../permissions/permissionTypes';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '../state/storageTypes';
import type { SessionConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import {
    getAgentStaticModels,
} from '@happier-dev/agents';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';

export type AgentType = AgentId;

export type ModelOption = Readonly<{
    value: ModelMode;
    label: string;
    description: string;
    /**
     * Catalog-declared extended-context variant id (e.g. `claude-sonnet-4-6[1m]`).
     * Present only when the larger context window is opt-in for this model; the model card
     * surfaces it as a "1M context" toggle that switches the effective model id between
     * `value` and this variant through the regular model-override pipeline.
     */
    extendedContextModelId?: string;
    modelOptions?: readonly SessionConfigOption[];
}>;

/**
 * Resolve the option that owns an effective model id, treating an extended-context variant
 * id (e.g. `claude-sonnet-4-6[1m]`) as its base option so model-scoped controls stay visible
 * while the variant is selected.
 */
export function findModelOptionForEffectiveModelId(
    options: readonly ModelOption[],
    effectiveModelId: string,
): ModelOption | null {
    return (
        options.find((option) => option.value === effectiveModelId)
        ?? options.find((option) => option.extendedContextModelId === effectiveModelId)
        ?? null
    );
}

export type PreflightModelList = Readonly<{
    availableModels: ReadonlyArray<Readonly<{
        id: string;
        name: string;
        description?: string;
        contextWindowTokens?: number;
        extendedContextModelId?: string;
        modelOptions?: readonly SessionConfigOption[];
    }>>;
    supportsFreeform: boolean;
}>;

type SessionModelListState = Readonly<{
    provider?: string;
    availableModels?: Array<{
        id?: unknown;
        name?: unknown;
        description?: unknown;
        extendedContextModelId?: unknown;
        modelOptions?: unknown;
    }>;
}>;

/**
 * Normalize a catalog- or session-declared extended-context variant id.
 *
 * One owner for the rule, because the value now flows through the preflight parse, the probe cache,
 * and both dynamic row builders — four places that must agree on what counts as present.
 */
export function readExtendedContextModelId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function dedupeModelOptionsByValue(options: readonly ModelOption[]): readonly ModelOption[] {
    const seen = new Set<string>();
    return options.filter((option) => {
        if (seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
    });
}

function mergeDynamicModelOptionWithCatalog(
    option: ModelOption,
    catalogByValue: ReadonlyMap<string, ModelOption>,
): ModelOption {
    const catalog = catalogByValue.get(option.value) ?? null;
    if (!catalog) return option;
    const hasModelOptions = Array.isArray(option.modelOptions) && option.modelOptions.length > 0;
    const hasDescription = typeof option.description === 'string' && option.description.trim().length > 0;
    const hasExtendedContext = typeof option.extendedContextModelId === 'string'
        && option.extendedContextModelId.trim().length > 0;
    return {
        ...option,
        ...(!hasDescription && catalog.description ? { description: catalog.description } : {}),
        ...(!hasModelOptions && catalog.modelOptions ? { modelOptions: catalog.modelOptions } : {}),
        // Without this a curated model arriving through the dynamic path loses its extended-context
        // variant, and the 1M toggle disappears for a model that still supports it.
        ...(!hasExtendedContext && catalog.extendedContextModelId
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
    supportsFreeform: boolean;
}>): readonly ModelOption[] {
    if (!params.supportsFreeform) return params.options;
    if (!params.selectedModelId) return params.options;
    if (params.options.some((option) => option.value === params.selectedModelId)) return params.options;
    return [
        ...params.options,
        { value: params.selectedModelId, label: params.selectedModelId, description: '' },
    ];
}

function readSessionModelListState(metadata: Metadata | null | undefined): SessionModelListState | null {
    return readSessionModelsState(metadata);
}

function readSelectedModelOverrideId(metadata: Metadata | null | undefined): string {
    const metadataModelOverrideRaw = (metadata as any)?.modelOverrideV1 as { modelId?: unknown } | undefined;
    return readNonBlankSessionControlIdentifier(metadataModelOverrideRaw?.modelId) ?? '';
}

function supportsDynamicSessionModelList(agentType: AgentType): boolean {
    return getAgentCore(agentType).model.dynamicProbe !== 'static-only';
}

export function getModelOptionsForPreflightModelList(list: PreflightModelList): readonly ModelOption[] {
    const dynamic = (list.availableModels ?? [])
        .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
        .map((m) => ({
            value: String(m.id),
            label: String(m.name),
            description: typeof m.description === 'string' ? m.description : '',
            ...(readExtendedContextModelId(m.extendedContextModelId)
                ? { extendedContextModelId: readExtendedContextModelId(m.extendedContextModelId) }
                : {}),
            ...(Array.isArray(m.modelOptions) && m.modelOptions.length > 0 ? { modelOptions: m.modelOptions } : {}),
        }));

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
            ...(typeof model.extendedContextModelId === 'string' && model.extendedContextModelId.trim()
                ? { extendedContextModelId: model.extendedContextModelId.trim() }
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
}): readonly ModelOption[] {
    if (params.preflight && Array.isArray(params.preflight.availableModels) && params.preflight.availableModels.length > 0) {
        const preflightOptions = getModelOptionsForPreflightModelList(params.preflight);
        const catalogOptions = getModelOptionsForAgentType(params.agentType);
        return mergeModelOptionsWithCatalog({
            options: preflightOptions,
            catalogOptions,
            appendMissingCatalogOptions: true,
        });
    }
    return getModelOptionsForAgentType(params.agentType);
}

function resolveModelOptionsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly ModelOption[] {
    const supportsFreeform = supportsFreeformModelSelectionForSession(agentType, metadata);
    const selectedModelId = readSelectedModelOverrideId(metadata);
    const state = supportsDynamicSessionModelList(agentType) ? readSessionModelListState(metadata) : null;
    if (state && state.provider === agentType && Array.isArray(state.availableModels) && state.availableModels.length > 0) {
        const catalogOptions = getModelOptionsForAgentType(agentType);

        const dynamic = state.availableModels
            .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
            .map((m) => {
                const value = String(m.id);
                const description = typeof m.description === 'string' ? m.description : '';
                const modelOptionsRaw = Array.isArray(m.modelOptions) && m.modelOptions.length > 0
                    ? (m.modelOptions as readonly SessionConfigOption[])
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
            supportsFreeform,
        });
    }

    const base = getModelOptionsForAgentType(agentType);
    if (base.length === 0) return base;
    return appendSelectedFreeformModelOption({
        options: base,
        selectedModelId,
        supportsFreeform,
    });
}

export function getSelectableModelIdsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly string[] {
    return resolveModelOptionsForSession(agentType, metadata).map((option) => option.value);
}

export function isModelSelectableForSession(agentType: AgentType, metadata: Metadata | null | undefined, modelId: string): boolean {
    const normalized = readNonBlankSessionControlIdentifier(modelId) ?? '';
    if (!normalized) return false;

    const allowed = getSelectableModelIdsForSession(agentType, metadata);
    if ((allowed as readonly string[]).includes(normalized)) return true;
    return supportsFreeformModelSelectionForSession(agentType, metadata);
}

export function getModelOptionsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly ModelOption[] {
    return resolveModelOptionsForSession(agentType, metadata);
}
