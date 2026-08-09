import { AGENT_MODEL_CONFIG, providers as agentProviders } from '@happier-dev/agents';

export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const CLAUDE_EFFORT_LEVEL_PRIORITY: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Normalize a Claude model id for the "is this a curated model?" check (strip `[1m]` + dated suffix). */
function normalizeClaudeModelIdForKnownCheck(raw: unknown): string {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return value.replace(/\[[^\]]*\]$/u, '').replace(/-\d{8}$/u, '');
}

const KNOWN_STATIC_CLAUDE_MODEL_IDS: ReadonlySet<string> = new Set(
    (AGENT_MODEL_CONFIG.claude.staticModels ?? []).map((model) => normalizeClaudeModelIdForKnownCheck(model.id)),
);

/**
 * True when the id is a model Happier curates in the static catalog (or a known bare alias).
 *
 * Used to distinguish a curated model that intentionally has no effort control (e.g. Haiku —
 * must never receive `--effort`) from a dynamically-discovered model, where a user-selected
 * effort is trusted and passed through.
 */
export function isCuratedClaudeModelId(modelIdRaw: unknown): boolean {
    const id = normalizeClaudeModelIdForKnownCheck(modelIdRaw);
    if (!id) return false;
    if (KNOWN_STATIC_CLAUDE_MODEL_IDS.has(id)) return true;
    return id === 'opus' || id === 'sonnet' || id === 'haiku' || id === 'fable';
}

/** Narrow caller-supplied tiers (e.g. from the Anthropic Models API) to known effort levels. */
function normalizeReportedClaudeEffortLevels(raw: unknown): readonly ClaudeEffortLevel[] {
    if (!Array.isArray(raw)) return [];
    const levels = raw
        .map((value) => normalizeClaudeEffortLevel(value))
        .filter((level): level is ClaudeEffortLevel => level !== null);
    return CLAUDE_EFFORT_LEVEL_PRIORITY.filter((level) => levels.includes(level));
}

/**
 * Effort levels we have evidence the model supports.
 *
 * The curated table wins for curated models — including curated models with NO effort support
 * (Haiku), which must never be overridden by reported tiers. For a discovered model the only
 * evidence is what the caller passes in; absent that, there is none. `reasoningEffort` is
 * session-scoped and is not cleared when the model changes, so an unrecognised id is not by
 * itself a reason to forward a carried level.
 */
function resolveEvidencedClaudeEffortLevels(
    modelIdRaw: unknown,
    reportedRaw: unknown,
): readonly ClaudeEffortLevel[] {
    // A discovered id is only ever evidenced by its own reported tiers. It may CONTAIN a curated
    // alias (`claude-opus-5-preview` matches the `opus-5` substring rule) without being that model,
    // so the curated table must not be consulted for it at all — otherwise a stale session effort
    // would be clamped against another model's tiers and forwarded.
    if (!isCuratedClaudeModelId(modelIdRaw)) return normalizeReportedClaudeEffortLevels(reportedRaw);

    // Curated models own their table, including curated models with no effort support (Haiku),
    // which reported tiers must never override.
    return resolveClaudeEffortLevelsForKnownAliasOrModel(modelIdRaw);
}

function normalizeClaudeEffortLevel(raw: unknown): ClaudeEffortLevel | null {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!value) return null;
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
    return null;
}

function resolveClaudeEffortLevelsForKnownAliasOrModel(modelIdRaw: unknown): readonly ClaudeEffortLevel[] {
    const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim().toLowerCase() : '';
    if (!modelId) return [];

    const direct = agentProviders.claude.resolveClaudeEffortLevelsForModelId(modelId) as readonly ClaudeEffortLevel[];
    if (direct.length > 0) return direct;

    if (modelId === 'fable' || modelId.includes('fable-5')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-fable-5') as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-5')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-5') as readonly ClaudeEffortLevel[];
    }
    if (modelId === 'opus') {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId(agentProviders.claude.CURRENT_FLAGSHIP_CLAUDE_MODEL_ID) as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-4-8')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-4-8') as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-4-7')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-4-7') as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-4-6')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-4-6') as readonly ClaudeEffortLevel[];
    }
    if (modelId === 'sonnet' || modelId.includes('sonnet-4-6')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-sonnet-4-6') as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-4-5')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-4-5') as readonly ClaudeEffortLevel[];
    }
    return [];
}

function resolveClaudeDefaultEffortForKnownAliasOrModel(modelIdRaw: unknown): ClaudeEffortLevel | null {
    const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim().toLowerCase() : '';
    if (!modelId) return null;

    const direct = agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId(modelId) as ClaudeEffortLevel | null;
    if (direct) return direct;

    if (modelId === 'fable' || modelId.includes('fable-5')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-fable-5') as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-5')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-5') as ClaudeEffortLevel | null;
    }
    if (modelId === 'opus') {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId(agentProviders.claude.CURRENT_FLAGSHIP_CLAUDE_MODEL_ID) as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-4-8')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-8') as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-4-7')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-7') as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-4-6')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-6') as ClaudeEffortLevel | null;
    }
    if (modelId === 'sonnet' || modelId.includes('sonnet-4-6')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-sonnet-4-6') as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-4-5')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-5') as ClaudeEffortLevel | null;
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

/**
 * Tiers carried on the session mode, but only when they belong to `modelId`.
 *
 * A launch can override the model (`--model` in `claudeArgs`), and one model's reported tiers must
 * never gate another model's effort or ultracode.
 */
export function resolveModeEffortLevelsForModel(
    mode: Readonly<{ modelEffortLevels?: readonly string[]; modelEffortLevelsModelId?: string | null }>,
    modelId: unknown,
): readonly string[] | undefined {
    const normalized = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalized) return undefined;
    return mode.modelEffortLevelsModelId === normalized ? mode.modelEffortLevels : undefined;
}

export function resolveClaudeEffortForModel(params: Readonly<{
    modelId: unknown;
    effort: unknown;
    /** Effort tiers the model reported (Anthropic Models API). Required for discovered models. */
    supportedLevels?: readonly unknown[];
}>): ClaudeEffortLevel | null {
    const effort = normalizeClaudeEffortLevel(params.effort);
    if (!effort) return null;
    // No explicit model means the CLI picks its own default; forwarding `--effort` would apply a
    // level the user never chose for a model we cannot check support against.
    const normalizedModelId = normalizeClaudeModelIdForKnownCheck(params.modelId);
    if (!normalizedModelId || normalizedModelId === 'default') return null;

    const supportedLevels = resolveEvidencedClaudeEffortLevels(params.modelId, params.supportedLevels);
    if (supportedLevels.length === 0) return null;

    const normalized = resolveBestSupportedClaudeEffort(effort, supportedLevels);
    if (!normalized) return null;
    const defaultEffort = resolveClaudeDefaultEffortForKnownAliasOrModel(params.modelId);

    return normalized === defaultEffort ? null : normalized;
}

export function buildClaudeEffortCliArgs(params: Readonly<{
    modelId: unknown;
    effort: unknown;
    supportedLevels?: readonly unknown[];
}>): string[] {
    const resolved = resolveClaudeEffortForModel(params);
    return resolved ? ['--effort', resolved] : [];
}

/** Alias-aware default effort for a Claude model id (tolerates `[1m]` variants). */
export function resolveClaudeDefaultEffortForModel(modelIdRaw: unknown): ClaudeEffortLevel | null {
    return resolveClaudeDefaultEffortForKnownAliasOrModel(modelIdRaw);
}

function normalizeUltracodeRequest(raw: unknown): boolean {
    if (raw === true) return true;
    return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

/**
 * Resolve the effective ultracode setting for a spawn/launch.
 *
 * Ultracode is a session-only Claude Code SETTING (forces xhigh + Dynamic Workflows) —
 * it is NOT an effort level and must never ride `--effort`/the SDK `effort` option.
 * It is honored only on xhigh-capable models (alias- and `[1m]`-tolerant).
 */
export function resolveClaudeUltracodeForModel(params: Readonly<{
    modelId: unknown;
    ultracode: unknown;
    /** Effort tiers the model reported (Anthropic Models API). Required for discovered models. */
    supportedLevels?: readonly unknown[];
}>): boolean {
    if (!normalizeUltracodeRequest(params.ultracode)) return false;

    const normalizedModelId = normalizeClaudeModelIdForKnownCheck(params.modelId);
    if (!normalizedModelId || normalizedModelId === 'default') return false;

    // Ultracode forces xhigh, so it needs the same evidence as an xhigh effort selection. A
    // discovered model qualifies only when the caller passes the tiers the API reported.
    return resolveEvidencedClaudeEffortLevels(params.modelId, params.supportedLevels).includes('xhigh');
}

/** The `--settings` JSON overlay value that turns ultracode on for a spawned Claude CLI. */
export function buildClaudeUltracodeSettingsJson(): string {
    return JSON.stringify({ ultracode: true });
}
