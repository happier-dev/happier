import type { JsonValue } from '@happier-dev/plugin-sdk';

import { isCodexAppServerFastServiceTier } from '../serviceTier.js';
import {
    CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID,
    CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID,
} from './configOptionIds.js';

type JsonRpcClient = Readonly<{
    request: (method: string, params?: JsonValue) => Promise<unknown>;
}>;

type MetadataRecord = Record<string, unknown>;

type SessionControlOption = {
    id: string;
    name: string;
    description?: string;
};

type SessionConfigOptionValue = string | number | boolean | null;

type SessionConfigOption = {
    id: string;
    name: string;
    description?: string;
    type: string;
    currentValue: SessionConfigOptionValue;
    options?: Array<{ value: SessionConfigOptionValue; name: string; description?: string }>;
};

type SessionModelOption = SessionControlOption & Readonly<{
    modelOptions?: SessionConfigOption[];
}>;

export type CodexAppServerSessionControlsSnapshot = Readonly<{
    availableModes: SessionControlOption[];
    currentModeId: string | null;
    availableModels: SessionModelOption[];
    currentModelId: string | null;
    configOptions: SessionConfigOption[];
}>;

type CollaborationModeSelection = Readonly<{
    modeId: string;
    payload: Readonly<{
        mode: string;
        settings: Readonly<{
            model: string;
            reasoning_effort: string | null;
            developer_instructions: null;
        }>;
    }>;
}>;

type CollaborationModeMask = SessionControlOption & Readonly<{
    mode: string;
    model: string | null;
    reasoningEffort: string | null;
}>;

type ModelMask = SessionModelOption & Readonly<{
    isDefault: boolean;
}>;

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeCodexModelDisplayName(value: string): string {
    const normalizedSeparators = value.replace(/[_-]+/g, ' ').trim();
    if (!normalizedSeparators) return value;

    return normalizedSeparators
        .split(/\s+/)
        .map((token) => {
            if (/^gpt$/i.test(token)) return 'GPT';
            if (/^[a-z]+$/.test(token)) {
                return token.charAt(0).toUpperCase() + token.slice(1);
            }
            return token;
        })
        .join(' ');
}

function asRecord(value: unknown): MetadataRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as MetadataRecord;
}

function readListEntries(value: unknown): unknown[] {
    let current: unknown = value;
    for (let depth = 0; depth < 3; depth += 1) {
        if (Array.isArray(current)) return current;
        const record = asRecord(current);
        if (!record) return [];
        if (Array.isArray(record.items)) return record.items;
        if (Array.isArray(record.data)) return record.data;
        if (record.result === undefined) return [];
        current = record.result;
    }
    return [];
}

function normalizeReasoningEffortLabel(value: string): string {
    switch (value) {
        case 'low':
            return 'Low';
        case 'medium':
            return 'Medium';
        case 'high':
            return 'High';
        case 'xhigh':
            return 'XHigh';
        case 'max':
            return 'Max';
        default:
            return value;
    }
}

type ReasoningEffortChoice = Readonly<{
    value: string;
    description?: string;
}>;

type SpeedTierChoice = Readonly<{
    value: string;
    name?: string;
    description?: string;
}>;

function normalizeReasoningEffortChoices(value: unknown): ReasoningEffortChoice[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => {
            const stringValue = normalizeString(entry);
            if (stringValue) {
                return { value: stringValue } satisfies ReasoningEffortChoice;
            }
            const record = asRecord(entry);
            if (!record) return null;
            const reasoningEffort = normalizeString(record.reasoningEffort)
                ?? normalizeString(record.reasoning_effort)
                ?? normalizeString(record.value)
                ?? normalizeString(record.id);
            if (!reasoningEffort) return null;
            const description = normalizeString(record.description);
            return {
                value: reasoningEffort,
                ...(description ? { description } : {}),
            } satisfies ReasoningEffortChoice;
        })
        .filter((entry): entry is ReasoningEffortChoice => entry !== null);
}

function buildReasoningEffortModelOption(params: Readonly<{
    modelId: string;
    record: MetadataRecord;
    currentModelId: string | null;
    currentReasoningEffort?: string | null;
}>): SessionConfigOption | null {
    const supportedReasoningEffortsRaw =
        params.record.supportedReasoningEfforts
        ?? params.record.supported_reasoning_efforts
        ?? params.record.supported_reasoning_effort;
    const values = normalizeReasoningEffortChoices(supportedReasoningEffortsRaw);
    if (values.length === 0) return null;
    const defaultReasoningEffortRaw =
        params.record.defaultReasoningEffort
        ?? params.record.default_reasoning_effort;
    const defaultValue = normalizeString(defaultReasoningEffortRaw) ?? values[0]?.value ?? null;
    if (!defaultValue) return null;
    const currentValue = params.modelId === params.currentModelId
        ? (params.currentReasoningEffort ?? defaultValue)
        : defaultValue;
    return {
        id: CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID,
        name: 'Thinking',
        type: 'select',
        currentValue,
        options: values.map((value) => ({
            value: value.value,
            name: normalizeReasoningEffortLabel(value.value),
            ...(value.description ? { description: value.description } : {}),
        })),
    };
}

function normalizeSpeedTierLabel(value: string): string {
    switch (value) {
        case 'fast':
            return 'Fast';
        case 'standard':
            return 'Standard';
        default:
            return value;
    }
}

function normalizeSpeedTierDetails(value: unknown): SpeedTierChoice[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): SpeedTierChoice[] => {
        const stringValue = normalizeString(entry);
        if (stringValue) {
            return [{ value: stringValue, name: normalizeSpeedTierLabel(stringValue) }];
        }
        const record = asRecord(entry);
        if (!record) return [];
        const valueId = normalizeString(record.value)
            ?? normalizeString(record.id)
            ?? normalizeString(record.tier)
            ?? normalizeString(record.serviceTier)
            ?? normalizeString(record.service_tier);
        const name = normalizeString(record.name) ?? normalizeString(record.label);
        if (!valueId && !name) return [];
        const value = valueId ?? name!;
        const description = normalizeString(record.description);
        return [{
            value,
            ...(name ? { name } : {}),
            ...(description ? { description } : {}),
        }];
    });
}

function normalizeAdditionalSpeedTierValues(value: unknown): string[] {
    return normalizeSpeedTierDetails(value)
        .map((entry) => normalizeString(entry.value))
        .filter((entry): entry is string => entry !== null);
}

function readProviderDeclaredSpeedTierChoice(record: MetadataRecord): SpeedTierChoice | null {
    const additionalSpeedTiers = normalizeAdditionalSpeedTierValues(
        record.additionalSpeedTiers ?? record.additional_speed_tiers,
    );
    const declaresFast = additionalSpeedTiers.some(isCodexAppServerFastServiceTier);
    const serviceTierDetails = normalizeSpeedTierDetails(record.serviceTiers ?? record.service_tiers);
    const fastDetail = serviceTierDetails.find((entry) => isCodexAppServerFastServiceTier(entry.value))
        ?? (declaresFast && serviceTierDetails.length === 1 ? serviceTierDetails[0] : null);

    if (!declaresFast && !fastDetail) return null;
    return {
        value: 'fast',
        name: fastDetail?.name ?? normalizeSpeedTierLabel('fast'),
        ...(fastDetail?.description ? { description: fastDetail.description } : {}),
    };
}

function buildSpeedModelOption(params: Readonly<{
    modelId: string;
    record: MetadataRecord;
    currentModelId: string | null;
    currentServiceTier?: string | null;
}>): SessionConfigOption | null {
    const speedChoice = readProviderDeclaredSpeedTierChoice(params.record);
    if (!speedChoice) return null;
    return {
        id: CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID,
        name: 'Speed',
        type: 'select',
        currentValue: params.modelId === params.currentModelId
            ? (isCodexAppServerFastServiceTier(params.currentServiceTier) ? 'fast' : 'standard')
            : 'standard',
        options: [
            { value: 'standard', name: 'Standard' },
            {
                value: 'fast',
                name: speedChoice.name ?? normalizeSpeedTierLabel(speedChoice.value),
                ...(speedChoice.description ? { description: speedChoice.description } : {}),
            },
        ],
    };
}

function normalizeSessionModelMasks(params: Readonly<{
    value: unknown;
    currentModelId: string | null;
    currentReasoningEffort?: string | null;
    currentServiceTier?: string | null;
}>): ModelMask[] {
    const out: ModelMask[] = [];
    for (const entry of readListEntries(params.value)) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = normalizeString(record.id) ?? normalizeString(record.slug);
        const rawName = normalizeString(record.displayName) ?? normalizeString(record.name) ?? normalizeString(record.label) ?? id;
        const name = rawName ? normalizeCodexModelDisplayName(rawName) : null;
        if (!id || !name) continue;
        const description = normalizeString(record.description)
            ?? (() => {
                const reasoningEffort = normalizeString(record.reasoning_effort);
                return reasoningEffort ? `Reasoning effort: ${reasoningEffort}` : null;
            })();
        const reasoningOption = buildReasoningEffortModelOption({
            modelId: id,
            record,
            currentModelId: params.currentModelId,
            currentReasoningEffort: params.currentReasoningEffort,
        });
        const speedOption = buildSpeedModelOption({
            modelId: id,
            record,
            currentModelId: params.currentModelId,
            currentServiceTier: params.currentServiceTier,
        });
        const modelOptions = [reasoningOption, speedOption]
            .filter((option): option is SessionConfigOption => option !== null);
        out.push({
            id,
            name,
            ...(description ? { description } : {}),
            ...(modelOptions.length > 0 ? { modelOptions } : {}),
            isDefault: record.default === true || record.isDefault === true || record.selected === true || record.current === true,
        });
    }
    return out;
}

function normalizeCollaborationModeMasks(value: unknown): CollaborationModeMask[] {
    const out: CollaborationModeMask[] = [];
    for (const entry of readListEntries(value)) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = normalizeString(record.id) ?? normalizeString(record.slug) ?? normalizeString(record.mode);
        const mode = normalizeString(record.mode) ?? id;
        const name = normalizeString(record.displayName) ?? normalizeString(record.name) ?? normalizeString(record.label) ?? id;
        if (!id || !mode || !name) continue;
        const description = normalizeString(record.description)
            ?? (mode === 'plan' || id === 'plan' ? 'Think first' : null);
        out.push({
            id,
            mode,
            name,
            model: normalizeString(record.model),
            reasoningEffort: normalizeString(record.reasoning_effort),
            ...(description ? { description } : {}),
        });
    }
    return out;
}

function resolveCurrentId(
    value: unknown,
    options: readonly SessionControlOption[],
    params?: Readonly<{ fallbackToFirst?: boolean }>,
): string | null {
    for (const entry of readListEntries(value)) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = normalizeString(record.id) ?? normalizeString(record.slug);
        if (!id) continue;
        if (record.default === true || record.isDefault === true || record.selected === true || record.current === true) {
            return id;
        }
    }
    return params?.fallbackToFirst === true ? options[0]?.id ?? null : null;
}

function resolveCodexCurrentCollaborationModeId(
    modesResponse: unknown,
    availableModes: readonly SessionControlOption[],
): string | null {
    if (availableModes.length === 0) return null;
    const explicit = resolveCurrentId(modesResponse, availableModes);
    if (explicit) return explicit;
    const defaultEntry = availableModes.find((entry) => entry.id === 'default');
    if (defaultEntry) return defaultEntry.id;
    return availableModes[0]?.id ?? null;
}

export function resolveCodexAppServerCollaborationModeSelection(params: Readonly<{
    modesResponse: unknown;
    modelsResponse?: unknown;
    modeId: string;
    currentModelId: string | null;
    currentReasoningEffort?: string | null;
}>): CollaborationModeSelection | null {
    const requestedModeId = normalizeString(params.modeId);
    if (!requestedModeId) return null;
    const match = normalizeCollaborationModeMasks(params.modesResponse).find((entry) => entry.id === requestedModeId);
    if (!match) return null;
    const modelMasks = normalizeSessionModelMasks({
        value: params.modelsResponse,
        currentModelId: params.currentModelId,
        currentReasoningEffort: params.currentReasoningEffort,
    });
    const fallbackModelId = modelMasks.find((entry) => entry.isDefault)?.id
        ?? resolveCurrentId(params.modelsResponse, modelMasks, { fallbackToFirst: true });
    const model = match.model ?? params.currentModelId ?? fallbackModelId;
    if (!model) return null;
    return {
        modeId: match.id,
        payload: {
            mode: match.mode,
            settings: {
                model,
                reasoning_effort: params.currentReasoningEffort ?? match.reasoningEffort,
                developer_instructions: null,
            },
        },
    };
}

export async function readCodexAppServerSessionControls(params: Readonly<{
    client: JsonRpcClient;
    authMethod?: string | null;
    currentModeId?: string | null;
    currentModelId?: string | null;
    currentReasoningEffort?: string | null;
    currentServiceTier?: string | null;
}>): Promise<CodexAppServerSessionControlsSnapshot> {
    const [modesSettled, modelsSettled] = await Promise.allSettled([
        params.client.request('collaborationMode/list', {}),
        params.client.request('model/list', {}),
    ]);
    const modesResponse = modesSettled.status === 'fulfilled' ? modesSettled.value : null;
    const modelsResponse = modelsSettled.status === 'fulfilled' ? modelsSettled.value : null;

    const availableModesWithMasks = normalizeCollaborationModeMasks(modesResponse);
    const availableModes = availableModesWithMasks.map(({ id, name, description }) => ({
        id,
        name,
        ...(description ? { description } : {}),
    }));
    const currentModeId = availableModes.some((entry) => entry.id === params.currentModeId)
        ? params.currentModeId ?? null
        : resolveCodexCurrentCollaborationModeId(modesResponse, availableModes);
    const availableModels = normalizeSessionModelMasks({
        value: modelsResponse,
        currentModelId: params.currentModelId ?? null,
        currentReasoningEffort: params.currentReasoningEffort,
        currentServiceTier: params.currentServiceTier,
    }).map(({ isDefault, ...entry }) => entry);
    const currentModelId = availableModels.some((entry) => entry.id === params.currentModelId)
        ? params.currentModelId ?? null
        : resolveCurrentId(modelsResponse, availableModels, { fallbackToFirst: true });

    return {
        availableModes,
        currentModeId,
        availableModels,
        currentModelId,
        configOptions: [],
    };
}
