import { describe, expect, it } from 'vitest';

import type { AppVariant } from '@/sync/runtime/appVariant';

import {
    buildHappierCliInstallAndRunCommand,
    buildHappierCliInstallAndRunPowershellCommand,
    buildHappierCliInstallCommand,
    buildHappierCliInstallPowershellCommand,
} from './happierCliInstallCommand';

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

    it('supports installing the dev channel when a public release ring override is provided', () => {
        const appVariant: AppVariant = 'production';
        expect(buildHappierCliInstallCommand({ appVariant, publicReleaseRingOverride: 'publicdev' })).toBe(
            'curl -fsSL https://happier.dev/install | bash -s -- --channel dev',
        );
    });
});

describe('buildHappierCliInstallAndRunCommand', () => {
    it('builds a stable-channel setup-relay one-liner for production builds', () => {
        const appVariant: AppVariant = 'production';
        expect(buildHappierCliInstallAndRunCommand({ appVariant }, { action: 'setup-relay' })).toBe(
            'curl -fsSL https://happier.dev/install | bash -s -- --setup-relay',
        );
    });

    it('includes the dev channel when a public release ring override is provided', () => {
        const appVariant: AppVariant = 'production';
        expect(buildHappierCliInstallAndRunCommand({ appVariant, publicReleaseRingOverride: 'publicdev' }, { action: 'setup-relay' })).toBe(
            'curl -fsSL https://happier.dev/install | bash -s -- --channel dev --setup-relay',
        );
    });

    it('includes setup arguments after a -- delimiter for setup actions', () => {
        const appVariant: AppVariant = 'preview';
        expect(buildHappierCliInstallAndRunCommand(
            { appVariant },
            { action: 'setup', args: ['--relay-url', 'https://relay.example.test', '--skip-providers', '--yes'] },
        )).toBe(
            'curl -fsSL https://happier.dev/install | bash -s -- --channel preview --run setup -- --relay-url https://relay.example.test --skip-providers --yes',
        );
    });

    it('supports whitelisted non-setup run actions', () => {
        const appVariant: AppVariant = 'preview';
        expect(buildHappierCliInstallAndRunCommand(
            { appVariant },
            { action: 'auth-login', args: ['--server-url', 'https://relay.example.test', '--persist'] },
        )).toBe(
            'curl -fsSL https://happier.dev/install | bash -s -- --channel preview --run auth-login -- --server-url https://relay.example.test --persist',
        );
    });
});

describe('buildHappierCliInstallPowershellCommand', () => {
    it('builds a stable-channel PowerShell installer command for production builds', () => {
        const appVariant: AppVariant = 'production';
        expect(buildHappierCliInstallPowershellCommand({ appVariant })).toBe(
            '& ([ScriptBlock]::Create((irm https://happier.dev/install.ps1)))',
        );
    });

    it('includes the preview channel on PowerShell installer commands for preview builds', () => {
        const appVariant: AppVariant = 'preview';
        expect(buildHappierCliInstallPowershellCommand({ appVariant })).toBe(
            '& ([ScriptBlock]::Create((irm https://happier.dev/install.ps1))) -Channel preview',
        );
    });
});

describe('buildHappierCliInstallAndRunPowershellCommand', () => {
    it('builds a setup-relay one-liner using the -SetupRelay switch', () => {
        const appVariant: AppVariant = 'production';
        expect(buildHappierCliInstallAndRunPowershellCommand({ appVariant }, { action: 'setup-relay' })).toBe(
            '& ([ScriptBlock]::Create((irm https://happier.dev/install.ps1))) -SetupRelay',
        );
    });

    it('passes setup args as trailing arguments (no -- delimiter)', () => {
        const appVariant: AppVariant = 'preview';
        expect(buildHappierCliInstallAndRunPowershellCommand(
            { appVariant },
            { action: 'setup', args: ['--relay-url', 'https://relay.example.test', '--skip-providers', '--yes'] },
        )).toBe(
            '& ([ScriptBlock]::Create((irm https://happier.dev/install.ps1))) -Channel preview -Run setup --relay-url https://relay.example.test --skip-providers --yes',
        );
    });
});
