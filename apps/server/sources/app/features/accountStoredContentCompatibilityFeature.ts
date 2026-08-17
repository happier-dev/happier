import { CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import type { FeaturesPayloadDelta } from './types';

export function resolveAccountStoredContentCompatibilityFeature(): FeaturesPayloadDelta {
    return {
        capabilities: {
            accountStoredContentCompatibility:
                CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS,
        },
    };
}
