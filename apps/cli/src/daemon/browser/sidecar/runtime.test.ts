import { describe, expect, it } from 'vitest';

import * as runtime from './runtime';

describe('daemon browser sidecar runtime planning', () => {
    it('loads only selected extension directories for a persistent profile', () => {
        const input = {
            sidecarId: 'sidecar', nowMs: 2_000,
            profile: { profileId: 'personal', storageMode: 'user' as const, owner: { kind: 'user' as const, id: 'person' }, cleanupOnSessionClose: false },
            profileDirectory: '/profiles/personal',
            binaryResolution: { ok: true as const, source: 'managedBrowserPackage' as const,
                executablePath: '/managed/chrome', discoveryKind: 'managedRuntime' as const, diagnostics: [] },
            extensionDirectories: ['/profiles/personal/extensions/a', '/profiles/personal/extensions/b'],
        };
        const plan = runtime.createSidecarLaunchPlan(input);
        expect(plan.publicResult.accepted).toBe(true);
        expect(plan.privateLaunch?.cleanupOnStop).toBe(false);
        expect(plan.privateLaunch?.args).toEqual(expect.arrayContaining([
            '--load-extension=/profiles/personal/extensions/a,/profiles/personal/extensions/b',
            '--disable-extensions-except=/profiles/personal/extensions/a,/profiles/personal/extensions/b',
        ]));
        expect(JSON.stringify(plan.publicResult)).not.toContain('/extensions/');
        const ephemeral = runtime.createSidecarLaunchPlan({ ...input,
            profile: { profileId: 'temporary', storageMode: 'ephemeral', owner: { kind: 'session', id: 'session' }, cleanupOnSessionClose: true } });
        expect(ephemeral.privateLaunch?.args.some(arg => arg.startsWith('--load-extension=') || arg.startsWith('--disable-extensions-except='))).toBe(false);
    });

    it('plans the already admitted source without replaying its feature decision', async () => {
        const mod = runtime;

        expect(mod).not.toBeNull();
        if (!mod) return;

        const plan = mod.createSidecarLaunchPlan({
            sidecarId: 'sidecar_1',
            nowMs: 2_000,
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
            state: 'ready',
        });
        expect(plan.privateLaunch).not.toBeNull();
        expect(JSON.stringify(plan.publicResult)).not.toContain('/managed/chrome');
    });

    it('creates a spawn-free private launch plan from managed binary and ephemeral profile inputs', async () => {
        const mod = runtime;

        expect(mod).not.toBeNull();
        if (!mod) return;

        const plan = mod.createSidecarLaunchPlan({
            sidecarId: 'sidecar_1',
            nowMs: 2_000,
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
                '--headless=new',
                '--user-data-dir=/tmp/happier/browser/profile_1',
                '--remote-debugging-pipe',
            ]),
            cleanupOnStop: true,
        });
    });
});
