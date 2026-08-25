import { describe, expect, it } from 'vitest';

describe('daemon browser sidecar runtime planning', () => {
    it('fails closed when the browser.sidecar feature gate is disabled', async () => {
        const mod = await import('./runtime');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const plan = mod.createSidecarLaunchPlan({
            sidecarId: 'sidecar_1',
            nowMs: 2_000,
            featureEnabled: false,
            allowPersistentProfiles: false,
            profile: {
                profileId: 'profile_1',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'session_1' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_1',
            binaryResolution: {
                ok: true,
                source: 'managedBrowserPackage',
                executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime',
                diagnostics: [],
            },
        });

        expect(plan.publicResult).toMatchObject({
            v: 1,
            accepted: false,
            state: 'unavailable',
            errorCode: 'feature_disabled',
        });
        expect(plan.privateLaunch).toBeNull();
        expect(JSON.stringify(plan.publicResult)).not.toContain('/managed/chrome');
    });

    it('creates a spawn-free private launch plan from managed binary and ephemeral profile inputs', async () => {
        const mod = await import('./runtime');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const plan = mod.createSidecarLaunchPlan({
            sidecarId: 'sidecar_1',
            nowMs: 2_000,
            featureEnabled: true,
            allowPersistentProfiles: false,
            profile: {
                profileId: 'profile_1',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'session_1' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_1',
            binaryResolution: {
                ok: true,
                source: 'managedBrowserPackage',
                executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime',
                diagnostics: [],
            },
        });

        expect(plan.publicResult).toMatchObject({
            v: 1,
            accepted: true,
            sidecarId: 'sidecar_1',
            state: 'ready',
            profileBinding: {
                profileId: 'profile_1',
                storageMode: 'ephemeral',
                ownerKind: 'session',
                ownerId: 'session_1',
            },
        });
        expect(JSON.stringify(plan.publicResult)).not.toContain('/managed/chrome');
        expect(plan.privateLaunch).toMatchObject({
            executablePath: '/managed/chrome',
            args: expect.arrayContaining([
                '--user-data-dir=/tmp/happier/browser/profile_1',
                '--remote-debugging-port=0',
            ]),
            cleanupOnStop: true,
        });
    });
});
