import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * Claude Code's own upstream. A binding that keeps the Agent on this origin is
 * not redirecting it anywhere, so the user's inherited Anthropic login remains
 * the correct — and only — identity for the route.
 */
const ANTHROPIC_NATIVE_ORIGIN = 'https://api.anthropic.com';

function isNativeAnthropicUpstream(normalizedUrl: string): boolean {
  try {
    return new URL(normalizedUrl).origin.toLowerCase() === ANTHROPIC_NATIVE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * True when a Provider binding sends Claude Code somewhere other than
 * Anthropic while supplying no credential of its own.
 *
 * Claude Code has no per-request credential in that configuration, so it falls
 * back to the identity stored in its config directory — the user's personal
 * Anthropic login — and presents it to a route the user picked only as a model
 * source. Every other configuration either keeps Claude Code on Anthropic
 * (where that login belongs) or carries the binding's own credential, which
 * the launch environment already imposes.
 */
export function claudeProviderBindingExposesInheritedIdentity(
  binding: AgentSessionProviderBinding,
): boolean {
  const { credential, normalizedUrl } = binding.upstream;
  if (credential !== 'none') return false;
  // A managed-local deployment has no bind-time URL, but it always mints its
  // own runtime credential, so it never reaches this branch.
  return normalizedUrl !== null && !isNativeAnthropicUpstream(normalizedUrl);
}
