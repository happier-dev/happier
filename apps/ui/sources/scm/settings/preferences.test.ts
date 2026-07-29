import { describe, expect, it } from 'vitest';

import {
    buildScmGitRepoBackendPreferenceSettingsDelta,
    normalizeScmBackendQualifiedId,
    resolveScmGitRepoPreferredBackendId,
} from './preferences';

describe('SCM backend preferences', () => {
    it('resolves a legacy-only preference through the first-party identity owner', () => {
        expect(resolveScmGitRepoPreferredBackendId({
            legacyPreference: 'sapling',
            qualifiedPreference: null,
        })).toBe('happier.scm.backend.sapling/sapling');
    });

    it('prefers a valid qualified contribution and falls back from invalid qualified data', () => {
        expect(resolveScmGitRepoPreferredBackendId({
            legacyPreference: 'git',
            qualifiedPreference: 'acme.scm/stacked',
        })).toBe('acme.scm/stacked');
        expect(resolveScmGitRepoPreferredBackendId({
            legacyPreference: 'sapling',
            qualifiedPreference: 'stacked',
        })).toBe('happier.scm.backend.sapling/sapling');
    });

    it('preserves local-id slashes while rejecting unqualified and over-bounded ids', () => {
        expect(normalizeScmBackendQualifiedId(' acme.scm/stacked/branch ')).toBe('acme.scm/stacked/branch');
        expect(normalizeScmBackendQualifiedId('stacked')).toBeNull();
        expect(normalizeScmBackendQualifiedId(`acme.scm/${'a'.repeat(248)}`)).toBeNull();
    });

    it('writes novel selections only to the qualified field', () => {
        expect(buildScmGitRepoBackendPreferenceSettingsDelta('acme.scm/stacked')).toEqual({
            scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
        });
    });

    it('atomically clears qualified state when selecting a built-in backend', () => {
        expect(buildScmGitRepoBackendPreferenceSettingsDelta(
            'happier.scm.backend.sapling/sapling',
        )).toEqual({
            scmGitRepoPreferredBackend: 'sapling',
            scmGitRepoPreferredBackendQualifiedId: null,
        });
    });
});
