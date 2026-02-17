import { describe, expect, it } from 'vitest';

import { featuresSchema } from './types';
import { resolveServerFeaturePayload } from './catalog/resolveServerFeaturePayload';
import { serverFeatureRegistry } from './catalog/serverFeatureRegistry';

describe('features/serverFeatureRegistry', () => {
    it('provides at least one feature resolver', () => {
        expect(serverFeatureRegistry.length).toBeGreaterThan(0);
    });

    it('returns a schema-valid /v1/features payload', () => {
        const res = resolveServerFeaturePayload({} as NodeJS.ProcessEnv);
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
