import { describe, expect, it } from 'vitest';

const provenance = { origin: 'managed_package' as const, pinnedVersion: '127.0.6533.88',
    channel: 'stable' as const, integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' };

describe('daemon browser sidecar binary resolution', () => {
    it('exposes only the managed product resolver, without a generic source chooser', async () => {
        const mod = await import('./binary');
        expect(mod).not.toHaveProperty('resolveSidecarBrowserBinary');
    });
    it('admits product provenance at the binary owner rather than its launch consumer', async () => {
        const { resolveProductBrowserSidecarBinary } = await import('./binary');
        expect(resolveProductBrowserSidecarBinary({ platform: 'linux', candidates: [{
            source: 'managedBrowserPackage', discoveryKind: 'managedRuntime', available: true,
            executablePath: '/fixture/managed-chromium',
        }] })).toMatchObject({ ok: false, errorCode: 'binary_resolution_failed' });
    });

    it('selects only the managed product candidate even when a system browser is available', async () => {
        const mod = await import('./binary');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveProductBrowserSidecarBinary({
            platform: 'darwin',
            candidates: [
                {
                    source: 'systemChrome',
                    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    discoveryKind: 'systemRegistry',
                    available: true,
                },
                {
                    source: 'managedBrowserPackage',
                    executablePath: '/Users/test/.happier/tools/browser/current/chrome',
                    discoveryKind: 'managedRuntime',
                    available: true,
                    provenance,
                },
            ],
        });

        expect(result).toMatchObject({
            ok: true,
            source: 'managedBrowserPackage',
            executablePath: '/Users/test/.happier/tools/browser/current/chrome',
        });
    });

    it('threads managed provenance through into a successful resolution', async () => {
        const mod = await import('./binary');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const provenance = {
            origin: 'managed_package' as const,
            pinnedVersion: '127.0.6533.88',
            channel: 'stable' as const,
            integrityDigest: `sha256:${'a'.repeat(64)}`,
            license: 'BSD-3-Clause',
        };

        const result = mod.resolveProductBrowserSidecarBinary({
            platform: 'darwin',
            candidates: [{
                source: 'managedBrowserPackage',
                executablePath: '/Users/test/.happier/tools/browser-chromium/current/chrome',
                discoveryKind: 'managedRuntime',
                available: true,
                provenance,
            }],
        });

        expect(result).toMatchObject({
            ok: true,
            source: 'managedBrowserPackage',
            provenance,
        });
    });

    it('fails closed on unsupported platforms before selecting a candidate', async () => {
        const mod = await import('./binary');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveProductBrowserSidecarBinary({
            platform: 'freebsd',
            candidates: [{
                source: 'managedBrowserPackage',
                executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime',
                available: true,
            }],
        });

        expect(result).toMatchObject({
            ok: false,
            source: 'unsupported',
            errorCode: 'unsupported_platform',
        });
    });

    it.each(['pathProbe', 'systemRegistry', 'explicitUserConfig'] as const)('refuses a system browser discovered by %s without a managed product source', async discoveryKind => {
        const mod = await import('./binary');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveProductBrowserSidecarBinary({
            platform: 'linux',
            candidates: [{
                source: 'systemChrome',
                executablePath: '/usr/bin/google-chrome',
                discoveryKind,
                available: true,
            }],
        });

        expect(result).toMatchObject({
            ok: false,
            source: 'managedBrowserPackage',
            errorCode: 'managed_package_missing',
        });
        expect(JSON.stringify(result)).not.toContain('/usr/bin/google-chrome');
    });
});
