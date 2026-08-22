import { describe, expect, it } from 'vitest';

import {
    areRunnerManagedProviderRetainedAuthoritiesEqual,
    mergeRunnerManagedDependencyRetentionV1,
    RunnerManagedProviderRetainedAuthorityV1Schema,
} from './runnerManagedDependencyRetention';

const bundledAuthority = Object.freeze({
    pluginId: 'acme.provider',
    immutableGenerationId: 'provider-generation-p',
    manifestAuthority: 'bundled_first_party' as const,
    hardRevocationRevisionAtAdmission: 7,
});

describe('Runner managed Provider retained authority', () => {
    it('strictly requires and preserves the private Provider source class', () => {
        expect(
            RunnerManagedProviderRetainedAuthorityV1Schema.safeParse({
                pluginId: bundledAuthority.pluginId,
                immutableGenerationId:
                    bundledAuthority.immutableGenerationId,
                hardRevocationRevisionAtAdmission:
                    bundledAuthority.hardRevocationRevisionAtAdmission,
            }).success,
        ).toBe(false);
        expect(
            RunnerManagedProviderRetainedAuthorityV1Schema.parse(
                bundledAuthority,
            ),
        ).toEqual(bundledAuthority);
        expect(mergeRunnerManagedDependencyRetentionV1({
            v: 1,
            adoptedManagedProviderAuthority: bundledAuthority,
            sourceGenerationIds: [],
            qualifiedDependencyIds: [],
        }).adoptedManagedProviderAuthority).toEqual(bundledAuthority);
    });

    it('treats differing Provider source classes as different authorities', () => {
        expect(areRunnerManagedProviderRetainedAuthoritiesEqual(
            bundledAuthority,
            {
                ...bundledAuthority,
                manifestAuthority: 'external',
            },
        )).toBe(false);
        expect(() => mergeRunnerManagedDependencyRetentionV1(
            {
                v: 1,
                adoptedManagedProviderAuthority: bundledAuthority,
                sourceGenerationIds: [],
                qualifiedDependencyIds: [],
            },
            {
                v: 1,
                adoptedManagedProviderAuthority: {
                    ...bundledAuthority,
                    manifestAuthority: 'external',
                },
                sourceGenerationIds: [],
                qualifiedDependencyIds: [],
            },
        )).toThrow(
            'Runner retention cannot merge competing adopted Provider authorities',
        );
    });
});
