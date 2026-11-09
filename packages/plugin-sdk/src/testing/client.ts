/** @moduleRealm daemon */
import { derivePluginClientContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { formatPluginManifestIngestionDiagnostics } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { PluginClientActivationModule, PluginClientApi, PluginCleanup } from '../activation.js';
import { parsePluginManifest, type PluginTestkitManifest } from '../manifest.js';
import { createPluginRegistrationScope } from '../registration/scope.js';

export type PluginClientTestkitRegistrationByFamily = Readonly<{
    [F in keyof PluginClientApi]: Parameters<PluginClientApi[F]['register']>[1];
}>;

export type PluginClientTestkitRegistration = Readonly<{
    family: keyof PluginClientTestkitRegistrationByFamily;
    localId: string;
}>;

export type PluginClientTestkitOptions = Readonly<{
    manifest: PluginTestkitManifest;
    target: Readonly<{
        artifactId: string;
        exportName: string;
        platform: 'web' | 'ios' | 'android';
    }>;
    activate: PluginClientActivationModule['activate'];
}>;

export interface PluginClientTestkit {
    registrations(): readonly PluginClientTestkitRegistration[];
    registration<F extends keyof PluginClientTestkitRegistrationByFamily>(
        family: F,
        localId: string,
    ): PluginClientTestkitRegistrationByFamily[F] | undefined;
    dispose(): Promise<void>;
}

/** Activate one exact declared client artifact without loading an installed UI bundle. */
export async function createPluginClientTestkit(options: PluginClientTestkitOptions): Promise<PluginClientTestkit> {
    const parsed = parsePluginManifest(options.manifest);
    if (!parsed.ok) {
        throw new TypeError(`Plugin test manifest is invalid: ${formatPluginManifestIngestionDiagnostics(parsed.diagnostics)}`);
    }
    const manifest = parsed.manifest;
    const scope = createPluginRegistrationScope({
        pluginId: manifest.id,
        target: { realm: 'client', ...options.target },
        rights: derivePluginClientContributionRegistrationRights(manifest.contributes, options.target),
    });
    let cleanup: PluginCleanup | undefined;
    let disposal: Promise<void> | undefined;
    function dispose(): Promise<void> {
        disposal ??= (async () => {
            const errors: unknown[] = [];
            try { await scope.dispose(); } catch (error) { errors.push(error); }
            const activationCleanup = cleanup;
            cleanup = undefined;
            try { await activationCleanup?.(); } catch (error) { errors.push(error); }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, `Plugin '${manifest.id}' client test cleanup failed`);
        })();
        return disposal;
    }
    try {
        const result: unknown = await options.activate(scope.api);
        if (result !== undefined && typeof result !== 'function') {
            throw new TypeError(`Plugin '${manifest.id}' client activate export must return void or one cleanup function`);
        }
        cleanup = typeof result === 'function' ? result as PluginCleanup : undefined;
        scope.commit();
    } catch (error) {
        try { await dispose(); } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], `Plugin '${manifest.id}' client test activation cleanup failed`);
        }
        throw error;
    }
    return Object.freeze({
        registrations: () => Object.freeze(scope.registrations().map(({ family, localId }) => Object.freeze({
            family: family as keyof PluginClientTestkitRegistrationByFamily, localId,
        }))),
        registration<F extends keyof PluginClientTestkitRegistrationByFamily>(family: F, localId: string) {
            // The catalog-derived exact client target gives this opaque host
            // capture the corresponding author-facing registration type.
            const value = scope.registrations().find((entry) => entry.family === family && entry.localId === localId)?.value;
            return value as PluginClientTestkitRegistrationByFamily[F] | undefined;
        },
        dispose,
    });
}
