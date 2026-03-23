import { describe, expect, it } from 'vitest';

import type { AppVariant } from '@/sync/runtime/appVariant';

import { buildHappierCliInstallCommand } from './happierCliInstallCommand';

describe('buildHappierCliInstallCommand', () => {
    it('uses the preview installer command for preview builds', () => {
        const appVariant: AppVariant = 'preview';
        expect(buildHappierCliInstallCommand({ appVariant })).toBe('curl -fsSL https://happier.dev/install | bash -s -- --channel preview');
    });

    it('uses the preview installer command for development builds', () => {
        const appVariant: AppVariant = 'development';
        expect(buildHappierCliInstallCommand({ appVariant })).toBe('curl -fsSL https://happier.dev/install | bash -s -- --channel preview');
    });

    it('uses the stable installer command for production builds', () => {
        const appVariant: AppVariant = 'production';
        expect(buildHappierCliInstallCommand({ appVariant })).toBe('curl -fsSL https://happier.dev/install | bash');
    });

    it('maps preview-like overrides to the preview installer channel', () => {
        const appVariant: AppVariant = 'production';
        expect(buildHappierCliInstallCommand({ appVariant, distTagOverride: 'next' })).toBe('curl -fsSL https://happier.dev/install | bash -s -- --channel preview');
        expect(buildHappierCliInstallCommand({ appVariant, distTagOverride: 'preview' })).toBe('curl -fsSL https://happier.dev/install | bash -s -- --channel preview');
        expect(buildHappierCliInstallCommand({ appVariant, distTagOverride: null })).toBe('curl -fsSL https://happier.dev/install | bash');
    });
});
