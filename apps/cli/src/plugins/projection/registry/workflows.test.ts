import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginProjectionV2Schema, WorkflowDefinitionV1Schema, materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createWorkflowMaterializationHostV1 } from '@/session/actions/workflowMaterializationHost';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './resolvePluginContributions';
import { createResolvedContributionRegistry, createMergedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { readPluginWorkflowSources } from './workflows';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'wait', id: 'review',
    document: { text: 'Review the result.', references: [], attachments: [] }, result: { kind: 'text' },
}] });
const workflow = { id: 'review', title: 'Review the result', definition };

function loaded(pluginId: string, contributes: Record<string, unknown> = { workflows: [workflow] }): LoadedPlugin {
    const root = `/plugins/${pluginId}`;
    return { pluginId, pluginRootPath: root, manifestPath: `${root}/plugin.json`,
        daemonEntryPath: null, devDaemonEntryPath: null,
        sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
        manifest: normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Workflows',
            runtime: { apiVersion: 1 }, contributes,
        }),
    };
}

describe('plugin workflows through the canonical projection', () => {
    it('materializes a plugin-local Action through the projected executing-machine catalog', async () => {
        const pluginId = 'com.acme.post';
        const inputSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };
        const outputSchema = { type: 'object', properties: { posted: { type: 'boolean' } }, required: ['posted'], additionalProperties: false };
        const authored = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'send', actionId: 'post',
            input: { message: { kind: 'literal', value: 'Hello' } },
        }] });
        const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded(pluginId, {
            actions: [{ id: 'post', title: 'Post', scopes: ['machine'], surfaces: ['cli'], execution: { target: 'daemon' },
                inputSchema, resultSchema: outputSchema, dangerLevel: 'safe' }],
            workflows: [{ id: 'send', title: 'Send a message', definition: authored }],
        })], diagnosticsByPluginId: {} }, provenance: 'first_party' });
        const registry = createResolvedContributionRegistry({ ...inputs,
            occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) },
        });
        const projection = buildPluginProjectionV2({ registry, generation: 1 });
        const source = readPluginWorkflowSources(registry)[0]!;
        expect(source.definition.blocks[0]).toMatchObject({ actionId: `${pluginId}/post` });
        expect(projection.actionsById[`${pluginId}/post`]).toMatchObject({ id: 'post',
            occurrenceId: registry.occurrenceIdsByPluginId?.[pluginId],
        });
        const resolve = createWorkflowMaterializationHostV1({
            credentials: { token: 'plugin-workflow-test', encryption: null },
            readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
            // Only daemon RPC is substituted. Projection, family normalization,
            // exact-machine contract lookup and accepted-snapshot admission stay real.
            callMachineAction: async ({ method, machineId, request }) => {
                expect(machineId).toBe('run-machine');
                if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
                if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
                if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
                    expect(request).toMatchObject({ qualifiedActionId: `${pluginId}/post`, expectedOccurrenceId: registry.occurrenceIdsByPluginId?.[pluginId] });
                    const action = registry.actions.find((entry) => entry.identity?.pluginId === pluginId && entry.identity.localId === 'post')!;
                    return { ok: true, inputSchema: action.definition.inputSchema, outputSchema: action.definition.outputSchema };
                }
                throw new Error(`unexpected_machine_method:${method}`);
            },
        });
        const materialization = await resolve({ machineId: 'run-machine', directory: '/repo' });
        const accepted = await materializeWorkflowAcceptedSnapshotV1({ ...materialization, definition: source.definition,
            admission: { kind: 'user' }, context: { source: { kind: 'catalog', ref: source.workflow, version: source.version },
                inputs: {}, machineId: 'run-machine', executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
                authorization: { principal: { kind: 'host' } },
            },
        });
        expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ blockId: 'send', actionId: `${pluginId}/post`,
            actionInput: { message: 'Hello' }, actionContract: { inputSchema, outputSchema },
        }] } });
        expect(projection.familiesById.workflows?.entriesById[`${pluginId}/send`]).toMatchObject({
            definition: { definition: { blocks: [{ actionId: `${pluginId}/post` }] } },
        });
        expect(authored.blocks[0]).toMatchObject({ actionId: 'post' });
    });

    it('refuses semantically invalid workflow contributions before publishing the catalog', () => {
        const invalid = loaded('com.acme.invalid', { workflows: [{ ...workflow,
            definition: { ...definition, blocks: [definition.blocks[0], definition.blocks[0]] },
        }] });
        expect(() => projectLoadedPluginContributes({ loadResult: { loadedPlugins: [invalid], diagnosticsByPluginId: {} },
            provenance: 'first_party' })).toThrowError(expect.objectContaining({
                code: 'plugin_workflow_invalid', pluginId: 'com.acme.invalid', workflowId: 'review',
                issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate_id' })]),
            }));
    });

    it('admits a workflows-only plugin without executable activation and fences its source with the occurrence', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-workflows-'));
        const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [loaded('com.acme.review')], diagnosticsByPluginId: {} }, provenance: 'first_party',
        }));
        const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generation: 1,
            generationAuthority: { commit: null, generations: new Map(), rejectedGenerations: new Map(), isCurrent: async () => true },
        });
        try {
            expect(readPluginWorkflowSources(registry.contributes)).toHaveLength(1);
            registry.fencePluginConsumers?.(['com.acme.review']);
            expect(readPluginWorkflowSources(registry.contributes)).toEqual([]);
            expect(registry.contributes.workflows).toEqual([]);
        } finally {
            await registry.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('projects qualified definitions and version only while the source occurrence is current', () => {
        const pluginIds = ['com.acme.review', 'com.acme.other'];
        const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: pluginIds.map((pluginId) => loaded(pluginId)), diagnosticsByPluginId: {} }, provenance: 'first_party' });
        const registry = createResolvedContributionRegistry({ ...inputs,
            occurrenceIdsByPluginId: Object.fromEntries(pluginIds.map((id) => [id, createPluginRuntimeOccurrenceId(id)])),
        });
        const projection = buildPluginProjectionV2({ registry, generation: 1 });
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
        expect(projection.familiesById.workflows?.entriesById['com.acme.review/review']).toMatchObject({
            pluginId: 'com.acme.review', pluginVersion: '1.0.0', definition: workflow,
        });
        expect(readPluginWorkflowSources(registry)).toEqual(pluginIds.slice().reverse().map((pluginId) => ({
            workflow: `plugin:${pluginId}/review`, pluginId, version: '1.0.0',
            title: workflow.title, definition,
        })));
        expect(createMergedContributionRegistry({ workflows: registry.workflows }, {}).workflows).toEqual(registry.workflows);
        const withdrawn = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} });
        expect(readPluginWorkflowSources(withdrawn)).toEqual([]);
        expect(buildPluginProjectionV2({ registry: withdrawn, generation: 2 }).familiesById.workflows?.entriesById).toEqual({});
        const uninstalled = createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [], diagnosticsByPluginId: {} }, provenance: 'first_party',
        }));
        expect(buildPluginProjectionV2({ registry: uninstalled, generation: 3 }).familiesById.workflows?.entriesById).toEqual({});
        expect(readPluginWorkflowSources(uninstalled)).toEqual([]);
    });
});
