import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginDiagnosticRemediationV1 } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { getPluginExecutionOriginCandidateOrigin, readPluginMachineExecutionOriginCandidateRejection,
    type PluginExecutionOriginCandidateV1, type PluginMachineOriginRejectionReasonV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginEventAutomationSetupFailure } from './pluginEventAutomationSetup';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

export type PluginEventAutomationWatcherFailure = Readonly<{
    code: 'event_observer_unavailable';
    reason: PluginMachineOriginRejectionReasonV1 | 'observer_binding_unavailable';
    retryable: boolean;
    remediation: PluginDiagnosticRemediationV1;
}>;

function watcherFailure(reason: PluginEventAutomationWatcherFailure['reason']): PluginEventAutomationWatcherFailure {
    const failure = { code: 'event_observer_unavailable', reason } as const;
    switch (reason) {
        case 'offline':
        case 'home_unreachable':
        case 'daemon_unavailable':
        case 'source_not_ready':
        case 'unknown':
            return { ...failure, retryable: true, remediation: { kind: 'retry' } };
        case 'daemon_unsupported':
        case 'daemon_invalid_response':
        case 'observer_binding_unavailable':
            return { ...failure, retryable: false, remediation: { kind: 'openSettings', path: SETTINGS_ROUTES.machines } };
        case 'content_conflict':
        case 'disabled':
        case 'incompatible':
        case 'machine_local':
        case 'missing':
        case 'release_unavailable':
        case 'non_portable':
        case 'activation_refused':
        case 'plugin_mismatch':
        case 'replaced':
        case 'revoked':
        case 'stale':
        case 'untrusted':
            return { ...failure, retryable: false, remediation: { kind: 'openSettings', path: SETTINGS_ROUTES.plugins } };
    }
}

export const EVENT_OBSERVER_BINDING_UNAVAILABLE = Object.freeze(watcherFailure('observer_binding_unavailable'));

/** A hidden guided picker must settle when its owners have finished discovery. */
export function readGuidedPluginEventAutomationSetupFailure(params: Readonly<{
    catalogReady: boolean;
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null;
    plugin?: Pick<PluginProjectionEntry, 'enabled' | 'diagnostics'>;
    discoveryPending: boolean;
    selectableWatchers: readonly PluginExecutionOriginCandidateV1[];
    watcherFailures: readonly PluginEventAutomationWatcherFailure[];
}>): PluginEventAutomationSetupFailure | null {
    if (!params.catalogReady) return null;
    if (!params.event) {
        // The catalog owns admission. A disabled plugin's reported cause explains
        // its absent Event; do not misreport that as a missing declaration.
        const diagnostic = params.plugin?.enabled === false
            ? params.plugin.diagnostics.find(row => row.severity === 'error' && !row.contribution)
            : undefined;
        if (diagnostic) {
            const details = diagnostic.details;
            const reason = details !== null && typeof details === 'object'
                && 'reason' in details && typeof details.reason === 'string' ? details.reason : diagnostic.code;
            return { code: diagnostic.code, reason, retryable: false };
        }
        return { code: 'event_contribution_not_current', reason: 'event_contribution_not_current', retryable: false };
    }
    if (params.discoveryPending || params.selectableWatchers.length > 0) return null;
    return params.watcherFailures[0] ?? EVENT_OBSERVER_BINDING_UNAVAILABLE;
}

/** Execution custody and observer assignment are distinct, producer-bound facts. */
export function resolvePluginEventAutomationObserverMaterialization(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    origin: PluginMachineExecutionOriginV1,
): PluginMachineMaterializationRefV1 | null {
    const ref = getPluginMachineExecutionOriginRef(origin);
    if (ref.pluginId !== event.event.identity.pluginId) return null;
    const binding = event.observationBinding;
    if (!binding) return 'materializationRef' in origin ? origin.materializationRef : null;
    if (!arePluginMachineExecutionOriginsEqual(binding.executionOrigin, origin)
        || binding.materializationRef.pluginId !== ref.pluginId
        || binding.materializationRef.machineId !== ref.machineId
        || ('materializationRef' in origin && binding.materializationRef.materializationId !== origin.materializationRef.materializationId)
        || ('sourceRef' in origin && (!event.event.sourceCustody
            || !pluginSourceCustodyV1Equal(origin.sourceRef.sourceCustody, event.event.sourceCustody)))) return null;
    return binding.materializationRef;
}

/** Event-specific observation admission composes, rather than replaces, Administration. */
export function readPluginEventAutomationWatcherFailure(
    candidate: PluginExecutionOriginCandidateV1,
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null,
): PluginEventAutomationWatcherFailure | null {
    const rejection = readPluginMachineExecutionOriginCandidateRejection(candidate);
    if (rejection !== null) return watcherFailure(rejection);
    if (!event) return null; // Explicit placement bootstraps the current Event catalog.
    const origin = getPluginExecutionOriginCandidateOrigin(candidate);
    if ('source' in candidate && candidate.source.occurrenceId !== event.event.occurrenceId) {
        return watcherFailure('stale');
    }
    return resolvePluginEventAutomationObserverMaterialization(event, origin) ? null : EVENT_OBSERVER_BINDING_UNAVAILABLE;
}
