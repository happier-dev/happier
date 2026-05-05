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

    it('exposes Live Activity direct APNs diagnostics without APNs credential material', () => {
        const privateKey = '-----BEGIN PRIVATE KEY-----\nSECRET-PRIVATE-KEY\n-----END PRIVATE KEY-----';
        const res = resolveServerFeaturePayload({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: '1',
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'direct_apns',
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'TEAMID1234',
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: privateKey,
        } as NodeJS.ProcessEnv, serverFeatureRegistry);

        const directDiagnostics = res.capabilities.liveActivities.remoteUpdates.modes.direct_apns;
        expect(directDiagnostics.available).toBe(false);
        expect(directDiagnostics.configurationDiagnostics).toContain('apns_key_id_missing');
        expect(directDiagnostics.configurationDiagnostics).toContain('apns_bundle_id_allowlist_missing');
        expect(JSON.stringify(res)).not.toContain('SECRET-PRIVATE-KEY');
        expect(JSON.stringify(res)).not.toContain(privateKey);
    });
});
