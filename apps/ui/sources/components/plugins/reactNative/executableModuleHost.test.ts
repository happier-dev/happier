import { describe, expect, it, vi } from 'vitest';

import { createPluginReactNativeBundleCache } from './bundleCache';
import { createPluginUiExecutableModuleHost } from './executableModuleHost';
import type { PluginReactNativeExecutableExport, PluginReactNativeLoaderBackend } from './loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { log } from '@/log';

const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
    pluginId: 'acme.preview',
    contributionId: 'client-runtime',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    platform: 'web',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 12,
});

const moduleReference = Object.freeze({
    containerName: 'acme_preview_client_runtime',
    modulePath: './clientRuntime',
    exportName: 'activateClientRuntime',
});

const authority = Object.freeze({
    serverId: 'server-1',
    machineId: 'machine-1',
    projectionGeneration: 12,
});

function cacheWithIdentity(inputIdentity = identity) {
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity: inputIdentity,
        bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        format: 'plainJs',
    });
    return cache;
}

function backend(exported: PluginReactNativeExecutableExport): PluginReactNativeLoaderBackend {
    return Object.freeze({
        backendId: 'reactNativeWebModule',
        available: true,
        loadInstalledBundle: vi.fn(async () => exported),
    });
}

describe('PluginUiExecutableModuleHost', () => {
    it('fails closed until the canonical projection owner establishes a generation', async () => {
        const createScope = vi.fn(() => ({ api: Object.freeze({}), commit: vi.fn(), unwind: vi.fn() }));
        const host = createPluginUiExecutableModuleHost();

        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(vi.fn()),
            hostPlatform: 'web',
            authority,
            createScope,
        })).resolves.toEqual({
            ok: false,
            code: 'stale_projection_generation',
            diagnostics: ['projection_authority_not_initialized'],
        });
        expect(createScope).not.toHaveBeenCalled();
    });

    it('activates a named export with an opaque host API and unwinds it on disable', async () => {
        const api = Object.freeze({ registrationFamily: 'fixture' });
        const cleanup = vi.fn();
        const activate = vi.fn(async (receivedApi: unknown) => {
            expect(receivedApi).toBe(api);
            return cleanup;
        });
        const commit = vi.fn();
        const unwind = vi.fn();
        const host = createPluginUiExecutableModuleHost();

        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api, commit, unwind }),
        })).resolves.toEqual({ ok: true });

        expect(activate).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(unwind).not.toHaveBeenCalled();

        await host.invalidatePlugin(identity.pluginId);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(unwind).toHaveBeenCalledTimes(1);
    });

    it('unwinds staged registrations when activation rejects and preserves the prior active export', async () => {
        const firstCleanup = vi.fn();
        const firstUnwind = vi.fn();
        const failedUnwind = vi.fn();
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);

        await expect(host.activate({
            cache: cacheWithIdentity({
                ...identity,
                artifactDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            }),
            identity: {
                ...identity,
                artifactDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            },
            moduleReference,
            backend: backend(async () => firstCleanup),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind: firstUnwind }),
        })).resolves.toEqual({ ok: true });

        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(async () => { throw new Error('activation rejected'); }),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind: failedUnwind }),
        })).resolves.toEqual({
            ok: false,
            code: 'activation_failed',
            diagnostics: ['activation_failed'],
        });

        expect(failedUnwind).toHaveBeenCalledTimes(1);
        expect(firstCleanup).not.toHaveBeenCalled();
        expect(firstUnwind).not.toHaveBeenCalled();

        await host.unload();
        expect(firstCleanup).toHaveBeenCalledTimes(1);
        expect(firstUnwind).toHaveBeenCalledTimes(1);
    });

    it('contains activation-scope construction failures without publishing authority', async () => {
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);

        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(vi.fn()),
            hostPlatform: 'web',
            authority,
            createScope: () => { throw new Error('scope unavailable'); },
        })).resolves.toEqual({
            ok: false,
            code: 'activation_failed',
            diagnostics: ['activation_failed'],
        });
    });

    it('rejects malformed exports and wrong-platform artifacts before creating activation authority', async () => {
        const createScope = vi.fn(() => ({ api: Object.freeze({}), commit: vi.fn(), unwind: vi.fn() }));
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);

        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: {
                backendId: 'reactNativeWebModule',
                available: true,
                loadInstalledBundle: vi.fn(async () => 42 as never),
            },
            hostPlatform: 'web',
            authority,
            createScope,
        })).resolves.toMatchObject({ ok: false, code: 'invalid_executable_export' });

        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(vi.fn()),
            hostPlatform: 'ios',
            authority,
            createScope,
        })).resolves.toMatchObject({ ok: false, code: 'platform_mismatch' });

        expect(createScope).not.toHaveBeenCalled();
    });

    it('contains loader instantiation failures before creating activation authority', async () => {
        const createScope = vi.fn(() => ({ api: Object.freeze({}), commit: vi.fn(), unwind: vi.fn() }));
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);

        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: {
                backendId: 'reactNativeWebModule',
                available: true,
                loadInstalledBundle: vi.fn(async () => { throw new Error('module instantiation failed'); }),
            },
            hostPlatform: 'web',
            authority,
            createScope,
        })).resolves.toEqual({
            ok: false,
            code: 'activation_failed',
            diagnostics: ['activation_failed'],
        });
        expect(createScope).not.toHaveBeenCalled();
    });

    it('retires active authority on projection-generation replacement and rejects a late stale activation', async () => {
        const cleanup = vi.fn();
        const unwind = vi.fn();
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(async () => cleanup),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind }),
        })).resolves.toEqual({ ok: true });

        await host.replaceAuthority({ ...authority, projectionGeneration: 13 });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(unwind).toHaveBeenCalledTimes(1);

        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(vi.fn()),
            hostPlatform: 'web',
            authority,
            createScope: vi.fn(() => ({ api: Object.freeze({}), commit: vi.fn(), unwind: vi.fn() })),
        })).resolves.toEqual({
            ok: false,
            code: 'stale_projection_generation',
            diagnostics: ['stale_projection_generation'],
        });
    });

    it('unwinds an activation whose commit completes after its projection generation was replaced', async () => {
        let resolveCommit: (() => void) | undefined;
        let markCommitStarted: (() => void) | undefined;
        const commitStarted = new Promise<void>((resolve) => {
            markCommitStarted = resolve;
        });
        const commit = vi.fn(() => {
            markCommitStarted?.();
            return new Promise<void>((resolve) => {
                resolveCommit = resolve;
            });
        });
        const cleanup = vi.fn();
        const unwind = vi.fn();
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);

        const activation = host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(async () => cleanup),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit, unwind }),
        });
        await commitStarted;
        const replacement = host.replaceAuthority({ ...authority, projectionGeneration: 13 });
        resolveCommit?.();

        await expect(activation).resolves.toEqual({
            ok: false,
            code: 'stale_projection_generation',
            diagnostics: ['stale_projection_generation'],
        });
        await replacement;
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(unwind).toHaveBeenCalledTimes(1);
    });

    it('replaces settled executable authority when the target changes at the same projection generation', async () => {
        const authorityA = Object.freeze({ serverId: 'server-a', machineId: 'machine-a', projectionGeneration: 12 });
        const authorityB = Object.freeze({ serverId: 'server-b', machineId: 'machine-b', projectionGeneration: 12 });
        const cleanupA = vi.fn();
        const unwindA = vi.fn();
        const activateA = vi.fn(async () => cleanupA);
        const activateB = vi.fn();
        const host = createPluginUiExecutableModuleHost();

        await host.replaceAuthority(authorityA);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activateA),
            hostPlatform: 'web',
            authority: authorityA,
            createScope: () => ({ api: Object.freeze({ target: 'a' }), commit: vi.fn(), unwind: unwindA }),
        })).resolves.toEqual({ ok: true });

        await host.replaceAuthority(authorityB);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activateB),
            hostPlatform: 'web',
            authority: authorityB,
            createScope: () => ({ api: Object.freeze({ target: 'b' }), commit: vi.fn(), unwind: vi.fn() }),
        })).resolves.toEqual({ ok: true });

        expect(cleanupA).toHaveBeenCalledTimes(1);
        expect(unwindA).toHaveBeenCalledTimes(1);
        expect(activateA).toHaveBeenCalledTimes(1);
        expect(activateB).toHaveBeenCalledTimes(1);
    });

    it('prevents an in-flight prior target from publishing after a same-generation authority change', async () => {
        const authorityA = Object.freeze({ serverId: 'server-a', machineId: 'machine-a', projectionGeneration: 12 });
        const authorityB = Object.freeze({ serverId: 'server-b', machineId: 'machine-b', projectionGeneration: 12 });
        let releaseA: (() => void) | undefined;
        let markAStarted: (() => void) | undefined;
        const aStarted = new Promise<void>((resolve) => {
            markAStarted = resolve;
        });
        const unwindA = vi.fn();
        const activateA = vi.fn(() => {
            markAStarted?.();
            return new Promise<void>((resolve) => {
                releaseA = resolve;
            });
        });
        const activateB = vi.fn();
        const host = createPluginUiExecutableModuleHost();

        await host.replaceAuthority(authorityA);
        const activationA = host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activateA),
            hostPlatform: 'web',
            authority: authorityA,
            createScope: () => ({ api: Object.freeze({ target: 'a' }), commit: vi.fn(), unwind: unwindA }),
        });
        await aStarted;

        await host.replaceAuthority(authorityB);
        const activationB = host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activateB),
            hostPlatform: 'web',
            authority: authorityB,
            createScope: () => ({ api: Object.freeze({ target: 'b' }), commit: vi.fn(), unwind: vi.fn() }),
        });
        releaseA?.();

        await expect(activationA).resolves.toEqual({
            ok: false,
            code: 'stale_projection_generation',
            diagnostics: ['stale_projection_generation'],
        });
        await expect(activationB).resolves.toEqual({ ok: true });
        expect(unwindA).toHaveBeenCalledTimes(1);
        expect(activateA).toHaveBeenCalledTimes(1);
        expect(activateB).toHaveBeenCalledTimes(1);
    });

    it('withdraws host registration authority before awaiting plugin cleanup', async () => {
        const authorityB = Object.freeze({
            serverId: 'server-b', machineId: 'machine-b', projectionGeneration: 12,
        });
        let releaseCleanup: (() => void) | undefined;
        let markCleanupStarted: (() => void) | undefined;
        const cleanupStarted = new Promise<void>((resolve) => {
            markCleanupStarted = resolve;
        });
        const cleanup = vi.fn(() => {
            markCleanupStarted?.();
            return new Promise<void>((resolve) => {
                releaseCleanup = resolve;
            });
        });
        const unwind = vi.fn();
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(async () => cleanup),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind }),
        })).resolves.toEqual({ ok: true });

        const replacement = host.replaceAuthority(authorityB);
        await cleanupStarted;
        expect(unwind).toHaveBeenCalledTimes(1);
        releaseCleanup?.();
        await replacement;
    });

    it('finishes host scope disposal before starting returned plugin cleanup', async () => {
        const authorityB = Object.freeze({
            serverId: 'server-b', machineId: 'machine-b', projectionGeneration: 12,
        });
        let releaseUnwind: (() => void) | undefined;
        let markUnwindStarted: (() => void) | undefined;
        const unwindStarted = new Promise<void>((resolve) => {
            markUnwindStarted = resolve;
        });
        const unwind = vi.fn(() => {
            markUnwindStarted?.();
            return new Promise<void>((resolve) => {
                releaseUnwind = resolve;
            });
        });
        const cleanup = vi.fn();
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(async () => cleanup),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind }),
        })).resolves.toEqual({ ok: true });

        const replacement = host.replaceAuthority(authorityB);
        await unwindStarted;
        expect(cleanup).not.toHaveBeenCalled();
        releaseUnwind?.();
        await replacement;
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('bounds unresolved cleanup and diagnoses its timeout without blocking replacement', async () => {
        vi.useFakeTimers();
        const logDiagnostic = vi.spyOn(log, 'log').mockImplementation(() => {});
        const authorityB = Object.freeze({
            serverId: 'server-b', machineId: 'machine-b', projectionGeneration: 12,
        });
        const unwind = vi.fn();
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(async () => () => new Promise<void>(() => {})),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind }),
        })).resolves.toEqual({ ok: true });

        const replacement = host.replaceAuthority(authorityB);
        await vi.advanceTimersByTimeAsync(5_000);
        await replacement;

        expect(unwind).toHaveBeenCalledTimes(1);
        expect(logDiagnostic).toHaveBeenCalledWith(
            '[PluginUiExecutableModuleHost] plugin_cleanup_timeout:acme.preview',
        );
        logDiagnostic.mockRestore();
        vi.useRealTimers();
    });
});
