import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type {
    ConfiguredExternalSessionSourceAgentContribution,
} from '@/session/external/configuredSourceMaterializer';
import type {
    ConfiguredExternalSessionSourceRefusal,
} from '@/session/external/configuredSourceRegistry';

/**
 * Names the Agents whose own provider leaf refused their configured External
 * Sessions source, so a dropped candidate is author-visible instead of silent.
 *
 * The configured-source owner already isolated the refusal: every other Agent's
 * sources and every plugin's `sessions.external` keep projecting. This reuses the
 * per-plugin diagnostic seam the activation owner uses to isolate a throwing
 * `activate()` — the same `pluginDiagnosticsByPluginId` map, the same
 * `PluginCompatibilityDiagnostic` shape, scoped by the refused Agent's own
 * contribution identity.
 *
 * It deliberately does NOT reuse that owner's `plugin_activation_failed` code.
 * That code is in `BLOCKING_PLUGIN_RELOAD_DIAGNOSTIC_CODES`, so
 * `assertPluginRuntimeReadiness` would reject the whole readiness candidate and
 * `adoptPreparedRuntimeRegistry` would refuse the reload — for what may be a
 * transient provider probe failure. The activation owner's uses are deterministic
 * manifest/registration drift, where blocking is correct; a refused runtime
 * source probe is author-actionable, not fatal.
 *
 * An Agent with no contribution identity (a bundled in-code Agent) has no plugin
 * to attribute the refusal to and is skipped.
 */
export function projectExternalSessionSourceRefusalDiagnostics(
    agents: readonly ConfiguredExternalSessionSourceAgentContribution[],
    refusals: readonly ConfiguredExternalSessionSourceRefusal[],
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    if (refusals.length === 0) return Object.freeze({});
    const identitiesByAgentId = new Map(agents.flatMap((agent) => (
        agent.identity ? [[agent.id, agent.identity] as const] : []
    )));
    const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
    for (const refusal of refusals) {
        const identity = identitiesByAgentId.get(refusal.agentId);
        if (!identity) continue;
        const diagnostic: PluginCompatibilityDiagnostic = Object.freeze({
            code: 'plugin_external_session_source_refused',
            message:
                `Configured External Sessions source for Agent '${refusal.agentId}' was refused `
                + `by its own provider (${refusal.code}): ${refusal.message}`,
            contribution: identity,
        });
        const existing = diagnosticsByPluginId[identity.pluginId] ?? [];
        if (existing.some((entry) => (
            entry.code === diagnostic.code && entry.message === diagnostic.message
        ))) continue;
        diagnosticsByPluginId[identity.pluginId] = Object.freeze([...existing, diagnostic]);
    }
    return Object.freeze(diagnosticsByPluginId);
}
