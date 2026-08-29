/**
 * Claude 1M extended-context facts.
 *
 * Claude Code models a 1M context window as a MODEL-ID VARIANT: appending `[1m]` to a
 * model id/alias (e.g. `claude-sonnet-4-6[1m]`). The CLI strips the suffix before the
 * API call, so the suffixed id is safe to send through `--model`, `/model`, and the
 * Agent SDK `model` option.
 *
 * Capability facts (per the official model-config docs):
 * - 1M-capable: Fable 5, Opus 4.6 and later, Sonnet 4.6.
 * - Always-1M on the API (no opt-in needed): Opus 5, Fable 5, Opus 4.8, Opus 4.7 — the explicit
 *   `[1m]` toggle is only meaningful where 1M is opt-in (Sonnet 4.6, Opus 4.6).
 */

export const CLAUDE_1M_SUFFIX = '[1m]';

const CLAUDE_1M_CONTEXT_MODEL_IDS: ReadonlySet<string> = new Set([
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
]);

const CLAUDE_1M_ALWAYS_ON_MODEL_IDS: ReadonlySet<string> = new Set([
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
]);

function normalizeForLookup(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value.replace(/\[[^\]]*\]$/u, '');
}

/** True when the id carries an explicit trailing `[1m]` variant suffix. */
export function isClaude1mModelId(modelIdRaw: unknown): boolean {
  if (typeof modelIdRaw !== 'string') return false;
  return /\[1m\]$/iu.test(modelIdRaw.trim());
}

/** Strip a trailing `[1m]` suffix (lookup/display); leaves other ids untouched. */
export function stripClaude1mSuffix(modelIdRaw: string): string {
  return modelIdRaw.trim().replace(/\[1m\]$/iu, '');
}

/** Append the `[1m]` suffix to a bare model id (idempotent). */
export function toClaude1mModelId(modelIdRaw: string): string {
  const trimmed = modelIdRaw.trim();
  return isClaude1mModelId(trimmed) ? trimmed : `${trimmed}${CLAUDE_1M_SUFFIX}`;
}

/** True when the underlying model supports a 1M context window (`[1m]`-tolerant). */
export function isClaude1mContextSupportedModelId(modelIdRaw: unknown): boolean {
  return CLAUDE_1M_CONTEXT_MODEL_IDS.has(normalizeForLookup(modelIdRaw));
}

/** True when the model ALWAYS runs 1M on the API, so an opt-in toggle is meaningless. */
export function isClaude1mAlwaysOnModelId(modelIdRaw: unknown): boolean {
  return CLAUDE_1M_ALWAYS_ON_MODEL_IDS.has(normalizeForLookup(modelIdRaw));
}

/** True when 1M is genuinely opt-in for the model (supported but not always-on). */
export function isClaude1mContextOptInModelId(modelIdRaw: unknown): boolean {
  return isClaude1mContextSupportedModelId(modelIdRaw) && !isClaude1mAlwaysOnModelId(modelIdRaw);
}

// --- Lane U8 additions: context-window token resolution + observed-usage evidence bump ---

export const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const CLAUDE_1M_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** Claude context-window sizes Happier knows about, ascending. */
export const CLAUDE_KNOWN_CONTEXT_WINDOW_TOKENS: readonly number[] = Object.freeze([
  CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
  CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
]);

/**
 * Resolve the context window implied by the model id alone.
 *
 * - Any explicit `[1m]` variant id resolves 1M (the suffix IS the opt-in signal).
 * - Always-1M models resolve 1M even with a BASE id — Unified hooks/JSONL report the base id.
 * - Everything else resolves null: the caller decides between catalog facts and the 200k default.
 */
export function resolveClaudeContextWindowTokensForModelId(modelIdRaw: unknown): number | null {
  if (isClaude1mModelId(modelIdRaw)) return CLAUDE_1M_CONTEXT_WINDOW_TOKENS;
  if (isClaude1mAlwaysOnModelId(modelIdRaw)) return CLAUDE_1M_CONTEXT_WINDOW_TOKENS;
  return null;
}

/**
 * Evidence fallback: when observed context usage exceeds the assumed window, the assumption is
 * stale (e.g. the user enabled 1M in Claude's own settings without Happier knowing). Bump to the
 * smallest known window that fits the observation; beyond every known window, trust the
 * observation itself so consumers never compute >100% usage.
 */
export function bumpClaudeContextWindowTokensForObservedUsage(params: Readonly<{
  contextWindowTokens: number;
  observedUsedTokens: number;
}>): number {
  const observed = Number.isFinite(params.observedUsedTokens) && params.observedUsedTokens > 0
    ? Math.trunc(params.observedUsedTokens)
    : 0;
  if (observed <= params.contextWindowTokens) return params.contextWindowTokens;
  for (const known of CLAUDE_KNOWN_CONTEXT_WINDOW_TOKENS) {
    if (known >= observed) return known;
  }
  return observed;
}
