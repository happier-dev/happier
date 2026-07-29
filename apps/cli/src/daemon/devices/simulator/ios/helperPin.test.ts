import { describe, expect, it } from 'vitest';

import {
    PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN,
    resolveIosSimulatorHelperPin,
} from './helperPin';

describe('iOS simulator helper digest pin', () => {
    it('pins the build-emitted signed/notarized manifest digest + version', () => {
        const pin = resolveIosSimulatorHelperPin({
            readManifest: () => ({
                status: 'pinned_signed_notarized_helper',
                helperDistribution: 'prebuilt-signed',
                version: '1.4.2',
                sha256: 'sha256:'.concat('a'.repeat(64)),
            }),
        });

        expect(pin).toEqual({
            version: '1.4.2',
            digest: `sha256:${'a'.repeat(64)}`,
        });
    });

    it('falls back to the fail-closed placeholder when no signed helper is vendored yet', () => {
        const pin = resolveIosSimulatorHelperPin({
            readManifest: () => ({
                status: 'blocked_missing_signed_notarized_helper',
                helperDistribution: 'development-build',
                version: '0.0.0-unavailable',
                sha256: null,
            }),
        });

        expect(pin).toEqual(PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN);
    });

    it('falls back to the placeholder when the manifest carries a placeholder all-zero digest', () => {
        const pin = resolveIosSimulatorHelperPin({
            readManifest: () => ({
                status: 'pinned_signed_notarized_helper',
                helperDistribution: 'prebuilt-signed',
                version: '1.0.0',
                sha256: `sha256:${'0'.repeat(64)}`,
            }),
        });

        expect(pin).toEqual(PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN);
    });

    it('falls back to the placeholder when the manifest is unreadable or malformed', () => {
        expect(resolveIosSimulatorHelperPin({
            readManifest: () => {
                throw new Error('manifest missing');
            },
        })).toEqual(PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN);

        expect(resolveIosSimulatorHelperPin({
            readManifest: () => ({ status: 'pinned_signed_notarized_helper', version: 42, sha256: 'nope' }),
        })).toEqual(PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN);
    });

    it('refuses a development-build manifest even when it carries a digest (production-only)', () => {
        const pin = resolveIosSimulatorHelperPin({
            readManifest: () => ({
                status: 'pinned_signed_notarized_helper',
                helperDistribution: 'development-build',
                version: '1.0.0-dev',
                sha256: `sha256:${'b'.repeat(64)}`,
            }),
        });

        expect(pin).toEqual(PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN);
    });
});
