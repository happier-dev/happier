import type { ModelMode } from '../permissions/permissionTypes';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '../state/storageTypes';
import { normalizeSessionConfigOptionsArray, type SessionConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import {
    getAgentStaticModels,
} from '@happier-dev/agents';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';
import { matchesSessionControlProvider, readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';

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
    const hasDescription = typeof option.description === 'string' && option.description.trim().length > 0;
    // The observed catalog owns membership and capabilities. Curated copy can enrich
    // a row, but must not reintroduce controls omitted by the provider/runtime.
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
    const merged = dedupeModelOptionsByValue(params.options.map((option) => mergeDynamicModelOptionWithCatalog(option, catalogByValue)));

    return nameCollidingModelOptionsByModelId(merged);
}

function appendRequestedModelOption(params: Readonly<{
    options: readonly ModelOption[];
    selectedModelId: string;
}>): readonly ModelOption[] {
    if (!params.selectedModelId) return params.options;
    if (findModelOptionForEffectiveModelId(params.options, params.selectedModelId)) return params.options;
    return [
        ...params.options,
        { value: params.selectedModelId, label: params.selectedModelId, description: '' },
    ];
}

function readSelectedModelOverrideId(metadata: Metadata | null | undefined): string {
    return readNonBlankSessionControlIdentifier(metadata?.modelOverrideV1?.modelId) ?? '';
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

function readDynamicSessionModelList(agentType: AgentType, metadata: Metadata | null | undefined) {
    if (!supportsDynamicSessionModelList(agentType)) return null;
    const state = readSessionModelsState(metadata);
    // Current-model telemetry can exist before the first catalog observation. Its
    // producer uses zero until membership/capabilities have actually been observed.
    return state && state.updatedAt > 0
        && matchesSessionControlProvider({ agentId: agentType, metadata, provider: state.provider }) ? state : null;
}

export function hasDynamicModelListForSession(agentType: AgentType, metadata: Metadata | null | undefined): boolean {
    return readDynamicSessionModelList(agentType, metadata) !== null;
}

export function supportsFreeformModelSelectionForSession(
    agentType: AgentType,
    metadata: Metadata | null | undefined,
    context?: SessionModelOptionsContext,
): boolean {
    const core = getAgentCore(agentType);
    return core.model.supportsSelection === true
        && (resolveSessionModelList(agentType, metadata, context)?.supportsFreeform ?? core.model.supportsFreeform === true);
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

/** Discovery belongs to the caller's backend/machine context; runtime metadata owns applied state. */
export type SessionModelOptionsContext = Readonly<{
    preflight?: PreflightModelList | null;
    preflightUpdatedAt?: number | null;
    /** The already requested choice, including local state before its metadata echo. */
    selectedModelId?: string | null;
}>;

function resolveSessionModelList(
    agentType: AgentType,
    metadata: Metadata | null | undefined,
    context?: SessionModelOptionsContext,
): PreflightModelList | null {
    const sessionList = readDynamicSessionModelList(agentType, metadata);
    const preflight = supportsDynamicSessionModelList(agentType) ? context?.preflight : null;
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
            modelOptions: normalizeSessionConfigOptionsArray(model.modelOptions) ?? undefined,
        })),
        supportsFreeform: getAgentCore(agentType).model.supportsFreeform === true,
    } : null;
}

function resolveModelOptionsForSession(
    agentType: AgentType,
    metadata: Metadata | null | undefined,
    context?: SessionModelOptionsContext,
): readonly ModelOption[] {
    const selectedModelId = readNonBlankSessionControlIdentifier(context?.selectedModelId)
        ?? readSelectedModelOverrideId(metadata);
    const options = getModelOptionsForAgentTypeOrPreflight({
        agentType,
        preflight: resolveSessionModelList(agentType, metadata, context),
    });
    if (options.length === 0) return options;
    // Catalog membership determines new choices. An already requested id remains visible
    // independently of discovery, and must not be confused with the runtime's applied id.
    return appendRequestedModelOption({ options, selectedModelId });
}

export function getSelectableModelIdsForSession(agentType: AgentType, metadata: Metadata | null | undefined, context?: SessionModelOptionsContext): readonly string[] {
    return resolveModelOptionsForSession(agentType, metadata, context).map((option) => option.value);
}

export function isModelSelectableForSession(agentType: AgentType, metadata: Metadata | null | undefined, modelId: string, context?: SessionModelOptionsContext): boolean {
    const normalized = readNonBlankSessionControlIdentifier(modelId) ?? '';
    if (!normalized) return false;

    const options = resolveModelOptionsForSession(agentType, metadata, context);
    if (findModelOptionForEffectiveModelId(options, normalized)) return true;
    return supportsFreeformModelSelectionForSession(agentType, metadata, context);
}

export function getModelOptionsForSession(agentType: AgentType, metadata: Metadata | null | undefined, context?: SessionModelOptionsContext): readonly ModelOption[] {
    return resolveModelOptionsForSession(agentType, metadata, context);
}
