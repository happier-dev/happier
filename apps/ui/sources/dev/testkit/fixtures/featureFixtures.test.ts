import { describe, expect, it } from 'vitest';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';

import { createRootLayoutFeaturesResponse } from './featureFixtures';

describe('root layout feature fixtures', () => {
    it('advertises current Home deployment support and preserves explicit operator opt-out', () => {
        expect(readServerEnabledBit(createRootLayoutFeaturesResponse(), 'deployments')).toBe(true);
        expect(readServerEnabledBit(createRootLayoutFeaturesResponse({
            features: { deployments: { enabled: false } },
        }), 'deployments')).toBe(false);
    });

    it('preserves the advertised Home descriptor for the strict features consumer', () => {
        const descriptor = HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId: 'srv_feature_fixture', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1,
            endpoints: [{ kind: 'https', url: 'http://127.0.0.1:43123' }],
        });
        const response = createRootLayoutFeaturesResponse({ homeConnectionDescriptor: descriptor,
            capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } } });

        expect(FeaturesResponseSchema.parse(response).homeConnectionDescriptor).toEqual(descriptor);
    });

    it('retains the canonical nested gates when overriding Provider and Team enablement', () => {
        const defaults = createRootLayoutFeaturesResponse();
        const response = createRootLayoutFeaturesResponse({
            features: { providers: { enabled: true }, teams: { enabled: true } },
        });

        expect(response.features.providers).toEqual({ ...defaults.features.providers, enabled: true });
        expect(response.features.teams).toEqual({ ...defaults.features.teams, enabled: true });
    });
});
