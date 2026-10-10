import type { LocalServicePreviewTargetV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { readManagedServiceEndpointUrl } from '@happier-dev/protocol/plugins/managedServiceEndpointUrl';
import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';

/** Preview registration and server-origin admission consume the same observed native/process facts. */
export function readProjectManagedServicePreviewEndpoint(handle: ProjectManagedServiceHandle): LocalServicePreviewTargetV1 | null {
    if (!handle.isCurrent() || handle.retirementSignal.aborted) return null;
    const snapshot = handle.snapshot();
    if (!snapshot.baseUrl || snapshot.state === 'stopped'
        || snapshot.mode === 'native' && snapshot.nativePhase !== 'running') return null;
    const read = readManagedServiceEndpointUrl(snapshot.baseUrl, { hostPolicy: 'ownedLoopback' });
    if (!read.ok) return null;
    return { scheme: 'http', host: read.endpoint.host, port: read.endpoint.port };
}
