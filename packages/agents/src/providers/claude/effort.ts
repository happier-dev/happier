export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

const CLAUDE_EFFORT_LEVELS_BY_MODEL_ID: ReadonlyMap<string, readonly ClaudeEffortLevel[]> = new Map([
  ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-6', ['low', 'medium', 'high', 'max']],
  ['claude-sonnet-4-6', ['low', 'medium', 'high']],
  ['claude-opus-4-5', ['low', 'medium', 'high']],
]);

/**
 * Normalize a model id for catalog LOOKUP only.
 *
 * Strips a trailing bracket suffix (e.g. the `[1m]` extended-context variant of
 * `claude-fable-5[1m]`) so variant ids resolve the same effort facts as the bare id.
 * Never use this for the send path — the suffix is meaningful to Claude Code and must
 * reach the CLI unmutated.
 */
function normalizeModelId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value.replace(/\[[^\]]*\]$/u, '');
}

export function resolveClaudeEffortLevelsForModelId(modelIdRaw: unknown): readonly ClaudeEffortLevel[] {
  const modelId = normalizeModelId(modelIdRaw);
  return modelId.length > 0 ? (CLAUDE_EFFORT_LEVELS_BY_MODEL_ID.get(modelId) ?? []) : [];
}

export function isClaudeEffortSupportedModelId(modelIdRaw: unknown): boolean {
  return resolveClaudeEffortLevelsForModelId(modelIdRaw).length > 0;
}

export function isClaudeEffortMaxSupportedModelId(modelIdRaw: unknown): boolean {
  return resolveClaudeEffortLevelsForModelId(modelIdRaw).includes('max');
}

/**
 * Ultracode is a session-only Claude Code SETTING (forces xhigh + Dynamic Workflows),
 * not a 6th effort level. It is offered on xhigh-capable models.
 */
export function isClaudeUltracodeSupportedModelId(modelIdRaw: unknown): boolean {
  return resolveClaudeEffortLevelsForModelId(modelIdRaw).includes('xhigh');
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
