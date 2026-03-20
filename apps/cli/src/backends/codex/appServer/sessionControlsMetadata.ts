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

type SessionConfigOption = {
    id: string;
    name: string;
    description?: string;
    type: string;
    currentValue: string;
    options?: Array<{ value: string; name: string; description?: string }>;
};

export type CodexAppServerSessionControlsSnapshot = Readonly<{
    availableModes: SessionControlOption[];
    currentModeId: string | null;
    availableModels: SessionControlOption[];
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

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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

function normalizeSessionControlOptions(value: unknown): SessionControlOption[] {
    const out: SessionControlOption[] = [];
    for (const entry of readListEntries(value)) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = normalizeString(record.id) ?? normalizeString(record.slug) ?? normalizeString(record.mode);
        const name = normalizeString(record.displayName) ?? normalizeString(record.name) ?? normalizeString(record.label) ?? id;
        if (!id || !name) continue;
        const description = normalizeString(record.description)
            ?? (() => {
                const reasoningEffort = normalizeString(record.reasoning_effort);
                return reasoningEffort ? `Reasoning effort: ${reasoningEffort}` : null;
            })();
        out.push({ id, name, ...(description ? { description } : {}) });
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

function resolveCurrentId(value: unknown, options: readonly SessionControlOption[]): string | null {
    for (const entry of readListEntries(value)) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = normalizeString(record.id) ?? normalizeString(record.slug);
        if (!id) continue;
        if (record.default === true || record.isDefault === true || record.selected === true || record.current === true) {
            return id;
        }
    }
    return options[0]?.id ?? null;
}

function isSpeedEligible(params: Readonly<{
    authMethod?: string | null;
    currentModelId: string | null;
}>): boolean {
    if (params.currentModelId !== 'gpt-5.4') return false;
    return params.authMethod === 'oauth_cli' || params.authMethod === 'credentials_file';
}

function buildSpeedConfigOptions(params: Readonly<{
    authMethod?: string | null;
    currentModelId: string | null;
    currentServiceTier?: string | null;
}>): SessionConfigOption[] {
    if (!isSpeedEligible(params)) return [];
    return [{
        id: 'speed',
        name: 'Speed',
        type: 'select',
        currentValue: params.currentServiceTier === 'fast' ? 'fast' : 'standard',
        options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
        ],
    }];
}

export function resolveCodexAppServerCollaborationModeSelection(params: Readonly<{
    modesResponse: unknown;
    modeId: string;
    currentModelId: string | null;
}>): CollaborationModeSelection | null {
    const requestedModeId = normalizeString(params.modeId);
    if (!requestedModeId) return null;
    const match = normalizeCollaborationModeMasks(params.modesResponse).find((entry) => entry.id === requestedModeId);
    if (!match) return null;
    const model = match.model ?? params.currentModelId;
    if (!model) return null;
    return {
        modeId: match.id,
        payload: {
            mode: match.mode,
            settings: {
                model,
                reasoning_effort: match.reasoningEffort,
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
    const availableModels = normalizeSessionControlOptions(modelsResponse);
    const currentModelId = availableModels.some((entry) => entry.id === params.currentModelId)
        ? params.currentModelId ?? null
        : resolveCurrentId(modelsResponse, availableModels);
    const configOptions = buildSpeedConfigOptions({
        authMethod: params.authMethod,
        currentModelId,
        currentServiceTier: params.currentServiceTier,
    });

    return {
        availableModes,
        currentModeId,
        availableModels,
        currentModelId,
        configOptions,
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
