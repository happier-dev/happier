/**
 * Canonical source of truth for the Claude permission-hook answer window.
 *
 * Two surfaces must agree on this value so a late permission answer is handled honestly:
 *  - the `timeout` (seconds) installed on the Claude PermissionRequest / AskUserQuestion hooks,
 *    which Claude itself enforces on the blocking forwarder process; and
 *  - the host hook-server response ceiling (milliseconds), after which a still-unanswered
 *    request honestly expires (HTTP 408) instead of resolving into a forwarder Claude has
 *    already killed.
 *
 * The default is effectively unlimited (7 days) so a user can launch a session, sleep, and
 * answer a permission prompt on waking — while staying FINITE so the host ceiling can still
 * fire an honest expiry for a genuinely-dead forwarder rather than a false approval into a
 * dead socket. A single env override (`HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS`) feeds
 * both surfaces so they never drift apart.
 */

export const DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS = 7 * 24 * 60 * 60; // 604800s (7 days)

export const PERMISSION_HOOK_TIMEOUT_ENV_VAR = 'HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS';

/**
 * Resolves the effective permission-hook timeout in SECONDS.
 *
 * Precedence: explicit positive-integer override → positive-integer env override → 7d default.
 * Non-positive / non-numeric inputs are ignored (fail to the default) so a malformed env value
 * can never silently shrink the window to zero.
 */
export function resolveClaudePermissionHookTimeoutSeconds(params?: Readonly<{
  explicitSeconds?: number;
  env?: Readonly<Record<string, string | undefined>>;
}>): number {
  const explicit = params?.explicitSeconds;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.trunc(explicit);
  }
  const raw = params?.env?.[PERMISSION_HOOK_TIMEOUT_ENV_VAR];
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS;
}

/** Same resolution, expressed in MILLISECONDS, for the host-server response ceiling. */
export function resolveClaudePermissionHookCeilingMs(params?: Readonly<{
  explicitSeconds?: number;
  env?: Readonly<Record<string, string | undefined>>;
}>): number {
  return resolveClaudePermissionHookTimeoutSeconds(params) * 1000;
}
