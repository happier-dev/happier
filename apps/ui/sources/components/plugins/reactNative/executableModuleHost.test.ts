import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createPluginReactNativeBundleCache } from './bundleCache';
import { createPluginUiExecutableModuleHost } from './executableModuleHost';
import { createPluginUiCommonJsLoaderBackend } from './commonJsLoaderBackend';
import * as commonJs from './commonJsEvaluator';
import type { PluginReactNativeExecutableExport, PluginReactNativeLoaderBackend } from './loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { log } from '@/log';

const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
    pluginId: 'acme.preview',
    contributionId: 'client-runtime',
    artifactId: 'client-runtime',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    platform: 'web',
});

const moduleReference = Object.freeze({
    exportName: 'activateClientRuntime',
});

const authority = Object.freeze({
    serverId: 'server-1',
    machineId: 'machine-1',
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
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: vi.fn(async () => exported),
    });
}

describe('PluginUiExecutableModuleHost', () => {
    it('reuses a current activation, re-instantiates a fresh namespace after activation retirement, and compiles once per digest', async () => {
        // Forward the real loader and evaluator; count instantiation (fresh namespace) and compilation.
        const evaluations = vi.spyOn(commonJs, 'instantiatePluginUiCommonJsProgram');
        const compiles = vi.spyOn(commonJs, 'compilePluginUiCommonJsBundle');
        onTestFinished(() => { evaluations.mockRestore(); compiles.mockRestore(); });
        const host = createPluginUiExecutableModuleHost();
        onTestFinished(() => host.unload());
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({ identity, format: 'plainJs',
            bytes: new TextEncoder().encode('exports.activateClientRuntime = function () {};') });
        const input = { cache, identity, moduleReference, authority, hostPlatform: 'web',
            backend: createPluginUiCommonJsLoaderBackend(),
            createScope: () => ({ api: Object.freeze({}), commit: () => {}, unwind: () => {} }) };
        await host.replaceAuthority(authority);
        const results = await Promise.all(Array.from({ length: 100 }, () => host.activate(input)));
        expect(results.every(result => result.ok)).toBe(true);
        for (let index = 0; index < 100; index += 1) expect(await host.activate(input)).toEqual({ ok: true });
        expect(evaluations).toHaveBeenCalledTimes(1);
        await host.invalidatePlugin(identity.pluginId);
        expect(await host.activate(input)).toEqual({ ok: true });
        expect(evaluations).toHaveBeenCalledTimes(2);
        expect(compiles).toHaveBeenCalledTimes(1);
        const replacement: PluginReactNativeBundleCacheIdentity = { ...identity, artifactDigest: 'sha256:replacement' };
        cache.putInstalledArtifact({ identity: replacement, format: 'plainJs',
            bytes: new TextEncoder().encode('exports.activateClientRuntime = function () {};') });
        expect(await host.activate({ ...input, identity: replacement })).toEqual({ ok: true });
        expect(await host.activate({ ...input, identity: replacement })).toEqual({ ok: true });
        expect(evaluations).toHaveBeenCalledTimes(3);
        expect(compiles).toHaveBeenCalledTimes(2);
    });

    it('releases all executable namespaces across seven retired external Account activations', async () => {
        vi.stubGlobal('__dg8AccountRuntimeEvaluations', 0);
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const artifactIdentity = { ...identity, pluginId: 'external.account-runtime', artifactId: 'dg8-account-runtime' };
        const bytes = new TextEncoder().encode(`
            globalThis.__dg8AccountRuntimeEvaluations++;
            const namespace = {};
            exports.activateClientRuntime = api => {
                let calls = 0;
                api.capture(namespace);
                api.register(() => [api.accountId, ++calls]);
                return () => api.cleaned();
            };
        `);
        const readers: Array<() => readonly [string, number]> = [];
        const namespaces = new Set<object>();
        const cleaned = vi.fn();
        // Observe real registry retention without replacing its evaluator or adding diagnostics.
        const retained = new Map<Map<unknown, unknown>, Set<unknown>>();
        const originalSet = Map.prototype.set;
        const originalDelete = Map.prototype.delete;
        const originalClear = Map.prototype.clear;
        const writes = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
            if (value !== null && typeof value === 'object' && typeof Reflect.get(value, 'readExport') === 'function') {
                let keys = retained.get(this);
                if (!keys) { keys = new Set(); originalSet.call(retained, this, keys); }
                keys.add(key);
            }
            return originalSet.call(this, key, value);
        });
        const deletes = vi.spyOn(Map.prototype, 'delete').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
            retained.get(this)?.delete(key);
            return originalDelete.call(this, key);
        });
        const clears = vi.spyOn(Map.prototype, 'clear').mockImplementation(function (this: Map<unknown, unknown>) {
            retained.get(this)?.clear();
            return originalClear.call(this);
        });
        try {
        for (let index = 0; index < 7; index += 1) {
            const host = createPluginUiExecutableModuleHost();
            const accountId = `account-${index}`;
            const accountAuthority = { kind: 'account' as const, serverId: 'home', accountId: 'same-account', custodyId: 'release' };
            await host.replaceAuthority(accountAuthority);
            const cache = createPluginReactNativeBundleCache();
            cache.putInstalledArtifact({ identity: { ...artifactIdentity }, bytes: new Uint8Array(bytes), format: 'plainJs' });
            expect(await host.activate({
                cache, identity: { ...artifactIdentity }, moduleReference, authority: accountAuthority,
                hostPlatform: 'web', backend: createPluginUiCommonJsLoaderBackend(),
                createScope: () => ({
                    api: { accountId, capture: (namespace: object) => namespaces.add(namespace),
                        register: (read: () => readonly [string, number]) => readers.push(read), cleaned },
                    commit: () => {}, unwind: () => {},
                }),
            })).toEqual({ ok: true });
            await host.unload();
        }
        expect([...retained.values()].reduce((count, keys) => count + keys.size, 0)).toBe(0);
        expect(namespaces.size).toBe(7);
        expect(Reflect.get(globalThis, '__dg8AccountRuntimeEvaluations')).toBe(7);
        expect(readers.map(read => read())).toEqual(Array.from({ length: 7 }, (_, index) => [`account-${index}`, 1]));
        expect(cleaned).toHaveBeenCalledTimes(7);
        } finally {
            clears.mockRestore();
            deletes.mockRestore();
            writes.mockRestore();
        }
    });

    it('does not reuse a real external namespace whose asynchronous load settled after Account retirement', async () => {
        const evaluations = vi.spyOn(commonJs, 'instantiatePluginUiCommonJsProgram');
        onTestFinished(() => evaluations.mockRestore());
        const host = createPluginUiExecutableModuleHost();
        onTestFinished(() => host.unload());
        const externalIdentity = { ...identity, pluginId: 'external.late-account' };
        const accountAuthority = { kind: 'account' as const, serverId: 'home', accountId: 'account', custodyId: 'release' };
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({ identity: externalIdentity, format: 'plainJs',
            bytes: new TextEncoder().encode('exports.activateClientRuntime = function () {};') });
        const realBackend = createPluginUiCommonJsLoaderBackend();
        let finishLoad: (() => void) | undefined;
        const waiting = new Promise<void>(resolve => { finishLoad = resolve; });
        const delayedBackend: PluginReactNativeLoaderBackend = {
            ...realBackend,
            loadInstalledBundle: async input => {
                await waiting;
                return realBackend.loadInstalledBundle!(input);
            },
        };
        const createScope = vi.fn(() => ({ api: Object.freeze({}), commit() {}, unwind() {} }));
        const input = { cache, identity: externalIdentity, moduleReference, authority: accountAuthority,
            hostPlatform: 'web', backend: delayedBackend, createScope };
        await host.replaceAuthority(accountAuthority);
        const pending = host.activate(input);
        await host.unload();
        finishLoad?.();
        expect(await pending).toMatchObject({ ok: false, code: 'artifact_replaced' });
        expect(createScope).not.toHaveBeenCalled();
        expect(evaluations).toHaveBeenCalledTimes(1);
        await host.replaceAuthority(accountAuthority);
        expect(await host.activate({ ...input, backend: realBackend })).toEqual({ ok: true });
        expect(createScope).toHaveBeenCalledTimes(1);
        expect(evaluations).toHaveBeenCalledTimes(2);
    });

    it('isolates module-level captured APIs between concurrent authorities and activation exports', async () => {
        const artifactIdentity = { ...identity, artifactId: 'dg8b-isolated-runtime' };
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({ identity: artifactIdentity, format: 'plainJs', bytes: new TextEncoder().encode(`
            let currentApi;
            const activate = api => {
                currentApi = api;
                api.register(() => currentApi.label);
                return () => currentApi.cleaned();
            };
            exports.activateClientRuntime = activate;
            exports.activateOtherRuntime = activate;
        `) });
        const accountAuthority = { kind: 'account' as const, serverId: 'home', accountId: 'a', custodyId: 'release' };
        const authorities = [accountAuthority, { ...accountAuthority, accountId: 'b' }, authority];
        const readers: Array<() => string> = [];
        const cleanups: string[] = [];
        const hosts = authorities.map(() => createPluginUiExecutableModuleHost());
        onTestFinished(async () => { await Promise.all(hosts.map(host => host.unload())); });
        for (const [index, scopedAuthority] of authorities.entries()) {
            const host = hosts[index]!;
            await host.replaceAuthority(scopedAuthority);
            expect(await host.activate({ cache, identity: artifactIdentity, moduleReference,
                backend: createPluginUiCommonJsLoaderBackend(), hostPlatform: 'web', authority: scopedAuthority,
                createScope: () => ({ api: { label: `scope-${index}`, register: (read: () => string) => readers.push(read),
                    cleaned: () => cleanups.push(`scope-${index}`) }, commit() {}, unwind() {} }),
            })).toEqual({ ok: true });
        }
        // Two exports may each capture their activation API even under the same Account.
        expect(await hosts[0]!.activate({ cache, identity: artifactIdentity,
            moduleReference: { exportName: 'activateOtherRuntime' }, backend: createPluginUiCommonJsLoaderBackend(),
            hostPlatform: 'web', authority: accountAuthority,
            createScope: () => ({ api: { label: 'other-export', register: (read: () => string) => readers.push(read),
                cleaned: () => cleanups.push('other-export') }, commit() {}, unwind() {} }),
        })).toEqual({ ok: true });
        expect(readers.map(read => read())).toEqual(['scope-0', 'scope-1', 'scope-2', 'other-export']);
        await hosts[0]!.unload();
        expect(cleanups).toEqual(['scope-0', 'other-export']);
        expect(readers.slice(1, 3).map(read => read())).toEqual(['scope-1', 'scope-2']);
    });

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
            code: 'artifact_replaced',
            diagnostics: ['artifact_authority_not_initialized'],
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
                backendId: 'commonJs',
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
                backendId: 'commonJs',
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

    it('retires active authority on origin replacement and rejects a late stale activation', async () => {
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

        await host.replaceAuthority({ ...authority, machineId: 'machine-2' });
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
            code: 'artifact_replaced',
            diagnostics: ['artifact_replaced'],
        });
    });

    it('unwinds an activation whose commit completes after its origin was replaced', async () => {
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
        const replacement = host.replaceAuthority({ ...authority, machineId: 'machine-2' });
        resolveCommit?.();

        await expect(activation).resolves.toEqual({
            ok: false,
            code: 'artifact_replaced',
            diagnostics: ['artifact_replaced'],
        });
        await replacement;
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(unwind).toHaveBeenCalledTimes(1);
    });

    it('replaces settled executable authority when the target changes', async () => {
        const authorityA = Object.freeze({ serverId: 'server-a', machineId: 'machine-a' });
        const authorityB = Object.freeze({ serverId: 'server-b', machineId: 'machine-b' });
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

    it('prevents an in-flight prior target from publishing after an authority change', async () => {
        const authorityA = Object.freeze({ serverId: 'server-a', machineId: 'machine-a' });
        const authorityB = Object.freeze({ serverId: 'server-b', machineId: 'machine-b' });
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
            code: 'artifact_replaced',
            diagnostics: ['artifact_replaced'],
        });
        await expect(activationB).resolves.toEqual({ ok: true });
        expect(unwindA).toHaveBeenCalledTimes(1);
        expect(activateA).toHaveBeenCalledTimes(1);
        expect(activateB).toHaveBeenCalledTimes(1);
    });

    it('withdraws host registration authority before awaiting plugin cleanup', async () => {
        const authorityB = Object.freeze({
            serverId: 'server-b', machineId: 'machine-b',
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
            serverId: 'server-b', machineId: 'machine-b',
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

    it('diagnoses real retirement failures without retaining the old authority', async () => {
        const logDiagnostic = vi.spyOn(log, 'log').mockImplementation(() => {});
        onTestFinished(() => { logDiagnostic.mockRestore(); });
        const authorityB = Object.freeze({ serverId: 'server-b', machineId: 'machine-b' });
        const cleanup = vi.fn(async () => { throw new Error('plugin cleanup failed'); });
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(), identity, moduleReference,
            backend: backend(async () => cleanup), hostPlatform: 'web', authority,
            createScope: () => ({
                api: Object.freeze({}), commit: vi.fn(),
                unwind: async () => { throw new Error('scope cleanup failed'); },
            }),
        })).resolves.toEqual({ ok: true });
        await host.replaceAuthority(authorityB);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(logDiagnostic.mock.calls).toEqual([
            [`[PluginUiExecutableModuleHost] scope_unwind_failed:${identity.pluginId}`],
            [`[PluginUiExecutableModuleHost] plugin_cleanup_failed:${identity.pluginId}`],
        ]);
        await expect(host.activate({
            cache: cacheWithIdentity(), identity, moduleReference,
            backend: backend(vi.fn()), hostPlatform: 'web', authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind: vi.fn() }),
        })).resolves.toMatchObject({ ok: false, code: 'artifact_replaced' });
    });

    it('withdraws authority immediately and joins slow scope and plugin retirement beyond the former cutoffs', async () => {
        vi.useFakeTimers();
        onTestFinished(() => { vi.useRealTimers(); });
        const logDiagnostic = vi.spyOn(log, 'log').mockImplementation(() => {});
        onTestFinished(() => { logDiagnostic.mockRestore(); });
        const authorityB = Object.freeze({
            serverId: 'server-b', machineId: 'machine-b',
        });
        let scopeCurrent = true;
        let releaseUnwind!: () => void;
        const unwind = () => {
            scopeCurrent = false;
            return new Promise<void>((resolve) => { releaseUnwind = resolve; });
        };
        let releaseCleanup!: () => void;
        const cleanup = vi.fn(() => new Promise<void>((resolve) => { releaseCleanup = resolve; }));
        const host = createPluginUiExecutableModuleHost();
        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(async () => cleanup),
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind, isCurrent: () => scopeCurrent }),
        })).resolves.toEqual({ ok: true });

        const replacement = host.replaceAuthority(authorityB);
        let retired = false;
        void replacement.then(() => { retired = true; });
        expect(scopeCurrent).toBe(false);
        await vi.advanceTimersByTimeAsync(5_001);
        expect(retired).toBe(false);
        expect(cleanup).not.toHaveBeenCalled();
        await expect(host.activate({
            cache: cacheWithIdentity(), identity, moduleReference,
            backend: backend(vi.fn()), hostPlatform: 'web', authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind: vi.fn() }),
        })).resolves.toMatchObject({ ok: false, code: 'artifact_replaced' });
        releaseUnwind();
        await vi.advanceTimersByTimeAsync(5_001);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(retired).toBe(false);
        releaseCleanup();
        await replacement;
        expect(retired).toBe(true);
        expect(logDiagnostic).not.toHaveBeenCalled();
    });
});
