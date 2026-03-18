import { describe, expect, it } from 'vitest';

import { featuresSchema } from './types';
import { resolveServerFeaturePayload } from './catalog/resolveServerFeaturePayload';
import { resolveServerRetentionCapabilitiesFeature } from './serverRetentionCapabilitiesFeature';
import { resolveServerUrlCapabilitiesFeature } from './serverUrlCapabilitiesFeature';

describe('features/serverFeatureRegistry', () => {
    it('returns a schema-valid /v1/features payload', () => {
        const res = resolveServerFeaturePayload(
            {
                HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/',
                HAPPIER_WEBAPP_URL: 'https://ui.example.test/app',
                HAPPIER_SERVER_RETENTION__ENABLED: 'true',
                HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
                HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '30',
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: 'delete_older_than',
                HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: '30',
            } as NodeJS.ProcessEnv,
            [resolveServerUrlCapabilitiesFeature, resolveServerRetentionCapabilitiesFeature],
        );
        const parsed = featuresSchema.safeParse(res);
        expect(parsed.success).toBe(true);
    });

    it('throws when a resolver returns an invalid features shape', () => {
        expect(() =>
            resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [
                () =>
                    ({
                        features: { voice: { enabled: 'nope' } },
                    }) as any,
            ]),
        ).toThrow(/features/i);
    });
});
