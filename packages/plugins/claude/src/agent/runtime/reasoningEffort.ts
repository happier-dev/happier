import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import {
    CLAUDE_EFFORT_LEVELS,
    formatClaudeEffortLevelLabel,
    normalizeClaudeEffortLevel,
    type ClaudeEffortLevel,
} from '@happier-dev/agents/providers/claude-model-options';

export {
    CLAUDE_EFFORT_LEVELS,
    formatClaudeEffortLevelLabel,
    type ClaudeEffortLevel,
} from '@happier-dev/agents/providers/claude-model-options';

type ClaudeProviderModel = AgentSessionProviderBinding['model'];

export const CURRENT_FLAGSHIP_CLAUDE_MODEL_ID = 'claude-opus-5';

const CLAUDE_EFFORT_LEVEL_PRIORITY: readonly ClaudeEffortLevel[] = CLAUDE_EFFORT_LEVELS;

const CLAUDE_EFFORT_LEVELS_BY_MODEL_ID: ReadonlyMap<string, readonly ClaudeEffortLevel[]> = new Map([
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-opus-4-5', ['low', 'medium', 'high']],
]);

function normalizeModelId(raw: unknown): string {
    // Lookup-only normalization: a trailing bracket variant suffix (e.g. the `[1m]`
    // extended-context variant) selects the same underlying model for effort facts.
    // The suffixed id itself is never mutated on any send path.
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return value.replace(/\[[^\]]*\]$/u, '');
}

function resolveProviderEffortOption(
    model: ClaudeProviderModel,
) {
    if (model.capabilities?.reasoningControls !== 'supported') return null;
    return model.modelOptions?.find((option) => option.id === 'reasoning_effort') ?? null;
}

export function resolveClaudeEffortLevelsForProviderModel(
    model: ClaudeProviderModel,
): readonly ClaudeEffortLevel[] {
    const option = resolveProviderEffortOption(model);
    if (!option?.options) return [];
    return option.options.reduce<ClaudeEffortLevel[]>((levels, candidate) => {
        const level = normalizeClaudeEffortLevel(candidate.value);
        if (level && !levels.includes(level)) levels.push(level);
        return levels;
    }, []);
}

export function isClaudeEffortSupportedForProviderModel(
    model: ClaudeProviderModel,
    effortRaw: unknown,
): boolean {
    const effort = normalizeClaudeEffortLevel(effortRaw);
    return effort !== null && resolveClaudeEffortLevelsForProviderModel(model).includes(effort);
}

export function resolveClaudeEffortLevelsForModelId(modelIdRaw: unknown): readonly ClaudeEffortLevel[] {
    const modelId = normalizeModelId(modelIdRaw);
    return modelId.length > 0 ? (CLAUDE_EFFORT_LEVELS_BY_MODEL_ID.get(modelId) ?? []) : [];
}

function resolveClaudeEffortLevelsForKnownAliasOrModel(modelIdRaw: unknown): readonly ClaudeEffortLevel[] {
    const modelId = normalizeModelId(modelIdRaw);
    if (!modelId) return [];

    const direct = resolveClaudeEffortLevelsForModelId(modelId);
    if (direct.length > 0) return direct;

    if (modelId === 'fable' || modelId.includes('fable-5')) {
        return resolveClaudeEffortLevelsForModelId('claude-fable-5');
    }
    if (modelId.includes('opus-5')) {
        return resolveClaudeEffortLevelsForModelId('claude-opus-5');
    }
    if (modelId === 'opus') {
        return resolveClaudeEffortLevelsForModelId(CURRENT_FLAGSHIP_CLAUDE_MODEL_ID);
    }
    if (modelId.includes('opus-4-8')) {
        return resolveClaudeEffortLevelsForModelId('claude-opus-4-8');
    }
    if (modelId.includes('opus-4-7')) {
        return resolveClaudeEffortLevelsForModelId('claude-opus-4-7');
    }
    if (modelId.includes('opus-4-6')) {
        return resolveClaudeEffortLevelsForModelId('claude-opus-4-6');
    }
    if (modelId === 'sonnet' || modelId.includes('sonnet-4-6')) {
        return resolveClaudeEffortLevelsForModelId('claude-sonnet-4-6');
    }
    if (modelId.includes('opus-4-5')) {
        return resolveClaudeEffortLevelsForModelId('claude-opus-4-5');
    }
    return [];
}

export function resolveClaudeDefaultEffortLevelForModelId(modelIdRaw: unknown): ClaudeEffortLevel | null {
    const modelId = normalizeModelId(modelIdRaw);
    const levels = resolveClaudeEffortLevelsForModelId(modelId);
    if (levels.length === 0) return null;
    return modelId === 'claude-opus-4-7' ? 'xhigh' : 'high';
}

export function resolveClaudeDefaultEffortForKnownAliasOrModel(modelIdRaw: unknown): ClaudeEffortLevel | null {
    const modelId = normalizeModelId(modelIdRaw);
    if (!modelId) return null;

    const direct = resolveClaudeDefaultEffortLevelForModelId(modelId);
    if (direct) return direct;

    if (modelId === 'fable' || modelId.includes('fable-5')) {
        return resolveClaudeDefaultEffortLevelForModelId('claude-fable-5');
    }
    if (modelId.includes('opus-5')) {
        return resolveClaudeDefaultEffortLevelForModelId('claude-opus-5');
    }
    if (modelId === 'opus') {
        return resolveClaudeDefaultEffortLevelForModelId(CURRENT_FLAGSHIP_CLAUDE_MODEL_ID);
    }
    if (modelId.includes('opus-4-8')) {
        return resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-8');
    }
    if (modelId.includes('opus-4-7')) {
        return resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-7');
    }
    if (modelId.includes('opus-4-6')) {
        return resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-6');
    }
    if (modelId === 'sonnet' || modelId.includes('sonnet-4-6')) {
        return resolveClaudeDefaultEffortLevelForModelId('claude-sonnet-4-6');
    }
    if (modelId.includes('opus-4-5')) {
        return resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-5');
    }
    return null;
}

function resolveBestSupportedClaudeEffort(
    effort: ClaudeEffortLevel,
    supportedLevels: readonly ClaudeEffortLevel[],
): ClaudeEffortLevel | null {
    const requestedIndex = CLAUDE_EFFORT_LEVEL_PRIORITY.indexOf(effort);
    if (requestedIndex < 0) return null;

    for (let i = requestedIndex; i >= 0; i -= 1) {
        const candidate = CLAUDE_EFFORT_LEVEL_PRIORITY[i];
        if (supportedLevels.includes(candidate)) return candidate;
    }
    return null;
}

export function resolveClaudeEffectiveEffortForModel(params: Readonly<{
    modelId: unknown;
    effort: unknown;
    providerModel?: ClaudeProviderModel;
}>): ClaudeEffortLevel | null {
    const effort = normalizeClaudeEffortLevel(params.effort);
    if (!effort) return null;
    if (params.providerModel) {
        if (typeof params.modelId !== 'string' || params.modelId.trim() !== params.providerModel.id) {
            return null;
        }
        const supportedLevels = resolveClaudeEffortLevelsForProviderModel(params.providerModel);
        if (!supportedLevels.includes(effort)) return null;
        return effort;
    }
    const supportedLevels = resolveClaudeEffortLevelsForKnownAliasOrModel(params.modelId);
    if (supportedLevels.length === 0) return null;

    const normalized = resolveBestSupportedClaudeEffort(effort, supportedLevels);
    if (!normalized) return null;
    return normalized;
}

export function resolveClaudeEffortForModel(params: Readonly<{
    modelId: unknown;
    effort: unknown;
    providerModel?: ClaudeProviderModel;
}>): ClaudeEffortLevel | null {
    const effective = resolveClaudeEffectiveEffortForModel(params);
    if (!effective) return null;
    const defaultEffort = params.providerModel
        ? normalizeClaudeEffortLevel(resolveProviderEffortOption(params.providerModel)?.currentValue)
        : resolveClaudeDefaultEffortForKnownAliasOrModel(params.modelId);
    return effective === defaultEffort ? null : effective;
}

/**
 * Ultracode is offered only on xhigh-capable models (alias- and `[1m]`-tolerant).
 * It is a launch/settings toggle, never an effort level in the Happier pipeline.
 */
export function isClaudeUltracodeSupportedModelId(
    modelIdRaw: unknown,
    providerModel?: ClaudeProviderModel,
): boolean {
    if (providerModel) {
        if (typeof modelIdRaw !== 'string' || modelIdRaw.trim() !== providerModel.id) return false;
        return providerModel.capabilities?.reasoningControls === 'supported'
            && providerModel.modelOptions?.some(
                (option) => option.id === 'ultracode' && option.type === 'boolean',
            ) === true;
    }
    return resolveClaudeEffortLevelsForKnownAliasOrModel(modelIdRaw).includes('xhigh');
}

export function buildClaudeEffortCliArgs(params: Readonly<{
    modelId: unknown;
    effort: unknown;
    providerModel?: ClaudeProviderModel;
}>): string[] {
    const resolved = resolveClaudeEffortForModel(params);
    return resolved ? ['--effort', resolved] : [];
}
