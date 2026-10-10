import type { ModelMode } from '../permissions/permissionTypes';
import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol';
import { t } from '@/text';
import { isBundledAgentId } from '@/agents/catalog/catalog';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { normalizeAcpConfigOptionsArray, type AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import {
    getAgentStaticModels,
    getAgentModelConfig,
    isFreeformModelIdAllowed,
} from '@happier-dev/agents';
import { readSessionModelSelectionIntentFromMetadata } from '@/sync/domains/models/readSessionModelSelectionIntent';

/** A session's Agent identity remains open; generated catalog policy narrows explicitly. */
export type AgentType = string;

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
        capabilities?: ProviderModelDescriptorV1['capabilities'];
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

export type SessionModelOptionsContext = Readonly<{
    preflight?: PreflightModelList | null;
    preflightUpdatedAt?: number | null;
    selectedModelId?: string | null;
    preflightTargetKey?: string | null;
    currentTargetKey?: string | null;
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
    const hasDescription = typeof option.description === 'string' && option.description.trim().length > 0;
    // Observed catalogs own membership and capabilities; curated copy only enriches presentation.
    return !hasDescription && catalog.description ? { ...option, description: catalog.description } : option;
}

/**
 * Two rows that read identically are not a choice.
 *
 * A dynamic catalog advertises pinned snapshot ids (`claude-opus-4-5-20251101`) under the same
 * curated name as their floating alias (`claude-opus-4-5`), and the source can advertise both.
 * The result is rows with the same label and the same blurb selecting different models,
 * so the user cannot tell which one they picked.
 *
 * Where a label is contested, the blurb the rows share distinguishes nothing, so it gives way to
 * the one fact that does: the model id being selected. Uncontested rows keep their curated copy.
 */
function nameCollidingModelOptionsByModelId(options: readonly ModelOption[]): readonly ModelOption[] {
    const countByLabel = new Map<string, number>();
    for (const option of options) {
        const label = option.label.trim();
        if (!label) continue;
        countByLabel.set(label, (countByLabel.get(label) ?? 0) + 1);
    }

    let contested = false;
    for (const count of countByLabel.values()) {
        if (count > 1) {
            contested = true;
            break;
        }
    }
    if (!contested) return options;

    return options.map((option) => {
        if ((countByLabel.get(option.label.trim()) ?? 0) < 2) return option;
        if (option.description === option.value) return option;
        return { ...option, description: option.value };
    });
}

function mergeModelOptionsWithCatalog(params: Readonly<{
    options: readonly ModelOption[];
    catalogOptions: readonly ModelOption[];
}>): readonly ModelOption[] {
    const catalogByValue = new Map(params.catalogOptions.map((option) => [option.value, option] as const));
    return nameCollidingModelOptionsByModelId(dedupeModelOptionsByValue(
        params.options.map((option) => mergeDynamicModelOptionWithCatalog(option, catalogByValue)),
    ));
}

function appendRequestedModelOption(options: readonly ModelOption[], selectedModelId: string): readonly ModelOption[] {
    if (!selectedModelId || findModelOptionForEffectiveModelId(options, selectedModelId)) return options;
    return [...options, { value: selectedModelId, label: selectedModelId, description: '' }];
}

function readSelectedModelOverrideId(agentType: AgentType, metadata: ComposerOptionsInputV1 | null | undefined): string {
    const intent = readSessionModelSelectionIntentFromMetadata(
        metadata,
        buildAgentUniverseBackendTargetKey(agentType),
    );
    return typeof intent?.selection?.modelId === 'string' ? intent.selection.modelId.trim() : '';
}

function supportsDynamicSessionModelList(agentType: AgentType): boolean {
    return getAgentModelConfig(agentType)?.dynamicProbe !== 'static-only';
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

function readDynamicSessionModelList(agentType: AgentType, metadata: ComposerOptionsInputV1 | null | undefined) {
    if (!supportsDynamicSessionModelList(agentType)) return null;
    const state = readSessionModelsState(metadata);
    return state && state.agentId === agentType && state.updatedAt > 0 && Array.isArray(state.availableModels)
        ? state
        : null;
}

export function hasDynamicModelListForSession(agentType: AgentType, metadata: ComposerOptionsInputV1 | null | undefined): boolean {
    return readDynamicSessionModelList(agentType, metadata) !== null;
}

function resolveSessionModelList(
    agentType: AgentType,
    metadata: ComposerOptionsInputV1 | null | undefined,
    context?: SessionModelOptionsContext,
): PreflightModelList | null {
    const sessionList = readDynamicSessionModelList(agentType, metadata);
    const preflight = supportsDynamicSessionModelList(agentType)
        && isPreflightListCurrentForTarget(context ?? {})
        && context?.preflight?.unavailable !== true ? context?.preflight : null;
    const preflightUpdatedAt = context?.preflightUpdatedAt;
    const sessionListIsNewer = sessionList && (
        typeof preflightUpdatedAt !== 'number'
        || !Number.isFinite(preflightUpdatedAt)
        || sessionList.updatedAt > preflightUpdatedAt
    );
    if (preflight && !sessionListIsNewer) return preflight;
    return sessionList ? {
        availableModels: sessionList.availableModels.map((model) => ({
            ...model,
            modelOptions: normalizeAcpConfigOptionsArray(model.modelOptions) ?? undefined,
        })),
        supportsFreeform: getAgentModelConfig(agentType)?.supportsFreeform === true,
    } : null;
}

export function supportsFreeformModelSelectionForSession(
    agentType: AgentType,
    metadata: ComposerOptionsInputV1 | null | undefined,
    context?: SessionModelOptionsContext,
): boolean {
    const modelConfig = getAgentModelConfig(agentType);
    if (modelConfig?.supportsSelection === false) return false;
    return resolveSessionModelList(agentType, metadata, context)?.supportsFreeform
        ?? modelConfig?.supportsFreeform === true;
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
    if (!isBundledAgentId(agentType)) return [];
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
    if (!isBundledAgentId(agentType)) return [];
    if (getAgentModelConfig(agentType)?.supportsSelection === false) return [];
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
        // Discovery cannot authoritatively withdraw catalog models. Preserve trusted
        // static/default choices while the caller presents the degraded probe state.
        return getModelOptionsForAgentType(params.agentType);
    }
    if (params.preflight && Array.isArray(params.preflight.availableModels)) {
        const preflightOptions = getModelOptionsForPreflightModelList(params.preflight);
        const catalogOptions = getModelOptionsForAgentType(params.agentType);
        return mergeModelOptionsWithCatalog({
            options: preflightOptions,
            catalogOptions,
        });
    }
    return getModelOptionsForAgentType(params.agentType);
}

function resolveModelOptionsForSession(
    agentType: AgentType,
    metadata: ComposerOptionsInputV1 | null | undefined,
    context?: SessionModelOptionsContext,
): readonly ModelOption[] {
    const list = resolveSessionModelList(agentType, metadata, context);
    const options = getModelOptionsForAgentTypeOrPreflight({ agentType, preflight: list });
    if (options.length === 0) return options;
    const selectedModelId = context?.selectedModelId?.trim() || readSelectedModelOverrideId(agentType, metadata);
    return appendRequestedModelOption(options, selectedModelId);
}

export function getSelectableModelIdsForSession(agentType: AgentType, metadata: ComposerOptionsInputV1 | null | undefined, context?: SessionModelOptionsContext): readonly string[] {
    return resolveModelOptionsForSession(agentType, metadata, context).map((option) => option.value);
}

export function isModelSelectableForSession(agentType: AgentType, metadata: ComposerOptionsInputV1 | null | undefined, modelId: string, context?: SessionModelOptionsContext): boolean {
    const normalized = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalized) return false;
    const options = resolveModelOptionsForSession(agentType, metadata, context);
    if (findModelOptionForEffectiveModelId(options, normalized)) return true;
    if (!supportsFreeformModelSelectionForSession(agentType, metadata, context)) return false;
    const modelConfig = getAgentModelConfig(agentType);
    return modelConfig ? isFreeformModelIdAllowed(modelConfig, normalized) : true;
}

export function getModelOptionsForSession(agentType: AgentType, metadata: ComposerOptionsInputV1 | null | undefined, context?: SessionModelOptionsContext): readonly ModelOption[] {
    return resolveModelOptionsForSession(agentType, metadata, context);
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
    const extendedContext = options.find((option) => option.extendedContextModelId === raw);
    if (extendedContext) return extendedContext;

    // Pi accepts unqualified model ids, while its model probe advertises the
    // canonical provider-qualified id. Only collapse that shorthand when the
    // advertised options prove that the suffix has exactly one owner.
    if (raw.includes('/')) return null;
    let qualifiedMatch: T | null = null;
    for (const option of options) {
        const separatorIndex = option.value.indexOf('/');
        if (separatorIndex <= 0 || option.value.slice(separatorIndex + 1) !== raw) continue;
        if (qualifiedMatch) return null;
        qualifiedMatch = option;
    }
    return qualifiedMatch;
}

export function resolveCanonicalModelOptionId<T extends Readonly<{
    value: string;
    extendedContextModelId?: string;
}>>(
    options: readonly T[],
    effectiveModelId: string | null | undefined,
): string {
    const raw = typeof effectiveModelId === 'string' ? effectiveModelId.trim() : '';
    if (!raw) return raw;
    const matched = findModelOptionForEffectiveModelId(options, raw);
    if (!matched || matched.value === raw || matched.extendedContextModelId === raw) return raw;
    return matched.value;
}

type NativeModelSelectionRefLike = Readonly<{
    providerConnectionId: string | null;
    modelId: string;
}>;

export function resolveCanonicalNativeModelSelectionRef<Ref extends NativeModelSelectionRefLike>(
    options: readonly Readonly<{ value: string; extendedContextModelId?: string }>[],
    ref: Ref,
): Ref;
export function resolveCanonicalNativeModelSelectionRef(
    options: readonly Readonly<{ value: string; extendedContextModelId?: string }>[],
    ref: null,
): null;
export function resolveCanonicalNativeModelSelectionRef<Ref extends NativeModelSelectionRefLike>(
    options: readonly Readonly<{ value: string; extendedContextModelId?: string }>[],
    ref: Ref | null,
): Ref | null;
export function resolveCanonicalNativeModelSelectionRef<Ref extends NativeModelSelectionRefLike>(
    options: readonly Readonly<{ value: string; extendedContextModelId?: string }>[],
    ref: Ref | null,
): Ref | null {
    if (!ref || ref.providerConnectionId !== null) return ref;
    const modelId = resolveCanonicalModelOptionId(options, ref.modelId);
    return modelId === ref.modelId ? ref : { ...ref, modelId };
}
