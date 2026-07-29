import {
    CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION,
    CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
    type PendingInputServerContractV1,
} from '@happier-dev/protocol';
import { resolveSessionSyncCompatibilityPolicy } from '@/app/clientCompatibility/policy';
import type { FeaturesPayloadDelta } from './types';

export const CURRENT_PENDING_INPUT_REQUIREMENTS: PendingInputServerContractV1 = Object.freeze({
    currentPendingInputProtocolVersion: CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
});

const CURRENT_EXTERNAL_SESSION_IMPORT_REQUIREMENTS = Object.freeze({
    currentPublicationFenceVersion: CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION,
});

export function resolveClientCompatibilityFeature(env: NodeJS.ProcessEnv = process.env): FeaturesPayloadDelta {
    const policy = resolveSessionSyncCompatibilityPolicy(env);
    return {
        capabilities: {
            compatibility: {
                v: 1,
                sessionSync: policy.requirements,
                pendingInput: CURRENT_PENDING_INPUT_REQUIREMENTS,
                externalSessionImport: CURRENT_EXTERNAL_SESSION_IMPORT_REQUIREMENTS,
            },
        },
    };
}
