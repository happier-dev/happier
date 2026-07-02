export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

const CLAUDE_EFFORT_LEVEL_PRIORITY: readonly ClaudeEffortLevel[] = CLAUDE_EFFORT_LEVELS;

const CLAUDE_EFFORT_LEVELS_BY_MODEL_ID: ReadonlyMap<string, readonly ClaudeEffortLevel[]> = new Map([
    ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-sonnet-4-6', ['low', 'medium', 'high']],
    ['claude-opus-4-5', ['low', 'medium', 'high']],
]);

function normalizeModelId(raw: unknown): string {
    // Lookup-only normalization: a trailing bracket variant suffix (e.g. the `[1m]`
    // extended-context variant) selects the same underlying model for effort facts.
    // The suffixed id itself is never mutated on any send path.
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return value.replace(/\[[^\]]*\]$/u, '');
}

function normalizeClaudeEffortLevel(raw: unknown): ClaudeEffortLevel | null {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!value) return null;
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
    return null;
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
    if (modelId === 'opus' || modelId.includes('opus-4-8')) {
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

export function formatClaudeEffortLevelLabel(level: ClaudeEffortLevel): string {
    switch (level) {
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
    }
}

export function resolveClaudeDefaultEffortForKnownAliasOrModel(modelIdRaw: unknown): ClaudeEffortLevel | null {
    const modelId = normalizeModelId(modelIdRaw);
    if (!modelId) return null;

    const direct = resolveClaudeDefaultEffortLevelForModelId(modelId);
    if (direct) return direct;

    if (modelId === 'fable' || modelId.includes('fable-5')) {
        return resolveClaudeDefaultEffortLevelForModelId('claude-fable-5');
    }
    if (modelId === 'opus' || modelId.includes('opus-4-8')) {
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

export function resolveClaudeEffortForModel(params: Readonly<{
    modelId: unknown;
    effort: unknown;
}>): ClaudeEffortLevel | null {
    const effort = normalizeClaudeEffortLevel(params.effort);
    if (!effort) return null;
    const supportedLevels = resolveClaudeEffortLevelsForKnownAliasOrModel(params.modelId);
    if (supportedLevels.length === 0) return null;

    const normalized = resolveBestSupportedClaudeEffort(effort, supportedLevels);
    if (!normalized) return null;
    const defaultEffort = resolveClaudeDefaultEffortForKnownAliasOrModel(params.modelId);

    return normalized === defaultEffort ? null : normalized;
}

/**
 * Ultracode is offered only on xhigh-capable models (alias- and `[1m]`-tolerant).
 * It is a launch/settings toggle, never an effort level in the Happier pipeline.
 */
export function isClaudeUltracodeSupportedModelId(modelIdRaw: unknown): boolean {
    return resolveClaudeEffortLevelsForKnownAliasOrModel(modelIdRaw).includes('xhigh');
}

export function buildClaudeEffortCliArgs(params: Readonly<{
    modelId: unknown;
    effort: unknown;
}>): string[] {
    const resolved = resolveClaudeEffortForModel(params);
    return resolved ? ['--effort', resolved] : [];
}
