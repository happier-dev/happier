import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * True when a Provider binding supplies no credential of its own.
 *
 * Claude Code falls back to the identity stored in its config directory when
 * no binding credential is present. A Provider binding is authoritative for
 * that launch regardless of its upstream URL, so the inherited login must not
 * become an implicit credential for either a redirected or native Anthropic
 * route. Bindings with a credential remain governed by the launch environment
 * the binding materializes.
 */
export function claudeProviderBindingExposesInheritedIdentity(
  binding: AgentSessionProviderBinding,
): boolean {
  return binding.upstream.credential === 'none';
}
