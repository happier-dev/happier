import {
    CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION,
    CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
    SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
} from '@happier-dev/protocol';

import type { FeaturesPayloadDelta } from './types';

export function resolveSessionProtocolCapabilitiesFeature(): FeaturesPayloadDelta {
    return {
        capabilities: {
            session: {
                runtimeActivity: {
                    protocolVersion: SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
                },
                pendingInput: {
                    protocolVersion: CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
                },
                publisherAuthority: { protocolVersion: 1 },
                externalImport: {
                    publicationFenceVersion:
                        CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION,
                },
            },
        },
    };
}
