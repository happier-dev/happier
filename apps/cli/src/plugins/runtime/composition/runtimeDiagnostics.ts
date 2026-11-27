import { createPluginScmBackendRegistryFromRuntimeRegistry } from '../../../scm/pluginBackends/runtimeRegistry';
import type { ConfiguredExternalSessionSourceAgentContribution } from '@/session/external/configuredSourceMaterializer';
import type { ConfiguredExternalSessionSourceRefusal } from '@/session/external/configuredSourceRegistry';
import type { ResolvedContributionRegistry } from '../../projection/registry/types';
import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import { projectExternalSessionSourceRefusalDiagnostics } from '../lifecycle/contributions/externalSessionSourceRefusals';
import type { ActivatedPluginRuntimeRegistry } from '../lifecycle/manager';
import { mergePluginDiagnostics } from './activatedContributions';

/** Publishes diagnostic projections in place for the serving registry. */
export function createRuntimeDiagnostics(input: Readonly<{
    contributions: ResolvedContributionRegistry;
    activation: ActivatedPluginRuntimeRegistry;
}>) {
    const { contributions, activation } = input;
    let externalSessionProjectionDiagnosticsByPluginId:
        Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> = Object.freeze({});
    const pluginDiagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {
        ...mergePluginDiagnostics(
            contributions.pluginDiagnosticsByPluginId,
            activation.pluginDiagnosticsByPluginId,
        ),
    };

    function readCurrentScmBackendDiagnostics(): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
        return createPluginScmBackendRegistryFromRuntimeRegistry({
            contributes: contributions,
            scmBackendsById: activation.scmBackendsById,
            scmBackendRegistrations: activation.scmBackendRegistrations,
            envAllowedNamesByPluginId: activation.envAllowedNamesByPluginId,
        }).diagnosticsByPluginId;
    }

    // Provider contributions activate on demand, so a mis-authored Provider
    // registration is refused after the authoritative merge already ran. Keep
    // that plugin's own author-actionable refusal here so it survives every
    // later diagnostic refresh instead of being silently dropped.
    const providerProjectionDiagnosticsByPluginId:
        Record<string, readonly PluginCompatibilityDiagnostic[]> = {};

    function refreshPluginDiagnostics(
        pluginId: string,
        scmDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
    ): void {
        pluginDiagnosticsByPluginId[pluginId] = Object.freeze([
            ...(contributions.pluginDiagnosticsByPluginId[pluginId] ?? []),
            ...(activation.activatedPluginIds.has(pluginId)
                ? (scmDiagnosticsByPluginId[pluginId] ?? [])
                : []),
            ...(activation.pluginDiagnosticsByPluginId[pluginId] ?? []),
            ...(providerProjectionDiagnosticsByPluginId[pluginId] ?? []),
            ...(externalSessionProjectionDiagnosticsByPluginId[pluginId] ?? []),
        ]);
    }

    /**
     * The configured-source lifecycle is the sole Account-revision owner. Its
     * admitted refusal facts refresh this existing registry diagnostics map in
     * place, including the previous owners whose snapshot must be cleared.
     */
    function refreshExternalSessionProjectionDiagnostics(
        agents: readonly ConfiguredExternalSessionSourceAgentContribution[],
        refusals: readonly ConfiguredExternalSessionSourceRefusal[],
    ): void {
        const previousPluginIds = Object.keys(
            externalSessionProjectionDiagnosticsByPluginId,
        );
        const next = projectExternalSessionSourceRefusalDiagnostics(agents, refusals);
        externalSessionProjectionDiagnosticsByPluginId = next;
        const affectedPluginIds = new Set([
            ...previousPluginIds,
            ...Object.keys(next),
            ...agents.flatMap((agent) => (
                agent.identity ? [agent.identity.pluginId] : []
            )),
        ]);
        const scmDiagnosticsByPluginId = readCurrentScmBackendDiagnostics();
        for (const pluginId of affectedPluginIds) {
            refreshPluginDiagnostics(pluginId, scmDiagnosticsByPluginId);
        }
    }

    function recordProviderProjectionRefusals(
        pluginId: string,
        refusalsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
    ): void {
        const refusals = refusalsByPluginId[pluginId] ?? [];
        const existing = providerProjectionDiagnosticsByPluginId[pluginId] ?? [];
        const added = refusals.filter((diagnostic) => !existing.some((entry) => (
            entry.code === diagnostic.code && entry.message === diagnostic.message
        )));
        if (added.length === 0) return;
        providerProjectionDiagnosticsByPluginId[pluginId] = Object.freeze([...existing, ...added]);
        refreshPluginDiagnostics(pluginId, readCurrentScmBackendDiagnostics());
    }

    const initialScmDiagnosticsByPluginId = readCurrentScmBackendDiagnostics();
    for (const pluginId of activation.activatedPluginIds) {
        refreshPluginDiagnostics(pluginId, initialScmDiagnosticsByPluginId);
    }
    return {
        pluginDiagnosticsByPluginId,
        readCurrentScmBackendDiagnostics,
        refreshPluginDiagnostics,
        refreshExternalSessionProjectionDiagnostics,
        recordProviderProjectionRefusals,
    };
}
