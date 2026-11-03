import { readServerEnabledBit } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { resolveServerFeaturePayload } from './catalog/resolveServerFeaturePayload';
import { serverFeatureRegistry } from './catalog/serverFeatureRegistry';

describe('sessions.filteredListing server feature', () => {
    it('is published by default so structural filtering runs before Home-local pagination', () => {
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            serverFeatureRegistry,
        );
        expect(readServerEnabledBit(payload, 'sessions.filteredListing')).toBe(true);
        expect(payload.features.sessions.filteredListing).toMatchObject({ projectSelectorVersion: 1, membershipSelectorVersion: 1 });
    });

    it('honors the operator opt-out', () => {
        const payload = resolveServerFeaturePayload(
            { HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED: '0' } as NodeJS.ProcessEnv,
            serverFeatureRegistry,
        );
        expect(readServerEnabledBit(payload, 'sessions.filteredListing')).toBe(false);
    });
});
