import type { Metadata } from '@/api/types';
import { normalizeContextWindowTokens } from '@/backends/modelCapabilities/contextWindowTokens';
import {
    providers,
    readNewestSessionModelsMetadataStateV1,
} from '@happier-dev/agents';

import { reconcileClaudeSessionModelsState } from '../sessionModels/reconcileClaudeSessionModelsState';

type SessionModelsState = NonNullable<Metadata['sessionModelsV1']>;
type SessionModelEntry = SessionModelsState['availableModels'][number];
type SessionModelOption = NonNullable<SessionModelEntry['modelOptions']>[number];
const CLAUDE_1M_CONTEXT_WINDOW_TOKENS = 1_000_000;

function normalizeNonEmptyString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeValue(value: unknown): string | number | boolean | null {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return value;
    }
    return null;
}

function normalizeModelOption(raw: unknown): SessionModelOption | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const type = typeof record.type === 'string' ? record.type.trim() : '';
    if (!id || !name || !type) return null;

    const currentValue = normalizeValue(record.currentValue);
    const optionsRaw = Array.isArray(record.options) ? record.options : [];
    const options = optionsRaw
        .map((option) => {
            if (!option || typeof option !== 'object') return null;
            const optionRecord = option as Record<string, unknown>;
            const optionName = typeof optionRecord.name === 'string' ? optionRecord.name.trim() : '';
            if (!optionName) return null;
            return {
                value: normalizeValue(optionRecord.value),
                name: optionName,
                ...(typeof optionRecord.description === 'string' && optionRecord.description.trim().length > 0
                    ? { description: optionRecord.description.trim() }
                    : {}),
            };
        })
        .filter((option): option is NonNullable<typeof option> => option !== null);

    return {
        id,
        name,
        type,
        currentValue,
        ...(typeof record.description === 'string' && record.description.trim().length > 0
            ? { description: record.description.trim() }
            : {}),
        ...(options.length > 0 ? { options } : {}),
    };
}

function textSuggestsClaude1m(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized.includes('1 million') || normalized.includes('1m');
}

function normalizeSupportedModel(raw: unknown): SessionModelEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;

    const id = normalizeNonEmptyString(record.id)
        || normalizeNonEmptyString(record.modelId)
        || normalizeNonEmptyString(record.value);
    const rawName = normalizeNonEmptyString(record.name)
        || normalizeNonEmptyString(record.displayName);
    if (!id || !rawName) return null;
    const name = providers.claude.normalizeClaudeModelDisplayName(rawName, id);

    const modelOptionsRaw = Array.isArray(record.modelOptions)
        ? record.modelOptions
        : Array.isArray(record.model_options)
            ? record.model_options
            : [];
    const modelOptions = modelOptionsRaw
        .map((option) => normalizeModelOption(option))
        .filter((option): option is SessionModelOption => option !== null);
    const contextWindowTokens =
        normalizeContextWindowTokens(record.contextWindowTokens)
        ?? normalizeContextWindowTokens(record.context_window_tokens)
        ?? normalizeContextWindowTokens(record.contextWindow)
        ?? normalizeContextWindowTokens(record.context_window)
        ?? ((id.toLowerCase().endsWith('[1m]') || textSuggestsClaude1m(name) || textSuggestsClaude1m(record.description))
            ? CLAUDE_1M_CONTEXT_WINDOW_TOKENS
            : undefined);

    return {
        id,
        name,
        ...(typeof record.description === 'string' && record.description.trim().length > 0
            ? { description: record.description.trim() }
            : {}),
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        ...(modelOptions.length > 0 ? { modelOptions } : {}),
    };
}

function resolveCurrentModelId(metadata: Metadata | null | undefined): string {
    const preferred = normalizeNonEmptyString(metadata?.modelOverrideV1?.modelId);
    if (preferred) return preferred;

    const state = readNewestClaudeSessionModelsState(metadata);
    const current = state?.provider === 'claude'
        ? normalizeNonEmptyString(state.currentModelId)
        : '';
    if (current) return current;

    return 'default';
}

function readNewestClaudeSessionModelsState(metadata: Metadata | null | undefined): SessionModelsState | null {
    return readNewestSessionModelsMetadataStateV1(
        metadata as unknown as Record<string, unknown> | null | undefined,
    ) as SessionModelsState | null;
}

/**
 * Direct facts about the CURRENT model (e.g. from Claude's statusline payload, which carries
 * the authoritative `context_window.context_window_size`). When provided, the matching
 * `availableModels` entry is upserted so window resolution can read it ahead of catalog guesses.
 */
export type ClaudeCurrentModelFacts = Readonly<{
    name?: string | undefined;
    contextWindowTokens?: number | undefined;
}>;

function normalizePositiveTokens(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function findModelEntry(state: SessionModelsState | null, modelId: string): SessionModelEntry | null {
    if (!state || !Array.isArray(state.availableModels)) return null;
    return state.availableModels.find((model) => model.id === modelId) ?? null;
}

function upsertCurrentModelEntry(params: Readonly<{
    availableModels: SessionModelsState['availableModels'];
    currentModelId: string;
    name: string;
    contextWindowTokens: number;
}>): SessionModelsState['availableModels'] {
    const existing = params.availableModels.find((model) => model.id === params.currentModelId);
    if (existing) {
        return params.availableModels.map((model) => (
            model.id === params.currentModelId
                ? { ...model, contextWindowTokens: params.contextWindowTokens }
                : model
        ));
    }
    return [
        ...params.availableModels,
        {
            id: params.currentModelId,
            name: params.name,
            contextWindowTokens: params.contextWindowTokens,
        },
    ];
}

export function buildClaudeSessionModelsMetadataWithCurrentModelId(params: Readonly<{
    currentModelId: unknown;
    metadata: Metadata | null | undefined;
    nowMs?: () => number;
    currentModel?: ClaudeCurrentModelFacts | undefined;
}>): Pick<Metadata, 'sessionModelsV1' | 'acpSessionModelsV1'> | null {
    const currentModelId = normalizeNonEmptyString(params.currentModelId);
    if (!currentModelId) return null;

    const existingState = readNewestClaudeSessionModelsState(params.metadata);
    const existingSessionState = existingState?.provider === 'claude'
        ? existingState
        : null;
    const existingAcpState = existingSessionState;

    const contextWindowTokens = normalizePositiveTokens(params.currentModel?.contextWindowTokens);
    const windowAlreadyReflected = contextWindowTokens === null || (
        findModelEntry(existingSessionState, currentModelId)?.contextWindowTokens === contextWindowTokens
        && findModelEntry(existingAcpState, currentModelId)?.contextWindowTokens === contextWindowTokens
    );

    if (
        existingSessionState?.currentModelId === currentModelId &&
        existingAcpState?.currentModelId === currentModelId &&
        windowAlreadyReflected
    ) {
        return null;
    }

    const updatedAt = params.nowMs ? params.nowMs() : Date.now();
    const currentModelName = providers.claude.normalizeClaudeModelDisplayName(
        params.currentModel?.name,
        currentModelId,
    );

    const buildState = (existing: SessionModelsState | null): SessionModelsState => {
        const base: SessionModelsState = existing
            ? {
                ...existing,
                currentModelId,
                updatedAt,
            }
            : {
                v: 1,
                provider: 'claude',
                updatedAt,
                currentModelId,
                availableModels: [],
            };
        if (contextWindowTokens === null) return base;
        return {
            ...base,
            availableModels: upsertCurrentModelEntry({
                availableModels: Array.isArray(base.availableModels) ? base.availableModels : [],
                currentModelId,
                name: currentModelName,
                contextWindowTokens,
            }),
        };
    };

    return {
        sessionModelsV1: buildState(existingSessionState),
        acpSessionModelsV1: buildState(existingAcpState),
    };
}

export function buildClaudeSessionModelsMetadataFromSupportedModels(params: Readonly<{
    modelsRaw: unknown;
    metadata: Metadata | null | undefined;
    nowMs?: () => number;
}>): Pick<Metadata, 'sessionModelsV1' | 'acpSessionModelsV1'> | null {
    if (!Array.isArray(params.modelsRaw)) return null;

    const availableModels = params.modelsRaw
        .map((model) => normalizeSupportedModel(model))
        .filter((model): model is SessionModelEntry => model !== null);
    if (availableModels.length === 0) return null;

    const updatedAt = params.nowMs ? params.nowMs() : Date.now();
    const currentModelId = resolveCurrentModelId(params.metadata);

    const state = reconcileClaudeSessionModelsState({
      metadata: params.metadata,
      source: 'agent_sdk',
      incomingState: {
        v: 1,
        provider: 'claude',
        updatedAt,
        currentModelId,
        availableModels,
      },
    });

    return {
        sessionModelsV1: state,
        acpSessionModelsV1: state,
    };
}
