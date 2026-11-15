import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } from '@happier-dev/cli-common/packageBuildOutputTargets';
import { PluginProjectedResourceV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildResourcesById } from '@/plugins/projection/registry/projection/v2';
import { readGeneratedPluginCompiledAccountResourceIdsSync } from './generatedArtifacts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('retains compiled Account Resource facts independently of unrelated Action schema bytes', () => {
    const pluginId = 'acme.account-relay';
    const root = mkdtempSync(join(tmpdir(), 'compiled-resource-size-'));
    roots.push(root);
    const graph = join(root, 'dist/happier-plugin-ui');
    mkdirSync(graph, { recursive: true });
    const readWithActions = (count: number) => {
        writeFileSync(join(graph, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD), JSON.stringify({ version: 2,
            manifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Relay', runtime: { apiVersion: 1 },
                contributes: {
                    resources: [{ id: 'target-options', source: 'dynamic', kind: 'config', scope: 'global',
                        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
                        contentType: 'application/json' }],
                    actions: Array.from({ length: count }, (_, index) => ({ id: `inspect${index}`, title: 'Inspect',
                        scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe',
                        inputSchema: { type: 'object', properties: { value: { type: 'string', description: 'x'.repeat(4096) } } },
                        resultSchema: { type: 'object' },
                    })),
                } },
        }));
        const compiled = readGeneratedPluginCompiledAccountResourceIdsSync(root, pluginId);
        expect(compiled).not.toBeNull();
        return Buffer.byteLength(JSON.stringify(compiled));
    };
    expect(readWithActions(100)).toBe(readWithActions(1));
});

it('projects the adopted compiled Resource declaration instead of borrowing it from the moving source catalog', () => {
    const pluginId = 'acme.account-relay';
    const resource = { kindVersion: 1 as const, id: 'target-options', source: 'dynamic' as const, type: 'config' as const, scope: 'global' as const,
        execution: { target: 'account' as const, account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } };
    const declaration = { id: resource.id, source: resource.source, kind: resource.type, scope: resource.scope,
        execution: resource.execution, contentType: 'application/json' };
    const source = { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Relay', runtime: { apiVersion: 1 },
        contributes: { resources: [declaration] } };
    const root = mkdtempSync(join(tmpdir(), 'p43-compiled-'));
    roots.push(root);
    const graph = join(root, 'dist/happier-plugin-ui');
    mkdirSync(graph, { recursive: true });
    // Routing proves the Resource declaration, not artifact acquisition or successful activation.
    const previousArtifactDeclaration = { ...declaration, execution: { ...declaration.execution,
        account: { artifactId: 'previous-account-runtime', exportName: 'activatePreviousAccount' } } };
    for (const compiledResources of [[], [declaration], [previousArtifactDeclaration]]) {
        writeFileSync(join(graph, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD), JSON.stringify({ version: 2, packageName: '@acme/relay',
            manifest: { ...source, contributes: { resources: compiledResources } } }));
        const compiledAccountResourceIds = readGeneratedPluginCompiledAccountResourceIdsSync(root, pluginId);
        const registry = createResolvedContributionRegistry({ pluginDeclarations: [{ pluginId, pluginRootPath: root, manifestPath: '',
            daemonEntryPath: null, devDaemonEntryPath: null, sourceSpec: { kind: 'bundled', locator: '@acme/relay', trustPolicy: 'local_trusted', installPolicy: 'link' },
            manifest: normalizePluginManifestV2(source), ...(compiledAccountResourceIds ? { compiledAccountResourceIds } : {}),
        }], resources: [{ pluginId, pluginVersion: '1.0.0', identity: createPluginContributionIdentity({ pluginId, localId: resource.id }),
            definition: resource, provenance: 'first_party', sourceKind: 'bundled' }] });
        const projected = buildResourcesById(registry, [])[`${pluginId}/${resource.id}`];
        expect(PluginProjectedResourceV2Schema.parse(projected).accountRuntimeDeclared).toBe(compiledResources.length > 0);
    }
    expect(readGeneratedPluginCompiledAccountResourceIdsSync(root, 'acme.other')).toBeNull();
});
