import { providers as agentProviders } from '@happier-dev/agents';

export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'max';

function normalizeClaudeEffortLevel(raw: unknown): ClaudeEffortLevel | null {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!value) return null;
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'max') return value;
    return null;
}

function modelSupportsClaudeEffort(modelIdRaw: unknown): boolean {
    const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim().toLowerCase() : '';
    if (!modelId) return false;
    if (agentProviders.claude.isClaudeEffortSupportedModelId(modelId)) return true;
    // Common CLI aliases: assume they map to the latest supported Opus/Sonnet.
    if (modelId === 'opus' || modelId === 'sonnet') return true;
    // Some callers may pass provider ids without the `claude-` prefix.
    if (modelId.includes('opus-4-6') || modelId.includes('sonnet-4-6') || modelId.includes('opus-4-5')) return true;
    return false;
}

function modelSupportsClaudeEffortMax(modelIdRaw: unknown): boolean {
    const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim().toLowerCase() : '';
    if (!modelId) return false;
    if (agentProviders.claude.isClaudeEffortMaxSupportedModelId(modelId)) return true;
    // Opus alias maps to the latest Opus generation.
    if (modelId === 'opus') return true;
    if (modelId.includes('opus-4-6')) return true;
    return false;
}

export function resolveClaudeEffortForModel(params: Readonly<{
    modelId: unknown;
    effort: unknown;
}>): ClaudeEffortLevel | null {
    const effort = normalizeClaudeEffortLevel(params.effort);
    if (!effort) return null;
    if (!modelSupportsClaudeEffort(params.modelId)) return null;

    const normalized: ClaudeEffortLevel =
        effort === 'max' && !modelSupportsClaudeEffortMax(params.modelId)
            ? 'high'
            : effort;

    // Treat "high" as the provider default: omit it unless the user explicitly chooses a lower or max setting.
    return normalized === 'high' ? null : normalized;
}

export function buildClaudeEffortCliArgs(params: Readonly<{
    modelId: unknown;
    effort: unknown;
}>): string[] {
    const resolved = resolveClaudeEffortForModel(params);
    return resolved ? ['--effort', resolved] : [];
}
