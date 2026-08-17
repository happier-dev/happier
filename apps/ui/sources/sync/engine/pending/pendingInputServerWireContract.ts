import { PENDING_INPUT_PROTOCOL_VERSION_V1 } from '@happier-dev/protocol';

import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { isReleasedServerV021CompatibilitySnapshot } from '@/sync/api/capabilities/releasedServerV021Compatibility';

export type PendingInputServerWireMode =
    | 'pending_input_v1'
    | 'released_server_v0_2_1'
    | 'indeterminate';

export function shouldSchedulePendingOutboxTransportRetry(mode: PendingInputServerWireMode): boolean {
    return mode !== 'indeterminate';
}

// Compatibility seam provenance: immutable server-v0.2.1 commit 4913c1e.
// UI owns only this server/account HTTP enqueue-shape choice; it is not CLI Runtime or provider authority.
// Remove the released serializer when server-v0.2.1 leaves the supported compatibility window.
export function resolvePendingInputServerWireMode(
    snapshot: ServerFeaturesSnapshot | Readonly<{ status: 'loading' }>,
): PendingInputServerWireMode {
    if (snapshot.status !== 'ready') return 'indeterminate';
    const pendingInputVersion =
        snapshot.features.capabilities.session.pendingInput?.protocolVersion;
    if (
        pendingInputVersion !== undefined
        && pendingInputVersion >= PENDING_INPUT_PROTOCOL_VERSION_V1
    ) {
        return 'pending_input_v1';
    }
    if (isReleasedServerV021CompatibilitySnapshot(snapshot)) {
        return 'released_server_v0_2_1';
    }
    return 'indeterminate';
}
