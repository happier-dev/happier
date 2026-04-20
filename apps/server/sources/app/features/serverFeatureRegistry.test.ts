import { describe, expect, it } from 'vitest';

import { DEFAULT_BUG_REPORTS_CAPABILITIES, readServerEnabledBit } from '@happier-dev/protocol';
import { featuresSchema } from './types';
import { resolveServerFeaturePayload } from './catalog/resolveServerFeaturePayload';
import { serverFeatureRegistry } from './catalog/serverFeatureRegistry';

describe('features/serverFeatureRegistry', () => {
    it('provides at least one feature resolver', () => {
        expect(serverFeatureRegistry.length).toBeGreaterThan(0);
    });

    it('returns a schema-valid /v1/features payload', () => {
        const res = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, serverFeatureRegistry);
        const parsed = featuresSchema.safeParse(res);
        expect(parsed.success).toBe(true);
    });

    it('keeps current gate reads stable when a resolver emits newer unknown fields and malformed bugReports capabilities', () => {
        const res = resolveServerFeaturePayload({} as NodeJS.ProcessEnv, [
            () =>
                ({
                    features: {
                        connectedServices: {
                            enabled: true,
                            quotas: { enabled: true },
                        },
                        futureBridge: {
                            enabled: true,
                        },
                    },
                    capabilities: {
                        bugReports: {
                            providerUrl: 'not-a-url',
                            defaultIncludeDiagnostics: false,
                            maxArtifactBytes: 0,
                            acceptedArtifactKinds: [],
                            uploadTimeoutMs: 0,
                            contextWindowMs: 0,
                        },
                        futureCapability: {
                            enabled: true,
                        },
                    },
                }) as any,
        ]);

        expect(featuresSchema.safeParse(res).success).toBe(true);
        expect(readServerEnabledBit(res, 'connectedServices')).toBe(true);
        expect(readServerEnabledBit(res, 'connectedServices.quotas')).toBe(true);
        expect(res.capabilities.bugReports).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
        expect((res as any).features.futureBridge).toBeUndefined();
        expect((res as any).capabilities.futureCapability).toBeUndefined();
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
