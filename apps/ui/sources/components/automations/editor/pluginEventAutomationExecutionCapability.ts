import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';

/**
 * A detached Event run is admissible only when the selected machine's current
 * execution-run capability advertises that exact task backend and lifecycle.
 */
export function isPluginEventAutomationExecutionRunCapabilityCurrent(params: Readonly<{
    capability: unknown;
    backendTarget: BackendTargetRefV2;
}>): boolean {
    if (!params.capability || typeof params.capability !== 'object' || Array.isArray(params.capability)) {
        return false;
    }
    const capability = params.capability as Readonly<Record<string, unknown>>;
    if (capability.protocolVersion !== 2) return false;
    const features = capability.features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) return false;
    const featureRecord = features as Readonly<Record<string, unknown>>;
    if (featureRecord.detachedScope !== true || featureRecord.startAndWait !== true) return false;
    const backends = capability.backends;
    if (!backends || typeof backends !== 'object' || Array.isArray(backends)) return false;
    const available = new Set(resolveExecutionRunAvailableBackends(
        backends as Readonly<Record<string, Readonly<{ available?: boolean; intents?: readonly string[] }>>>,
        'task',
    ));
    return available.has(params.backendTarget.configuredBackendId ?? params.backendTarget.backendId)
        || available.has(params.backendTarget.backendId);
}
