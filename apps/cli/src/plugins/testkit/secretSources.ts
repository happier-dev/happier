import { definePlugin, type DefinedPlugin, type PluginInvocationContext, type PluginSecretSourceRuntimeV1 } from '@happier-dev/plugin-sdk';
import { createPluginRegistrationScope } from '@/plugins/runtime/api/registrationScope';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createTargetSecretSources } from '../runtime/lifecycle/contributions/targetSecretSources';
import { createPluginRuntimeOccurrenceId } from '../runtime/runtimeSlots';
import { createUnavailablePluginServices } from '../runtime/invocation/services/unavailable';

/** Real authoring, registration and acquisition projection; replace only native services. */
export async function createSecretSourceHostFixture(params: Readonly<{
    services?: PluginInvocationContext['services'];
    pluginId?: string;
    localId?: string;
}> & (Readonly<{ runtime: PluginSecretSourceRuntimeV1 }> | Readonly<{ plugin: Pick<DefinedPlugin, 'manifest' | 'activate'> }>)) {
    const localId = params.localId ?? ('plugin' in params ? params.plugin.manifest.contributes.secretSources?.[0]?.id : undefined) ?? 'vault';
    const plugin = 'plugin' in params ? params.plugin : definePlugin({
        id: params.pluginId ?? 'acme.vault', version: '1.0.0', displayName: 'Fixture vault',
        entrypoints: { daemon: './daemon.mjs' },
        secretSources: { [localId]: { declaration: { title: 'Fixture vault' }, runtime: params.runtime } },
    });
    const pluginId = plugin.manifest.id;
    const manifest = normalizePluginManifestV2(plugin.manifest);
    const scope = createPluginRegistrationScope({ pluginId, target: { realm: 'daemon' },
        rights: derivePluginDaemonContributionRegistrationRights(manifest.contributes) });
    await plugin.activate(scope.api);
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const registrations = scope.commit().map(registration => ({ pluginId, occurrenceId, registration }));
    let current = true;
    const host = createTargetSecretSources({
        targets: [{ pluginId, manifest }],
        registry: {
            // The fixture has already activated and committed this occurrence.
            async activateContributionsOnDemand() {},
            targetRegistrations: registrations,
            isPluginOccurrenceCurrent: () => current,
        },
        createInvocationContext(reference, _occurrence, signal) {
            return { context: {
                plugin: { id: pluginId, version: plugin.manifest.version },
                contribution: { id: reference.localId, qualifiedId: `${pluginId}/secretSources/${reference.localId}` },
                surface: 'cli', invokedAtMs: Date.now(), signal: signal ?? new AbortController().signal,
                services: params.services ?? createUnavailablePluginServices(),
            }, complete() {} };
        },
    });
    return { host, contribution: { pluginId, localId }, async dispose() { current = false; await scope.dispose(); } };
}
