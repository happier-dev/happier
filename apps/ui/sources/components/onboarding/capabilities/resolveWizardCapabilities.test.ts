import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeSshAvailabilityMock = vi.hoisted(() => ({
    available: false,
}));

vi.mock('@happier-dev/ssh-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/ssh-native')>();
    return {
        ...actual,
        getNativeSshAvailability: () => nativeSshAvailabilityMock.available
            ? {
                available: true as const,
                platform: 'ios' as const,
                engine: 'libssh2' as const,
                moduleVersion: 'test',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: true,
            }
            : {
                available: false as const,
                reason: 'native-module-missing' as const,
            },
    };
});

async function importFresh() {
    vi.resetModules();
    return await import('./resolveWizardCapabilities');
}

describe('resolveWizardCapabilities', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    afterEach(() => {
        nativeSshAvailabilityMock.available = false;
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
    });

    it('disables remote SSH relay choice when denied by build policy', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowRemoteSshRelayHost';
        const mod = await importFresh();

        const caps = mod.resolveWizardCapabilities({ platform: 'desktop', isDesktopShell: true });
        expect(caps.allowRemoteSshRelayChoice).toBe(false);
    });

    it('allows remote SSH relay choice by default on desktop shell', async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        const mod = await importFresh();

        const caps = mod.resolveWizardCapabilities({ platform: 'desktop', isDesktopShell: true });
        expect(caps.allowRemoteSshRelayChoice).toBe(true);
    });

    it('fails native SSH machine setup closed when the runtime module is unavailable', async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        nativeSshAvailabilityMock.available = false;
        const mod = await importFresh();

        const caps = mod.resolveWizardCapabilities({ platform: 'native', isDesktopShell: false });
        expect(caps.allowNativeSshMachineSetup).toBe(false);
    });

    it('allows native SSH machine setup only when runtime availability and policy both allow it', async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        nativeSshAvailabilityMock.available = true;
        const allowedModule = await importFresh();
        expect(allowedModule.resolveWizardCapabilities({ platform: 'native', isDesktopShell: false }).allowNativeSshMachineSetup).toBe(true);

        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.machine.allowRemoteSshMachineSetup';
        const deniedModule = await importFresh();
        expect(deniedModule.resolveWizardCapabilities({ platform: 'native', isDesktopShell: false }).allowNativeSshMachineSetup).toBe(false);
    });
});
