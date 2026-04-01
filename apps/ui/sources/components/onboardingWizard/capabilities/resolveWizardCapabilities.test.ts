import { afterEach, describe, expect, it, vi } from 'vitest';

async function importFresh() {
    vi.resetModules();
    return await import('./resolveWizardCapabilities');
}

describe('resolveWizardCapabilities', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    afterEach(() => {
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
});
