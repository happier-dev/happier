export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

const CLAUDE_EFFORT_SUPPORTED_MODELS_V1: ReadonlySet<string> = new Set([
  // Fact-based support list (Anthropic effort docs, 2026-03):
  // platform.claude.com/docs/en/build-with-claude/effort
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
]);

const CLAUDE_EFFORT_MAX_SUPPORTED_MODELS_V1: ReadonlySet<string> = new Set([
  'claude-opus-4-6',
]);

function normalizeModelId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function isClaudeEffortSupportedModelId(modelIdRaw: unknown): boolean {
  const modelId = normalizeModelId(modelIdRaw);
  return modelId.length > 0 && CLAUDE_EFFORT_SUPPORTED_MODELS_V1.has(modelId);
}

export function isClaudeEffortMaxSupportedModelId(modelIdRaw: unknown): boolean {
  const modelId = normalizeModelId(modelIdRaw);
  return modelId.length > 0 && CLAUDE_EFFORT_MAX_SUPPORTED_MODELS_V1.has(modelId);
}

export function resolveClaudeEffortLevelsForModelId(modelIdRaw: unknown): readonly ClaudeEffortLevel[] {
  if (!isClaudeEffortSupportedModelId(modelIdRaw)) return [];
  return isClaudeEffortMaxSupportedModelId(modelIdRaw)
    ? CLAUDE_EFFORT_LEVELS
    : (['low', 'medium', 'high'] as const);
}
