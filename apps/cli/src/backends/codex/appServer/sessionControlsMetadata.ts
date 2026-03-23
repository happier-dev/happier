import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';
import type { Metadata } from '@/api/types';

type JsonRpcClient = Readonly<{
    request: (method: string, params?: unknown) => Promise<unknown>;
}>;

type MetadataSession = Readonly<{
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
}>;

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

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readListEntries(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const record = asRecord(value);
    if (!record) return [];
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.data)) return record.data;
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
            return 'Max';
        default:
            return value;
    }
}

type ReasoningEffortChoice = Readonly<{
    value: string;
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
    record: Record<string, unknown>;
    currentModelId: string | null;
    currentReasoningEffort?: string | null;
}>): SessionConfigOption | null {
    const values = normalizeReasoningEffortChoices(params.record.supportedReasoningEfforts);
    if (values.length === 0) return null;
    const defaultValue = normalizeString(params.record.defaultReasoningEffort) ?? values[0]?.value ?? null;
    if (!defaultValue) return null;
    const currentValue = params.modelId === params.currentModelId
        ? (params.currentReasoningEffort ?? defaultValue)
        : defaultValue;
    return {
        id: 'reasoning_effort',
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

function buildSpeedModelOption(params: Readonly<{
    authMethod?: string | null;
    modelId: string;
    currentModelId: string | null;
    currentServiceTier?: string | null;
}>): SessionConfigOption | null {
    if (!isSpeedEligible({ authMethod: params.authMethod, currentModelId: params.modelId })) return null;
    return {
        id: 'speed',
        name: 'Fast',
        type: 'boolean',
        currentValue: params.modelId === params.currentModelId
            ? (params.currentServiceTier === 'fast' ? 'fast' : 'standard')
            : 'standard',
        options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
        ],
    };
}

function normalizeSessionModelMasks(params: Readonly<{
    value: unknown;
    authMethod?: string | null;
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
            authMethod: params.authMethod,
            modelId: id,
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
            ?? (() => {
                const reasoningEffort = normalizeString(record.reasoning_effort);
                return reasoningEffort ? `Reasoning effort: ${reasoningEffort}` : null;
            })();
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

function isSpeedEligible(params: Readonly<{
    authMethod?: string | null;
    currentModelId: string | null;
}>): boolean {
    if (params.currentModelId !== 'gpt-5.4') return false;
    return params.authMethod === 'oauth_cli' || params.authMethod === 'credentials_file';
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
    const [modesResponse, modelsResponse] = await Promise.all([
        params.client.request('collaborationMode/list', {}),
        params.client.request('model/list', {}),
    ]);

    const availableModesWithMasks = normalizeCollaborationModeMasks(modesResponse);
    const availableModes = availableModesWithMasks.map(({ id, name, description }) => ({
        id,
        name,
        ...(description ? { description } : {}),
    }));
    const currentModeId = availableModes.some((entry) => entry.id === params.currentModeId)
        ? params.currentModeId ?? null
        : resolveCurrentId(modesResponse, availableModes);
    const availableModels = normalizeSessionModelMasks({
        value: modelsResponse,
        authMethod: params.authMethod,
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

export async function publishCodexAppServerSessionControlsMetadata(params: Readonly<{
    client: JsonRpcClient;
    session: MetadataSession;
    provider?: string;
    updatedAt?: number;
    authMethod?: string | null;
    currentModeId?: string | null;
    currentModelId?: string | null;
    currentReasoningEffort?: string | null;
    currentServiceTier?: string | null;
}>): Promise<void> {
    const provider = normalizeString(params.provider) ?? 'codex';
    const updatedAt = typeof params.updatedAt === 'number' && Number.isFinite(params.updatedAt)
        ? Math.trunc(params.updatedAt)
        : Date.now();

    const {
        availableModes,
        currentModeId,
        availableModels,
        currentModelId,
        configOptions,
    } = await readCodexAppServerSessionControls({
        client: params.client,
        authMethod: params.authMethod,
        currentModeId: params.currentModeId,
        currentModelId: params.currentModelId,
        currentReasoningEffort: params.currentReasoningEffort,
        currentServiceTier: params.currentServiceTier,
    });

    await Promise.resolve(params.session.updateMetadata((metadata) => ({
        ...metadata,
        ...(availableModes.length > 0 && currentModeId
            ? {
                [SESSION_MODES_STATE_KEY]: {
                    v: 1,
                    provider,
                    updatedAt,
                    currentModeId,
                    availableModes,
                },
            }
            : { [SESSION_MODES_STATE_KEY]: undefined }),
        ...(availableModels.length > 0 && currentModelId
            ? {
                [SESSION_MODELS_STATE_KEY]: {
                    v: 1,
                    provider,
                    updatedAt,
                    currentModelId,
                    availableModels,
                },
            }
            : { [SESSION_MODELS_STATE_KEY]: undefined }),
        [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
            v: 1,
            provider,
            updatedAt,
            configOptions,
        },
    })));
}
