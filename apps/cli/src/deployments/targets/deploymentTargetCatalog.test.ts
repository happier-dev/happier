import { describe, expect, it } from 'vitest';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DeploymentTargetRoleInputProtocolSchemasV1,
    DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/v2';
import { DeploymentTargetVariablesReadResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetVariablesV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { listDeploymentTargetsV1, OWN_SERVER_DEPLOYMENT_TARGET_V1, readDeploymentTargetV1 } from './deploymentTargetCatalog';
import { admitOwnServerDeploymentTargetLink } from './ownServer/ownServerTargetAdmission';
import { manifest as vercelManifest } from '../../../../../packages/plugins/deploy-vercel/src/manifest';
import { manifest as cloudflareManifest } from '../../../../../packages/plugins/deploy-cloudflare/src/manifest';

const closed = { type: 'object', properties: {}, additionalProperties: false } as const;

function admittedRegistry(role: 'runtime' | 'data' = 'runtime', previewInput = false) {
    const pluginId = 'example.deploy';
    const manifest = normalizePluginManifestV2({
        schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'External target',
        entrypoints: { daemon: './daemon.js' },
        contributes: {
            actions: (['inspect', 'link', 'deploy', 'observe', 'cancel', 'read'] as const).map(id => ({
                id, title: id, scopes: ['global'], surfaces: ['plugin'], execution: { target: 'daemon' },
                inputSchema: id === 'read' ? role === 'data'
                    ? DeploymentTargetRoleInputProtocolSchemasV1['projects.observe'].jsonSchema
                    : DeploymentTargetRoleInputProtocolSchemasV1['variables.read'].jsonSchema
                    : DeploymentTargetRoleInputProtocolSchemasV1[id].jsonSchema,
                resultSchema: id === 'read' ? role === 'data' ? DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema : DeploymentTargetVariablesReadResultV1ProtocolSchema.jsonSchema
                    : DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema,
                dangerLevel: ['inspect', 'observe', 'read'].includes(id) ? 'safe' : 'writesLocal',
                ...(id === 'read' ? { readOnly: true } : {}),
            })),
            resources: [{ id: 'projects/list', source: 'dynamic', kind: 'config', contentType: 'application/json', execution: { target: 'daemon' } }],
            deploymentTargets: role === 'data' ? [{ id: 'database', targetKind: 'example', title: 'External data',
                role: 'data', icon: 'server-outline', targetSchema: closed, linkSchema: closed,
                dataV1: { database: { engineId: 'example-engine' }, projects: { list: 'projects/list', observe: 'read' },
                    ...(previewInput ? { branches: { previewInput: { name: { kind: 'input', name: 'preview', path: ['name'] } } } } : {}) } }] : [{ id: 'own-server', targetKind: 'example', title: 'External target',
                role: 'runtime', icon: 'server-outline', targetSchema: closed, linkSchema: closed,
                actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe',
                    cancel: 'cancel', variables: { read: 'read' } } }],
        },
    });
    return registryFromManifest(manifest);
}

function registryFromManifest(manifest: LoadedPlugin['manifest']) {
    const pluginId = manifest.id;
    const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/example', manifestPath: '/plugins/example/plugin.json',
        daemonEntryPath: '/plugins/example/daemon.js', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    return createResolvedContributionRegistry({ ...inputs,
        occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
}

describe('deployment target catalog at the admitted registry boundary', () => {
    it('preserves supported output and prerequisite facts from real target manifests through admission and normalization', () => {
        const declarations = [vercelManifest, cloudflareManifest].flatMap(manifest =>
            registryFromManifest(normalizePluginManifestV2(manifest)).deploymentTargets ?? []);
        const targets = listDeploymentTargetsV1(declarations);
        expect(Object.fromEntries(targets.map(target => [target.targetKind, { accepts: target.accepts, needs: target.needs }])))
            .toEqual({
                ownServer: { accepts: ['static', 'server', 'container', 'compose'], needs: [] },
                vercel: { accepts: ['static', 'server'], needs: ['repository', 'stateless'] },
                'cloudflare-workers': { accepts: ['workers'], needs: ['repository', 'stateless'] },
                'cloudflare-pages': { accepts: ['static'], needs: ['repository', 'stateless'] },
            });
    });

    it('retains plugin preview bindings without treating their operands as contribution references', () => {
        const declarations = admittedRegistry('data', true).deploymentTargets ?? [];
        const target = readDeploymentTargetV1({ kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } }, declarations);
        expect(target).toMatchObject({ dataV1: { branches: { previewInput: {
            name: { kind: 'input', name: 'preview', path: ['name'] },
        } } } });
    });
    it('projects admitted data Resources and Actions through the same catalog without runtime roles', () => {
        const declarations = admittedRegistry('data').deploymentTargets ?? [];
        const targets = listDeploymentTargetsV1(declarations);
        expect(targets).toHaveLength(2);
        const source = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } } as const;
        const target = readDeploymentTargetV1(source, declarations);
        expect(target).toMatchObject({ role: 'data', source, dataV1: {
            projects: { list: { kind: 'plugin', resourceId: 'example.deploy/projects/list' } },
            database: { engineId: 'example-engine' },
        } });
        expect(target).not.toHaveProperty('actions');
        expect(target).not.toHaveProperty('dataV1.branches');
        expect(readDeploymentTargetV1(source)).toBeNull();
    });

    it('lists admitted plugin roles alongside the host without conflating their identities', () => {
        const registry = admittedRegistry();
        const declarations = registry.deploymentTargets ?? [];
        const listTargets: (rows: typeof declarations) => ReturnType<typeof listDeploymentTargetsV1> = listDeploymentTargetsV1;
        const readTarget: (source: Parameters<typeof readDeploymentTargetV1>[0], rows: typeof declarations) => ReturnType<typeof readDeploymentTargetV1> = readDeploymentTargetV1;
        const targets = listTargets(declarations);
        expect(targets).toHaveLength(2);
        expect(readTarget(OWN_SERVER_DEPLOYMENT_TARGET_V1.source, declarations))
            .toEqual(OWN_SERVER_DEPLOYMENT_TARGET_V1);
        expect(OWN_SERVER_DEPLOYMENT_TARGET_V1).toMatchObject({ actions: {
            teardown: { kind: 'host', actionId: 'deployments.teardown' },
        } });
        const source = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'own-server' } } as const;
        const plugin = readTarget(source, declarations);
        if (!plugin || plugin.role !== 'runtime') throw new Error('Expected the admitted runtime target.');
        expect(plugin.id).toBe(OWN_SERVER_DEPLOYMENT_TARGET_V1.id);
        expect(plugin).toMatchObject({ source, targetKind: 'example', actions: {
            cancel: { kind: 'plugin', actionId: formatQualifiedPluginActionId({ pluginId: 'example.deploy', localId: 'cancel' }) },
            variables: { read: { kind: 'plugin', actionId: formatQualifiedPluginActionId({ pluginId: 'example.deploy', localId: 'read' }) } },
        } });
        expect(plugin.actions.rollback).toBeUndefined();
        expect(readTarget({ kind: 'plugin', contribution: { pluginId: 'other.plugin', localId: 'own-server' } }, declarations)).toBeNull();
    });

    it('admits the real host member and coordinator while refusing a plugin with the same local id', () => {
        const link = createDeploymentEnvironmentDetailV1().targetLinks[0].targetLink;
        expect(() => admitOwnServerDeploymentTargetLink(link, link.members[0].machineId)).not.toThrow();
        expect(() => admitOwnServerDeploymentTargetLink(link, 'controller', 'controller')).not.toThrow();
        expect(() => admitOwnServerDeploymentTargetLink({ ...link,
            source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'own-server' } },
        }, link.members[0].machineId)).toThrowError(expect.objectContaining({ code: 'target_mismatch' }));
        expect(() => admitOwnServerDeploymentTargetLink({ ...link, targetKind: 'other' }, link.members[0].machineId))
            .toThrowError(expect.objectContaining({ code: 'target_mismatch' }));
    });
});
