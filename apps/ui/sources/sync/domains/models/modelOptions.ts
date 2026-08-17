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
export function findModelOptionForEffectiveModelId<Option extends Readonly<{
    value: string;
    extendedContextModelId?: string;
}>>(
    options: readonly Option[],
    effectiveModelId: string,
): Option | null {
    const directMatch = (
        options.find((option) => option.value === effectiveModelId)
        ?? options.find((option) => option.extendedContextModelId === effectiveModelId)
        ?? null
    );
    if (directMatch) return directMatch;

    // Some runtimes accept an unqualified model id while advertising the canonical
    // provider-qualified identity (for example `gpt-5.6-luna` versus
    // `openai-codex/gpt-5.6-luna`). Resolve that shorthand only when exactly one
    // option owns it. Ambiguous and genuinely custom ids must remain freeform values.
    if (!effectiveModelId || effectiveModelId.includes('/')) return null;
    let matched: Option | null = null;
    for (const option of options) {
        const separatorIndex = option.value.indexOf('/');
        if (separatorIndex <= 0 || separatorIndex === option.value.length - 1) continue;
        if (option.value.slice(separatorIndex + 1) !== effectiveModelId) continue;
        if (matched) return null;
        matched = option;
    }
    return matched;
}

/**
 * Return the advertised identity for a uniquely resolved unqualified model alias.
 * Exact ids and extended-context variants retain their original identity.
 */
export function resolveCanonicalModelOptionId(
    options: readonly Readonly<{ value: string; extendedContextModelId?: string }>[],
    selectedModelId: string,
): string {
    const option = findModelOptionForEffectiveModelId(options, selectedModelId);
    if (!option) return selectedModelId;
    if (option.value === selectedModelId || option.extendedContextModelId === selectedModelId) {
        return selectedModelId;
    }
    return option.value;
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

type DynamicModelRowInput = Readonly<{
    id: unknown;
    name: unknown;
    description?: unknown;
    contextWindowTokens?: unknown;
    extendedContextModelId?: unknown;
    modelOptions?: unknown;
}>;

type SessionModelListState = Readonly<{
    provider?: string;
    availableModels?: DynamicModelRowInput[];
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

function projectDynamicModelRows(rows: readonly DynamicModelRowInput[]): ModelOption[] {
    return rows.flatMap((row) => {
        if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') return [];
        const extendedContextModelId = readExtendedContextModelId(row.extendedContextModelId);
        const modelOptions = Array.isArray(row.modelOptions) && row.modelOptions.length > 0
            ? row.modelOptions as readonly SessionConfigOption[]
            : null;
        return [{
            value: String(row.id),
            label: String(row.name),
            description: typeof row.description === 'string' ? row.description : '',
            ...(extendedContextModelId ? { extendedContextModelId } : {}),
            ...(modelOptions ? { modelOptions } : {}),
        }];
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

/**
 * Two rows that read identically are not a choice.
 *
 * A dynamic catalog advertises pinned snapshot ids (`claude-opus-4-5-20251101`) under the same
 * curated name as their floating alias (`claude-opus-4-5`), and the alias is offered too — either
 * because the source lists both or because the static catalog contributes the one the probe
 * omitted. The result is rows with the same label and the same blurb selecting different models,
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
    appendMissingCatalogOptions: boolean;
}>): readonly ModelOption[] {
    const catalogByValue = new Map(params.catalogOptions.map((option) => [option.value, option] as const));
    const merged = dedupeModelOptionsByValue(params.options.map((option) => mergeDynamicModelOptionWithCatalog(option, catalogByValue)));

    if (!params.appendMissingCatalogOptions) return nameCollidingModelOptionsByModelId(merged);

    const seen = new Set(merged.map((option) => option.value));
    return nameCollidingModelOptionsByModelId([
        ...merged,
        ...params.catalogOptions.filter((option) => {
            if (seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
        }),
    ]);
}

function appendSelectedFreeformModelOption(params: Readonly<{
    options: readonly ModelOption[];
    selectedModelId: string;
    supportsFreeform: boolean;
}>): readonly ModelOption[] {
    if (!params.supportsFreeform) return params.options;
    if (!params.selectedModelId) return params.options;
    if (findModelOptionForEffectiveModelId(params.options, params.selectedModelId)) return params.options;
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
    const dynamic = projectDynamicModelRows(list.availableModels ?? []);

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

        const dynamic = projectDynamicModelRows(state.availableModels);

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

    const options = resolveModelOptionsForSession(agentType, metadata);
    if (findModelOptionForEffectiveModelId(options, normalized)) return true;
    return supportsFreeformModelSelectionForSession(agentType, metadata);
}

export function getModelOptionsForSession(agentType: AgentType, metadata: Metadata | null | undefined): readonly ModelOption[] {
    return resolveModelOptionsForSession(agentType, metadata);
}
