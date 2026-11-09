import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { loadAdmittedInstalledPluginDeclarations } from '@/plugins/discovery/load/admitted';
import { defaultCanImportFirstPartyPluginSource } from '@/packagedRuntime/firstPartySourceRuntime';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from './sources/generatedBundledPlugins';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from './sources/generatedBundledPluginManifests';
import { readCurrentBundledPluginPublicationFailures } from './builtIn/publication';
import { readBundledPluginManifest } from './builtIn/manifestFile';
import { indexAgentBindings, manifestAgentKey, projectBuiltInAgentFields } from './builtIn/agentIdentity';
import { projectManifestAgentFields } from './projectManifestAgentFields';
import { excludeReplacedPluginIdentities } from './normalize/pluginIdentities';
import type { ResolvedAgentContribution } from './types';

/** Selected Agent declaration fields for listing; no executable registry is built. */
export async function resolveAdmittedAgentListingContributions(happyHomeDir: string): Promise<Readonly<{ agents: readonly ResolvedAgentContribution[] }>> {
    const failures = defaultCanImportFirstPartyPluginSource() ? [] : readCurrentBundledPluginPublicationFailures();
    const excluded = new Set(failures.map((failure) => failure.pluginId));
    const installed = await loadAdmittedInstalledPluginDeclarations(happyHomeDir);
    const bundled = excludeReplacedPluginIdentities(
        BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter((locator) => !excluded.has(locator.pluginId)),
        installed.loadedPlugins,
    );
    const bindings = indexAgentBindings(BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS);
    const agents: ResolvedAgentContribution[] = [];
    for (const locator of bundled) {
        // These normalized assets are admitted and written by the canonical
        // bundled publisher; this read does not re-admit their declaration body.
        const manifest = readBundledPluginManifest(locator) as CanonicalPluginManifest;
        for (const definition of manifest.contributes.agents ?? []) {
            const fields = projectManifestAgentFields({ definition, pluginId: manifest.id, provenance: 'first_party', source: { kind: 'bundled' } });
            const canonicalId = bindings.byIdentity.get(manifestAgentKey(manifest.id, definition.id))?.implementationOwnerId ?? fields.id;
            agents.push(projectBuiltInAgentFields(fields, canonicalId));
        }
    }
    for (const plugin of installed.loadedPlugins) {
        for (const definition of plugin.manifest.contributes.agents ?? []) {
            agents.push(projectManifestAgentFields({ definition, pluginId: plugin.pluginId, provenance: 'external', source: { kind: plugin.sourceSpec.kind } }));
        }
    }
    return { agents: Object.freeze(agents) };
}
