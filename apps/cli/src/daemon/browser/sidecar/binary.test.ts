import { describe, expect, it } from 'vitest';

describe('daemon browser sidecar binary resolution', () => {
    it('prefers managed browser candidates over system candidates by default', async () => {
        const mod = await import('./binary');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveSidecarBrowserBinary({
            platform: 'darwin',
            sourcePreference: 'managed-first',
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

        const result = mod.resolveSidecarBrowserBinary({
            platform: 'darwin',
            sourcePreference: 'managed-first',
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

    it('does not synthesize provenance for a candidate that lacks it', async () => {
        const mod = await import('./binary');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveSidecarBrowserBinary({
            platform: 'darwin',
            sourcePreference: 'managed-first',
            candidates: [{
                source: 'managedBrowserPackage',
                executablePath: '/Users/test/.happier/tools/browser-chromium/current/chrome',
                discoveryKind: 'managedRuntime',
                available: true,
            }],
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.provenance).toBeUndefined();
        }
    });

    it('fails closed on unsupported platforms before selecting a candidate', async () => {
        const mod = await import('./binary');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveSidecarBrowserBinary({
            platform: 'freebsd',
            sourcePreference: 'managed-first',
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

    it('rejects PATH-only system browser candidates instead of treating them as binary-safe', async () => {
        const mod = await import('./binary');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveSidecarBrowserBinary({
            platform: 'linux',
            sourcePreference: 'system-first',
            candidates: [{
                source: 'systemChrome',
                executablePath: '/usr/bin/google-chrome',
                discoveryKind: 'pathProbe',
                available: true,
            }],
        });

        expect(result).toMatchObject({
            ok: false,
            source: 'systemChrome',
            errorCode: 'system_browser_unavailable',
        });
        expect(JSON.stringify(result)).not.toContain('/usr/bin/google-chrome');
    });
});
