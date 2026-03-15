import { describe, expect, it } from 'vitest';

import type { AppVariant } from '@/sync/runtime/appVariant';

import { resolveHappierCliNpmPackageSpecifier } from './happierCliInstallCommand';

describe('resolveHappierCliNpmPackageSpecifier', () => {
    it('uses @next for preview builds', () => {
        const appVariant: AppVariant = 'preview';
        expect(resolveHappierCliNpmPackageSpecifier({ appVariant })).toBe('@happier-dev/cli@next');
    });

    it('uses @next for development builds', () => {
        const appVariant: AppVariant = 'development';
        expect(resolveHappierCliNpmPackageSpecifier({ appVariant })).toBe('@happier-dev/cli@next');
    });

    it('uses untagged package for production builds', () => {
        const appVariant: AppVariant = 'production';
        expect(resolveHappierCliNpmPackageSpecifier({ appVariant })).toBe('@happier-dev/cli');
    });

    it('allows overriding the dist tag', () => {
        const appVariant: AppVariant = 'production';
        expect(resolveHappierCliNpmPackageSpecifier({ appVariant, distTagOverride: 'next' })).toBe('@happier-dev/cli@next');
        expect(resolveHappierCliNpmPackageSpecifier({ appVariant, distTagOverride: null })).toBe('@happier-dev/cli');
    });
});
