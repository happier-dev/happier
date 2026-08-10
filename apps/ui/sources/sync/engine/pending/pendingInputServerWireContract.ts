import {
    PENDING_INPUT_PROTOCOL_VERSION_V1,
} from '@happier-dev/protocol';

import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { isReleasedServerV021CompatibilitySnapshot } from '@/sync/api/capabilities/releasedServerV021Compatibility';

export type PendingInputServerWireMode =
    | 'pending_input_v1'
    | 'released_server_v0_2_1'
    | 'indeterminate';

/**
 * HTTP-only Pending wire selection. This result shapes UI requests and responses only; it never
 * authorizes materialization, Runtime Activity, provider input, or settlement.
 */
export function resolvePendingInputServerWireMode(
    snapshot: ServerFeaturesSnapshot,
): PendingInputServerWireMode {
    if (snapshot.status !== 'ready') return 'indeterminate';

    const pendingInputVersion =
        snapshot.features.capabilities.session?.pendingInput?.protocolVersion;
    if (
        typeof pendingInputVersion === 'number'
        && pendingInputVersion >= PENDING_INPUT_PROTOCOL_VERSION_V1
    ) {
        return 'pending_input_v1';
    }

    if (isReleasedServerV021CompatibilitySnapshot(snapshot)) {
        return 'released_server_v0_2_1';
    }

    return 'indeterminate';
}
