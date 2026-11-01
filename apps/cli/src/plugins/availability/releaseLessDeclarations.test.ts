import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as LIMA_MANIFEST } from '@happier-dev/plugins-machine-lima/manifest';

import type { PluginSourceCustody } from '@/plugins/runtime/sourceAuthority';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectPluginUiDeclarationEntries } from '@/plugins/projection/registry/ui/projection';

import { projectPluginInstalledAvailabilityInventory, projectReleaseLessPluginDeclarations } from './releaseLessDeclarations';

function manifest(id: string, contributes: Record<string, unknown>) {
    return PluginManifestV2Schema.parse({
        schemaVersion: 2,
        id,
        version: '3.1.0',
        displayName: id,
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        contributes,
    });
}

const EVENT = {
    id: 'message-received',
    kind: 'event',
    title: 'Message received',
    payloadSchema: { type: 'object', additionalProperties: false },
};

const BUNDLED: PluginSourceCustody = {
    kind: 'bundled_first_party',
    packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-3.1.0' },
};
const DEVELOPMENT: PluginSourceCustody = { kind: 'development', registeredRootId: '/src/plugin' };
const MANAGED: PluginSourceCustody = {
    kind: 'managed',
    immutableGenerationId: 'generation-1',
    installSource: 'npm',
};

describe('release-less plugin declarations', () => {
    it('claims the admitted native provisioner declaration needed by preset and acquire admission', () => {
        const provisionerManifest = PluginManifestV2Schema.parse(LIMA_MANIFEST);
        const declarations = projectReleaseLessPluginDeclarations({
            activationTargets: [{ pluginId: provisionerManifest.id, manifest: provisionerManifest }],
            sourceCustodiesByPluginId: new Map([[provisionerManifest.id, BUNDLED]]),
            registryMaterializationIdsByPluginId: {}, observedAt: 12,
        });
        expect(declarations.get(provisionerManifest.id)).toMatchObject({
            claimsAccountIntent: true,
            manifest: { contributes: { machineProvisioners: [{ id: 'lima' }] } },
            runtimeMaterialization: { enabled: true, trustState: 'trusted' },
        });
        const observedOnly = projectReleaseLessPluginDeclarations({
            activationTargets: [{ pluginId: provisionerManifest.id, manifest: provisionerManifest,
                sourceSpec: { kind: 'path', locator: '/plugins/lima', trustPolicy: 'local_trusted', installPolicy: 'link' } }],
            sourceCustodiesByPluginId: new Map(), registryMaterializationIdsByPluginId: {}, observedAt: 12,
        });
        expect(observedOnly.get(provisionerManifest.id)?.claimsAccountIntent).toBe(false);
    });
    it('observes metadata-only path declarations without promoting source policy to admitted trust or an Account claim', () => {
        const observed = projectReleaseLessPluginDeclarations({
            activationTargets: [{ pluginId: 'acme.metadata', manifest: manifest('acme.metadata', { events: [EVENT] }),
                sourceSpec: { kind: 'path', locator: '/plugins/acme.metadata', trustPolicy: 'local_trusted', installPolicy: 'link' } }],
            sourceCustodiesByPluginId: new Map(), registryMaterializationIdsByPluginId: {}, observedAt: 1,
        }).get('acme.metadata');
        expect(observed).toMatchObject({ claimsAccountIntent: false, runtimeMaterialization: { trustState: 'untrusted' } });
    });
    it('refuses to publish persisted-only rows as a complete census while the admitted source registry is unavailable', () => {
        expect(() => projectPluginInstalledAvailabilityInventory({
            inventory: { revision: 1, releasePublications: [], materializations: [] },
            registry: null, registryRevision: null, runtimeMaterializations: [],
        })).toThrow('Current installed plugin source census is unavailable');
    });
    it('declares the recorded local-folder installation with its serving manifest so other devices can name it', () => {
        // Live 2026-10-16 (PLUGVIS 2h): local-folder plugins recorded by the install registry reached other
        // machines' Plugins pages as raw ids with no description: their materialization carried no declaration.
        const sourceSpec = { kind: 'path', locator: '/plugins/acme.local', trustPolicy: 'local_trusted', installPolicy: 'link' } as const;
        const local = { ...manifest('acme.local', {}), displayName: 'Acme notes', description: 'Notes for Acme.' };
        const plugin: LoadedPlugin = { pluginId: 'acme.local', pluginRootPath: '/plugins/acme.local',
            manifestPath: '/plugins/acme.local/.happier-plugin/plugin.json', daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec, manifest: local };
        const registry = createResolvedContributionRegistry({ pluginDeclarations: [plugin] });
        const recorded = { materializationId: 'mat-local', pluginId: 'acme.local', version: '3.1.0', sourceClass: 'localPath',
            portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 } as const;
        const otherVersion = { ...recorded, materializationId: 'mat-old', version: '2.0.0' } as const;
        const complete = projectPluginInstalledAvailabilityInventory({
            inventory: { revision: 1, releasePublications: [], materializations: [recorded, otherVersion] },
            registry, registryRevision: 1, runtimeMaterializations: [],
        });
        expect(complete.materializations.find(entry => entry.materializationId === 'mat-local'))
            .toMatchObject({ declaredManifest: { displayName: 'Acme notes', description: 'Notes for Acme.' } });
        // A manifest of another version never describes this installation.
        expect(complete.materializations.find(entry => entry.materializationId === 'mat-old')).not.toHaveProperty('declaredManifest');
    });
    it('refuses to combine installation facts with declarations from a different committed revision', () => {
        expect(() => projectPluginInstalledAvailabilityInventory({
            inventory: { revision: 2, releasePublications: [], materializations: [] },
            registry: createResolvedContributionRegistry({}), registryRevision: 1, runtimeMaterializations: [],
        })).toThrow();
    });
    it.each(['hostedHtml', 'declarative'] as const)('carries a %s source with no daemon entry through installed declaration projection, not activation', (rendererKind) => {
        const plugin: LoadedPlugin = {
            pluginId: 'acme.ui-only', pluginRootPath: '/plugins/acme.ui-only',
            manifestPath: '/plugins/acme.ui-only/.happier-plugin/plugin.json',
            daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: '/plugins/acme.ui-only', trustPolicy: 'local_trusted', installPolicy: 'link' },
            manifest: manifest('acme.ui-only', { ui: {
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, renderer: 'renderer', title: 'Page' }],
                renderers: [rendererKind === 'hostedHtml'
                    ? { id: 'renderer', kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<p>Page</p>') }
                    : { id: 'renderer', kind: 'declarative', root: { kind: 'text', text: 'Page' } }],
            } }),
        };
        const projected = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} }, provenance: 'external' });
        const registry = createResolvedContributionRegistry(projected);
        expect(registry.activationTargets).toEqual([]);
        const declaration = projectReleaseLessPluginDeclarations({
            activationTargets: registry.pluginDeclarations ?? [], sourceCustodiesByPluginId: new Map(),
            registryMaterializationIdsByPluginId: {}, observedAt: 12,
        }).get(plugin.pluginId);
        expect(declaration).toMatchObject({ claimsAccountIntent: false, runtimeMaterialization: { sourceClass: 'localPath', declaredManifest: plugin.manifest } });
        const page = Object.values(projectPluginUiDeclarationEntries(registry)).find(entry => entry.contributionKind === 'surfacePlacement');
        expect(page).toMatchObject({ pluginId: plugin.pluginId, descriptorId: 'page', renderer: rendererKind === 'hostedHtml'
            ? { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<p>Page</p>') }
            : { kind: 'declarative', model: { identity: { pluginId: plugin.pluginId }, root: { kind: 'text', text: 'Page' } } } });
        expect(page).not.toHaveProperty('occurrenceId');
        expect(page).not.toHaveProperty('materializationRef');
    });
    it('declares daemon-selected plugins with Account-scoped contributions and reports only the ones no registry record covers', () => {
        const declarations = projectReleaseLessPluginDeclarations({
            activationTargets: [
                { pluginId: 'acme.bundled', manifest: manifest('acme.bundled', { events: [EVENT] }) },
                { pluginId: 'acme.checkout', manifest: manifest('acme.checkout', { events: [EVENT] }) },
                { pluginId: 'acme.registered', manifest: manifest('acme.registered', { events: [EVENT] }) },
                { pluginId: 'acme.managed', manifest: manifest('acme.managed', { events: [EVENT] }) },
                { pluginId: 'acme.agent', manifest: manifest('acme.agent', {}) },
            ],
            sourceCustodiesByPluginId: new Map<string, PluginSourceCustody>([
                ['acme.bundled', BUNDLED],
                ['acme.checkout', DEVELOPMENT],
                ['acme.registered', DEVELOPMENT],
                ['acme.managed', MANAGED],
                ['acme.agent', BUNDLED],
            ]),
            registryMaterializationIdsByPluginId: {
                'acme.registered': 'registry-materialization',
                'acme.managed': 'managed-materialization',
            },
            observedAt: 1_700_000_000_000,
        });

        expect([...declarations.keys()]).toEqual(['acme.bundled', 'acme.checkout', 'acme.registered', 'acme.agent']);
        expect(declarations.get('acme.bundled')).toMatchObject({
            manifest: { id: 'acme.bundled', version: '3.1.0' },
            materializationId: 'daemon-selected:acme.bundled',
            runtimeMaterialization: {
                materializationId: 'daemon-selected:acme.bundled',
                pluginId: 'acme.bundled',
                version: '3.1.0',
                sourceClass: 'bundledFirstParty',
                portableRelease: false,
                enabled: true,
                trustState: 'trusted',
            },
        });
        expect(declarations.get('acme.checkout')?.runtimeMaterialization)
            .toMatchObject({ sourceClass: 'localPath', portableRelease: false });
        expect(declarations.get('acme.registered')).toMatchObject({
            materializationId: 'registry-materialization',
            runtimeMaterialization: null,
        });
    });

    it.each([
        { label: 'bundled', custody: BUNDLED, sourceClass: 'bundledFirstParty' },
        { label: 'drop-in', custody: DEVELOPMENT, sourceClass: 'localPath' },
    ])('observes a selected $label UI-only source with a missing artifact without claiming an enabled Account intent', ({ custody, sourceClass }) => {
        const uiOnlyManifest = manifest('acme.ui-only', {
            ui: {
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, renderer: 'page-renderer', title: 'Page' }],
                renderers: [{ id: 'page-renderer', kind: 'reactNative', artifact: 'missing-page' }],
            },
        });
        const declarations = projectReleaseLessPluginDeclarations({
            activationTargets: [{ pluginId: uiOnlyManifest.id, manifest: uiOnlyManifest,
                generatedUiArtifactsManifest: { version: 2, entries: [] } }],
            sourceCustodiesByPluginId: new Map([[uiOnlyManifest.id, custody]]),
            registryMaterializationIdsByPluginId: {},
            observedAt: 12,
        });
        const observed = declarations.get(uiOnlyManifest.id);
        expect(observed).toMatchObject({
            claimsAccountIntent: false,
            runtimeMaterialization: {
                pluginId: uiOnlyManifest.id,
                declaredManifest: uiOnlyManifest,
                portableRelease: false,
                sourceClass,
                uiArtifacts: [],
            },
        });
    });
});
