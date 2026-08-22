import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ComposerContentHandleV1Schema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';
import { configuration } from '@/configuration';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActiveDaemonComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createMachine(id: string): Machine {
    return {
        id,
        encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'legacy',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

describe('executable plugin Composer content invocation binding', () => {
    it('stages media from a real daemon Action through the canonical PluginPath and transfer owners', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-composer-content-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-composer-content-plugin-'));
        const pluginId = 'acme.composer-content';
        const actionId = 'stage-photo';
        const machineId = 'machine-composer-content';
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const pluginDataRoot = join(paths.storageDir, pluginId, 'fs');
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let stagedHandle: ReturnType<typeof ComposerContentHandleV1Schema.parse> | null = null;
        let apiMachine: ApiMachineClient | null = null;
        const previousWorkingDirectory = process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;

        try {
            process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = pluginRoot;
            apiMachine = new ApiMachineClient('token', createMachine(machineId));
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'Composer content fixture',
                engines: { happier: '^0.2.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                hostAccess: {
                    required: [{
                        id: 'plugin-media',
                        capability: 'filesystem',
                        reason: 'Stage generated media',
                        scope: {
                            locations: [{ root: 'pluginData' }],
                            access: ['read'],
                        },
                    }],
                    optional: [],
                },
                contributes: {
                    actions: [{
                        id: actionId,
                        title: 'Stage photo',
                        scopes: ['global'],
                        surfaces: ['cli'],
                        execution: { target: 'daemon' },
                        placementBindings: ['primary'],
                        dangerLevel: 'safe',
                        hostAccess: ['plugin-media'],
                    }],
                },
            }), 'utf8');
            await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
                api.actions.register('${actionId}', async (_input, context) => (
                    await context.services.composerContent.stageMedia({
                        source: { root: 'pluginData', relativePath: 'photo.png' },
                        name: 'external-photo.png',
                        mimeType: 'image/png',
                        executionTarget: { serverId: 'forged', machineId: 'forged' },
                        owner: { pluginId: 'forged', localId: 'forged' }
                    })
                ));
            }`, 'utf8');
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId,
                manifestVersion: '1.0.0',
            });
            await mkdir(pluginDataRoot, { recursive: true });
            await writeFile(join(pluginDataRoot, 'photo.png'), PNG_BYTES);

            const contributes = createMergedContributionRegistry(
                projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }),
                    provenance: 'first_party',
                    existingAgentIds: new Set(),
                }),
                {},
            );
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                resolveCurrentMachineId: () => machineId,
                resolveComposerMediaStageTransferRpcHandler: () => (
                    apiMachine?.getPeerMediationMachineRpcHandlerManager() ?? null
                ),
            });
            await expect(runtime.activateContributionsOnDemand([{
                pluginId,
                family: 'actions',
                localId: actionId,
            }])).resolves.toEqual([expect.objectContaining({ pluginId, diagnostics: [] })]);
            const invocation = await runtime.targetActionInvocations?.invoke({
                pluginId,
                localId: actionId,
                input: {},
                surface: 'cli',
            });
            if (invocation?.status !== 'executed') {
                throw new Error(`Unexpected Composer content invocation: ${JSON.stringify(invocation)}`);
            }
            stagedHandle = ComposerContentHandleV1Schema.parse(invocation.value);
            expect(stagedHandle).toMatchObject({
                executionTarget: { serverId: configuration.activeServerId, machineId },
                owner: { pluginId, localId: actionId },
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'external-photo.png',
                sizeBytes: PNG_BYTES.byteLength,
            });
            await expect(createActiveDaemonComposerMediaStageStore({ machineId }).inspectForFinalization({
                handle: stagedHandle,
                executionTarget: stagedHandle.executionTarget,
                owner: stagedHandle.owner,
            })).resolves.toMatchObject({ status: 'ready', handle: stagedHandle });
        } finally {
            await runtime?.dispose();
            await apiMachine?.shutdown();
            if (stagedHandle) {
                await createActiveDaemonComposerMediaStageStore({ machineId }).release({
                    handle: stagedHandle,
                    executionTarget: stagedHandle.executionTarget,
                    owner: stagedHandle.owner,
                });
            }
            if (previousWorkingDirectory === undefined) {
                delete process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
            } else {
                process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = previousWorkingDirectory;
            }
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
});
