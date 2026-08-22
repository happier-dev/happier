import type { PluginReactNativeBundleCache } from './bundleCache';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/async';
import type {
    PluginReactNativeLoaderBackend,
    RepackInstalledArtifactModuleReference,
} from './loader';
import { loadPluginReactNativeBundleExport } from './loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { log } from '@/log';

const PLUGIN_UI_EXECUTABLE_CLEANUP_TIMEOUT_MS = 5_000;

export type PluginUiExecutableActivationScope<TApi> = Readonly<{
    api: TApi;
    commit: () => void | Promise<void>;
    unwind: () => void | Promise<void>;
    isCurrent?: () => boolean;
}>;

export type PluginUiExecutableAuthority = Readonly<{
    serverId: string | null;
    machineId: string;
    projectionGeneration: number | null;
}>;

export type PluginUiExecutableModuleActivationResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        code:
            | 'loader_backend_unavailable'
            | 'artifact_cache_miss'
            | 'invalid_executable_export'
            | 'platform_mismatch'
            | 'stale_projection_generation'
            | 'activation_failed';
        diagnostics: readonly string[];
    }>;

export type PluginUiExecutableModuleHost = Readonly<{
    activate<TApi>(input: Readonly<{
        cache: PluginReactNativeBundleCache;
        identity: PluginReactNativeBundleCacheIdentity;
        moduleReference: RepackInstalledArtifactModuleReference;
        backend: PluginReactNativeLoaderBackend;
        hostPlatform: string;
        authority: PluginUiExecutableAuthority;
        createScope: () => PluginUiExecutableActivationScope<TApi>;
    }>): Promise<PluginUiExecutableModuleActivationResult>;
    replaceAuthority(authority: PluginUiExecutableAuthority | null): Promise<void>;
    invalidateActivation(input: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        moduleReference: RepackInstalledArtifactModuleReference;
    }>): Promise<void>;
    invalidatePlugin(pluginId: string): Promise<void>;
    unload(): Promise<void>;
}>;

export function createPluginUiExecutableModuleHost(): PluginUiExecutableModuleHost {
    type ActiveActivation = Readonly<{
        key: string;
        pluginId: string;
        fingerprint: string;
        cleanup?: () => void | Promise<void>;
        scope: PluginUiExecutableActivationScope<unknown>;
    }>;
    type PendingActivation = Readonly<{
        fingerprint: string;
        authorityRevision: number;
        pluginRevision: number;
        activationRevision: number;
        promise: Promise<PluginUiExecutableModuleActivationResult>;
    }>;

    const activeByKey = new Map<string, ActiveActivation>();
    const pendingByKey = new Map<string, PendingActivation>();
    const pluginRevisions = new Map<string, number>();
    const activationRevisions = new Map<string, number>();
    let authority: PluginUiExecutableAuthority | null = null;
    let authorityInitialized = false;
    let authorityRevision = 0;

    const sameAuthority = (
        left: PluginUiExecutableAuthority | null,
        right: PluginUiExecutableAuthority | null,
    ): boolean => (
        left === right
        || (left !== null && right !== null
            && left.serverId === right.serverId
            && left.machineId === right.machineId
            && left.projectionGeneration === right.projectionGeneration)
    );

    const activationKey = (input: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        moduleReference: RepackInstalledArtifactModuleReference;
    }>) => [
        input.identity.pluginId,
        input.identity.contributionId,
        input.moduleReference.modulePath,
        input.moduleReference.exportName,
    ].join('\u0000');

    const activationFingerprint = (input: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        moduleReference: RepackInstalledArtifactModuleReference;
        authorityRevision: number;
    }>) => [
        input.identity.artifactDigest,
        input.identity.platform,
        input.identity.channel,
        String(input.identity.projectionGeneration),
        input.moduleReference.containerName,
        input.moduleReference.modulePath,
        input.moduleReference.exportName,
        String(input.authorityRevision),
    ].join('\u0000');

    const readPluginRevision = (pluginId: string): number => pluginRevisions.get(pluginId) ?? 0;
    const advancePluginRevision = (pluginId: string): void => {
        pluginRevisions.set(pluginId, readPluginRevision(pluginId) + 1);
    };
    const readActivationRevision = (key: string): number => activationRevisions.get(key) ?? 0;
    const advanceActivationRevision = (key: string): void => {
        activationRevisions.set(key, readActivationRevision(key) + 1);
    };

    async function disposeActivation(active: ActiveActivation): Promise<void> {
        let unwind: Promise<void>;
        try {
            // Calling directly runs the scope's synchronous authority-withdrawal
            // prefix before any plugin-owned teardown can start.
            unwind = Promise.resolve(active.scope.unwind());
        } catch (error) {
            unwind = Promise.reject(error);
        }
        const unwindResult = await raceWithTimeout(unwind, PLUGIN_UI_EXECUTABLE_CLEANUP_TIMEOUT_MS);
        if (unwindResult.type === 'timeout') {
            log.log(`[PluginUiExecutableModuleHost] scope_unwind_timeout:${active.pluginId}`);
        } else if (unwindResult.type === 'rejected') {
            log.log(`[PluginUiExecutableModuleHost] scope_unwind_failed:${active.pluginId}`);
        }
        if (!active.cleanup) return;
        const cleanupResult = await raceWithTimeout(
            Promise.resolve().then(() => active.cleanup!()),
            PLUGIN_UI_EXECUTABLE_CLEANUP_TIMEOUT_MS,
        );
        if (cleanupResult.type === 'timeout') {
            log.log(`[PluginUiExecutableModuleHost] plugin_cleanup_timeout:${active.pluginId}`);
        } else if (cleanupResult.type === 'rejected') {
            log.log(`[PluginUiExecutableModuleHost] plugin_cleanup_failed:${active.pluginId}`);
        }
    }

    async function invalidateWhere(predicate: (active: ActiveActivation) => boolean): Promise<void> {
        const retiring: ActiveActivation[] = [];
        for (const [key, active] of activeByKey.entries()) {
            if (predicate(active)) {
                activeByKey.delete(key);
                retiring.push(active);
            }
        }
        await Promise.all(retiring.map(disposeActivation));
    }

    async function activate<TApi>(input: Readonly<{
        cache: PluginReactNativeBundleCache;
        identity: PluginReactNativeBundleCacheIdentity;
        moduleReference: RepackInstalledArtifactModuleReference;
        backend: PluginReactNativeLoaderBackend;
        hostPlatform: string;
        authority: PluginUiExecutableAuthority;
        createScope: () => PluginUiExecutableActivationScope<TApi>;
    }>): Promise<PluginUiExecutableModuleActivationResult> {
        if (!authorityInitialized) {
            return Object.freeze({
                ok: false,
                code: 'stale_projection_generation',
                diagnostics: Object.freeze(['projection_authority_not_initialized']),
            });
        }
        if (
            authority === null
            || !sameAuthority(authority, input.authority)
            || input.identity.projectionGeneration !== input.authority.projectionGeneration
        ) {
            return Object.freeze({
                ok: false,
                code: 'stale_projection_generation',
                diagnostics: Object.freeze(['stale_projection_generation']),
            });
        }

        const key = activationKey(input);
        const startAuthorityRevision = authorityRevision;
        const startActivationRevision = readActivationRevision(key);
        const fingerprint = activationFingerprint({ ...input, authorityRevision: startAuthorityRevision });
        const existing = activeByKey.get(key);
        if (existing?.fingerprint === fingerprint) {
            if (existing.scope.isCurrent?.() !== false) {
                return Object.freeze({ ok: true });
            }
            activeByKey.delete(key);
            await disposeActivation(existing);
        }
        const pending = pendingByKey.get(key);
        if (
            pending?.fingerprint === fingerprint
            && pending.authorityRevision === startAuthorityRevision
            && pending.pluginRevision === readPluginRevision(input.identity.pluginId)
            && pending.activationRevision === startActivationRevision
        ) {
            return await pending.promise;
        }

        const startPluginRevision = readPluginRevision(input.identity.pluginId);
        const isCurrent = () => (
            sameAuthority(authority, input.authority)
            && authorityRevision === startAuthorityRevision
            && readPluginRevision(input.identity.pluginId) === startPluginRevision
            && readActivationRevision(key) === startActivationRevision
        );

        const promise = (async (): Promise<PluginUiExecutableModuleActivationResult> => {
            const loaded = await loadPluginReactNativeBundleExport({
                cache: input.cache,
                identity: input.identity,
                moduleReference: input.moduleReference,
                backend: input.backend,
                hostPlatform: input.hostPlatform,
            }).catch(() => null);
            if (loaded === null) {
                return Object.freeze({
                    ok: false,
                    code: 'activation_failed',
                    diagnostics: Object.freeze(['activation_failed']),
                });
            }
            if (!loaded.ok) {
                return loaded;
            }
            if (!isCurrent()) {
                return Object.freeze({
                    ok: false,
                    code: 'stale_projection_generation',
                    diagnostics: Object.freeze(['stale_projection_generation']),
                });
            }

            let scope: PluginUiExecutableActivationScope<TApi>;
            try {
                scope = input.createScope();
            } catch {
                return Object.freeze({
                    ok: false,
                    code: 'activation_failed',
                    diagnostics: Object.freeze(['activation_failed']),
                });
            }
            let cleanup: (() => void | Promise<void>) | undefined;
            try {
                const activationResult = await Reflect.apply(loaded.exported, undefined, [scope.api]);
                if (activationResult !== undefined && typeof activationResult !== 'function') {
                    throw new TypeError('invalid_activation_cleanup');
                }
                cleanup = activationResult as (() => void | Promise<void>) | undefined;
            } catch {
                await disposeActivation({
                    key,
                    pluginId: input.identity.pluginId,
                    fingerprint,
                    scope,
                });
                return Object.freeze({
                    ok: false,
                    code: 'activation_failed',
                    diagnostics: Object.freeze(['activation_failed']),
                });
            }

            if (!isCurrent() || scope.isCurrent?.() === false) {
                await disposeActivation({
                    key,
                    pluginId: input.identity.pluginId,
                    fingerprint,
                    ...(cleanup ? { cleanup } : {}),
                    scope,
                });
                return Object.freeze({
                    ok: false,
                    code: 'stale_projection_generation',
                    diagnostics: Object.freeze(['stale_projection_generation']),
                });
            }

            try {
                await scope.commit();
            } catch {
                await disposeActivation({
                    key,
                    pluginId: input.identity.pluginId,
                    fingerprint,
                    ...(cleanup ? { cleanup } : {}),
                    scope,
                });
                return Object.freeze({
                    ok: false,
                    code: 'activation_failed',
                    diagnostics: Object.freeze(['activation_failed']),
                });
            }

            if (!isCurrent() || scope.isCurrent?.() === false) {
                await disposeActivation({
                    key,
                    pluginId: input.identity.pluginId,
                    fingerprint,
                    ...(cleanup ? { cleanup } : {}),
                    scope,
                });
                return Object.freeze({
                    ok: false,
                    code: 'stale_projection_generation',
                    diagnostics: Object.freeze(['stale_projection_generation']),
                });
            }

            const nextActive: ActiveActivation = {
                key,
                pluginId: input.identity.pluginId,
                fingerprint,
                ...(cleanup ? { cleanup } : {}),
                scope: scope as PluginUiExecutableActivationScope<unknown>,
            };
            const previous = activeByKey.get(key);
            activeByKey.set(key, nextActive);
            if (previous) {
                await disposeActivation(previous);
            }
            return Object.freeze({ ok: true });
        })();

        pendingByKey.set(key, Object.freeze({
            fingerprint,
            authorityRevision: startAuthorityRevision,
            pluginRevision: startPluginRevision,
            activationRevision: startActivationRevision,
            promise,
        }));
        try {
            return await promise;
        } finally {
            if (pendingByKey.get(key)?.promise === promise) {
                pendingByKey.delete(key);
            }
        }
    }

    const replaceAuthority = async (nextAuthority: PluginUiExecutableAuthority | null): Promise<void> => {
        if (authorityInitialized && sameAuthority(authority, nextAuthority)) {
            return;
        }
        authority = nextAuthority;
        authorityInitialized = true;
        authorityRevision += 1;
        await invalidateWhere(() => true);
    };

    return Object.freeze({
        activate,
        replaceAuthority,
        invalidateActivation: async (input) => {
            const key = activationKey(input);
            advanceActivationRevision(key);
            await invalidateWhere((active) => active.key === key);
        },
        invalidatePlugin: async (pluginId) => {
            advancePluginRevision(pluginId);
            await invalidateWhere((active) => active.pluginId === pluginId);
        },
        unload: async () => {
            await replaceAuthority(null);
        },
    });
}

const installedPluginUiExecutableModuleHost = createPluginUiExecutableModuleHost();

export function getInstalledPluginUiExecutableModuleHost(): PluginUiExecutableModuleHost {
    return installedPluginUiExecutableModuleHost;
}
