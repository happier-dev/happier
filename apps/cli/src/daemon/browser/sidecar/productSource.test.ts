import { describe, expect, it, vi } from 'vitest';

import type { SidecarBrowserBinaryCandidate } from './binary';

const MANAGED_PROVENANCE = {
    origin: 'managed_package' as const,
    pinnedVersion: '127.0.6533.88',
    channel: 'stable' as const,
    integrityDigest: `sha256:${'a'.repeat(64)}`,
    license: 'BSD-3-Clause',
};

function managedCandidate(): SidecarBrowserBinaryCandidate {
    return {
        source: 'managedBrowserPackage',
        executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
        discoveryKind: 'managedRuntime',
        available: true,
        provenance: MANAGED_PROVENANCE,
    };
}

describe('browser sidecar product source owner', () => {
    it('fails closed with a typed blocker when no managed or packaged Browser executable is registered', async () => {
        const mod = await import('./productSource');

        expect(mod?.resolveProductBrowserSidecarBinary).toBeTypeOf('function');
        if (!mod?.resolveProductBrowserSidecarBinary) return;

        const result = mod.resolveProductBrowserSidecarBinary({
            platform: 'darwin',
            candidates: [],
        });

        expect(result).toMatchObject({
            ok: false,
            source: 'managedBrowserPackage',
            errorCode: 'managed_package_missing',
            disabledReason: 'No source-backed managed or packaged Browser sidecar executable is registered.',
        });
    });

    it('does not promote system browser candidates into the product sidecar source', async () => {
        const mod = await import('./productSource');

        expect(mod?.resolveProductBrowserSidecarBinary).toBeTypeOf('function');
        if (!mod?.resolveProductBrowserSidecarBinary) return;

        const result = mod.resolveProductBrowserSidecarBinary({
            platform: 'darwin',
            candidates: [{
                source: 'systemChrome',
                executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                discoveryKind: 'systemRegistry',
                available: true,
            }],
        });

        expect(result).toMatchObject({
            ok: false,
            source: 'managedBrowserPackage',
            errorCode: 'managed_package_missing',
        });
        expect(JSON.stringify(result)).not.toContain('Google Chrome');
    });

    it('narrows the product whitelist to managedBrowserPackage only (rejects CfT/Playwright/Electron)', async () => {
        const mod = await import('./productSource');

        expect(mod?.resolveProductBrowserSidecarBinary).toBeTypeOf('function');
        if (!mod?.resolveProductBrowserSidecarBinary) return;

        for (const source of ['chromeForTesting', 'playwrightChromium', 'electronChromium'] as const) {
            const result = mod.resolveProductBrowserSidecarBinary({
                platform: 'linux',
                candidates: [{
                    source,
                    executablePath: `/some/${source}/chrome`,
                    discoveryKind: 'managedRuntime',
                    available: true,
                }],
            });
            expect(result).toMatchObject({
                ok: false,
                source: 'managedBrowserPackage',
                errorCode: 'managed_package_missing',
            });
        }
    });

    it('resolves ok for a managed provenance-verified candidate and delegates to the launch owner', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const launchOwnerAdapter = {
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: () => false,
                supportsOpenView: () => false,
                dispatchCommand: vi.fn(),
            },
            dispose: vi.fn(),
        };
        const launchOwnerFactory = vi.fn((_input: unknown) => async () => launchOwnerAdapter);
        const resolveCandidate = vi.fn(async () => managedCandidate());

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            browserUseAllowed: true,
            resolveManagedCandidate: resolveCandidate,
            createLaunchOwnerFactory: launchOwnerFactory,
        });

        const result = await factory({ machineId: 'machine_product' });

        expect(result.ok).toBe(true);
        expect(resolveCandidate).toHaveBeenCalledOnce();
        expect(launchOwnerFactory).toHaveBeenCalledOnce();
        // The launch owner receives a digest-verified managed binary resolution.
        const launchInput = launchOwnerFactory.mock.calls[0]?.[0] as { featureEnabled: boolean; binaryResolution: { ok: boolean; source: string; provenance?: unknown } };
        expect(launchInput.binaryResolution.ok).toBe(true);
        expect(launchInput.binaryResolution.source).toBe('managedBrowserPackage');
        expect(launchInput.binaryResolution.provenance).toMatchObject({ origin: 'managed_package' });
        // The resolved server sidecar decision is threaded through to the launch owner.
        expect(launchInput.featureEnabled).toBe(true);
    });

    it('passes the resolved server sidecar decision through to the launch owner', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const launchOwnerAdapter = {
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: () => false,
                supportsOpenView: () => false,
                dispatchCommand: vi.fn(),
            },
            dispose: vi.fn(),
        };
        const launchOwnerFactory = vi.fn((_input: unknown) => async () => launchOwnerAdapter);

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            // Server-disabled `browser.sidecar` decision threaded from the daemon startup gate.
            featureEnabled: false,
            browserUseAllowed: true,
            resolveManagedCandidate: vi.fn(async () => managedCandidate()),
            createLaunchOwnerFactory: launchOwnerFactory,
        });

        await factory({ machineId: 'machine_disabled' });

        expect(launchOwnerFactory).toHaveBeenCalledOnce();
        const launchInput = launchOwnerFactory.mock.calls[0]?.[0] as { featureEnabled: boolean };
        // The launch plan rejects featureEnabled:false (sidecar/runtime.ts); the hard-coded `true`
        // bypass is gone.
        expect(launchInput.featureEnabled).toBe(false);
    });

    it('fails closed before launch when browser use is denied by product policy', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const launchOwnerFactory = vi.fn((_input: unknown) => async () => ({
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: () => false,
                supportsOpenView: () => false,
                dispatchCommand: vi.fn(),
            },
            dispose: vi.fn(),
        }));
        const params = {
            platform: 'linux',
            featureEnabled: true,
            browserUseAllowed: false,
            resolveManagedCandidate: vi.fn(async () => managedCandidate()),
            createLaunchOwnerFactory: launchOwnerFactory,
        } satisfies Parameters<typeof mod.createProductBrowserSidecarControlAdapterFactory>[0] & Readonly<{
            browserUseAllowed: boolean;
        }>;
        const factory = mod.createProductBrowserSidecarControlAdapterFactory(params);

        const result = await factory({ machineId: 'machine_policy_denied' });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'browser_policy_denied',
            disabledReason: 'browser use denied by policy',
        });
        expect(launchOwnerFactory).not.toHaveBeenCalled();
    });

    it('stays fail-closed when no managed candidate is installed', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const launchOwnerFactory = vi.fn(() => async () => ({ ok: true as const, adapter: {} as never }));
        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            browserUseAllowed: true,
            resolveManagedCandidate: vi.fn(async () => null),
            createLaunchOwnerFactory: launchOwnerFactory,
        });

        const result = await factory({ machineId: 'machine_missing' });

        expect(result).toMatchObject({ ok: false, errorCode: 'managed_package_missing' });
        expect(launchOwnerFactory).not.toHaveBeenCalled();
    });

    // MCH-2: lazy-install trigger — a supported, digest-pinned platform whose artifact is missing
    // (available:false) installs once, then re-resolves to the freshly-installed candidate.
    it('lazily installs the managed binary when missing then re-resolves and delegates to launch', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const launchOwnerAdapter = {
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: () => false,
                supportsOpenView: () => false,
                dispatchCommand: vi.fn(),
            },
            dispose: vi.fn(),
        };
        const launchOwnerFactory = vi.fn((_input: unknown) => async () => launchOwnerAdapter);

        const missingThenInstalled = vi
            .fn()
            .mockResolvedValueOnce({
                source: 'managedBrowserPackage' as const,
                discoveryKind: 'managedRuntime' as const,
                available: false as const,
                disabledReason: 'not installed',
            })
            .mockResolvedValueOnce(managedCandidate());
        const installManagedBrowserChromium = vi.fn(async () => ({
            ok: true as const,
            executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
            pinnedVersion: '127.0.6533.88',
            integrityDigest: `sha256:${'a'.repeat(64)}`,
        }));

        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            browserUseAllowed: true,
            resolveManagedCandidate: missingThenInstalled,
            createLaunchOwnerFactory: launchOwnerFactory,
            installManagedBrowserChromium,
        });

        const result = await factory({ machineId: 'machine_lazy' });

        expect(installManagedBrowserChromium).toHaveBeenCalledOnce();
        expect(missingThenInstalled).toHaveBeenCalledTimes(2);
        expect(result.ok).toBe(true);
        expect(launchOwnerFactory).toHaveBeenCalledOnce();
    });

    it('does not lazily install when autoInstallWhenMissing is disabled', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const installManagedBrowserChromium = vi.fn(async () => ({ ok: true as const, executablePath: '/x', pinnedVersion: '1.2.3.4', integrityDigest: `sha256:${'a'.repeat(64)}` }));
        const launchOwnerFactory = vi.fn(() => async () => ({ ok: true as const, adapter: {} as never }));
        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            browserUseAllowed: true,
            autoInstallWhenMissing: false,
            resolveManagedCandidate: vi.fn(async () => ({
                source: 'managedBrowserPackage' as const,
                discoveryKind: 'managedRuntime' as const,
                available: false as const,
                disabledReason: 'not installed',
            })),
            createLaunchOwnerFactory: launchOwnerFactory,
            installManagedBrowserChromium,
        });

        const result = await factory({ machineId: 'machine_no_lazy' });

        expect(installManagedBrowserChromium).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, errorCode: 'managed_package_missing' });
        expect(launchOwnerFactory).not.toHaveBeenCalled();
    });

    it('stays fail-closed when a managed candidate lacks provenance (never delegates to launch)', async () => {
        const mod = await import('./productSource');

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        const launchOwnerFactory = vi.fn(() => async () => ({ ok: true as const, adapter: {} as never }));
        const factory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            featureEnabled: true,
            browserUseAllowed: true,
            resolveManagedCandidate: vi.fn(async () => ({
                source: 'managedBrowserPackage' as const,
                executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
                discoveryKind: 'managedRuntime' as const,
                available: true,
            })),
            createLaunchOwnerFactory: launchOwnerFactory,
        });

        const result = await factory({ machineId: 'machine_no_provenance' });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe('binary_resolution_failed');
        }
        expect(launchOwnerFactory).not.toHaveBeenCalled();
    });
});
