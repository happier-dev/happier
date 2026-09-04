import { describe, expect, it } from 'vitest';

import type { AppVariant } from '@/sync/runtime/appVariant';

import { buildHappierCliCommandName, buildHappierCliInstallCommand } from './happierCliInstallCommand';

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

    it('can install without the automatic setup handoff when a target-bound setup command follows', () => {
        expect(buildHappierCliInstallCommand({ appVariant: 'production', suppressAutomaticSetup: true }))
            .toBe('curl -fsSL https://happier.dev/install | bash -s -- --yes');
        expect(buildHappierCliInstallCommand({ appVariant: 'preview', suppressAutomaticSetup: true }))
            .toBe('curl -fsSL https://happier.dev/install | bash -s -- --channel preview --yes');
    });

    it('maps preview-like overrides to the preview installer channel', () => {
        const appVariant: AppVariant = 'production';
        expect(buildHappierCliInstallCommand({ appVariant, distTagOverride: 'next' })).toBe('curl -fsSL https://happier.dev/install | bash -s -- --channel preview');
        expect(buildHappierCliInstallCommand({ appVariant, distTagOverride: 'preview' })).toBe('curl -fsSL https://happier.dev/install | bash -s -- --channel preview');
        expect(buildHappierCliInstallCommand({ appVariant, distTagOverride: null })).toBe('curl -fsSL https://happier.dev/install | bash');
    });

    it('uses the preview CLI shim for preview-channel manual commands', () => {
        expect(buildHappierCliCommandName({ appVariant: 'preview' })).toBe('hprev');
        expect(buildHappierCliCommandName({ appVariant: 'development' })).toBe('hprev');
        expect(buildHappierCliCommandName({ appVariant: 'production', distTagOverride: 'next' })).toBe('hprev');
        expect(buildHappierCliCommandName({ appVariant: 'production' })).toBe('happier');
    });
});
