import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDaemonSessionHandoffMetadataBridge } from './createDaemonSessionHandoffMetadataBridge';
import type { TrackedSession } from '../types';

describe('createDaemonSessionHandoffMetadataBridge', () => {
    const createdDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(createdDirs.splice(0).map(async (directory) => {
            await rm(directory, { recursive: true, force: true });
        }));
    });

    it('reads the current machine id when loading local handoff metadata and exposes the persisted store lookup', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'daemon-handoff-bridge-'));
        createdDirs.push(activeServerDir);

        let currentMachineId = 'machine-initial';
        const trackedSession: TrackedSession = {
            startedBy: 'daemon',
            pid: 101,
            happySessionId: 'sess-live-machine',
            vendorResumeId: 'vendor-live-machine',
            spawnOptions: {
                directory: '/repo-source-current',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'claude',
                    sourceKind: 'built_in',
                },
                transcriptStorage: 'direct',
                environmentVariables: {
                    HOME: '/Users/target',
                    CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                },
            },
        };

        const bridge = createDaemonSessionHandoffMetadataBridge({
            pidToTrackedSession: new Map([[trackedSession.pid, trackedSession]]),
            getMachineId: () => currentMachineId,
            activeServerDir,
        });

        currentMachineId = 'machine-rotated';

        await expect(bridge.loadLocalSessionMetadataForHandoff('sess-live-machine')).resolves.toEqual(
            expect.objectContaining({
                exportMetadata: expect.objectContaining({
                    machineId: 'machine-rotated',
                    path: '/repo-source-current',
                    homeDir: '/Users/target',
                    flavor: 'claude',
                }),
                runtimeLocalMetadata: expect.objectContaining({
                    claudeSessionId: 'vendor-live-machine',
                    directSessionV1: expect.objectContaining({
                        machineId: 'machine-rotated',
                        remoteSessionId: 'vendor-live-machine',
                    }),
                }),
            }),
        );

        await bridge.savePreparedTargetLocalMetadata({
            remoteSessionId: 'remote-session-1',
            exportMetadataOverlay: {
                handoffV1: {
                    v: 1,
                    sourceMachineId: 'machine-source',
                    targetMachineId: 'machine-rotated',
                    providerId: 'claude',
                    sessionStorageBefore: 'direct',
                    sessionStorageAfter: 'direct',
                    transportStrategy: 'direct_peer',
                    completedAtMs: 1,
                },
            },
        });

        await expect(bridge.loadLocalHandoffMetadataByVendorResumeId('remote-session-1')).resolves.toEqual({
            handoffV1: {
                v: 1,
                sourceMachineId: 'machine-source',
                targetMachineId: 'machine-rotated',
                providerId: 'claude',
                sessionStorageBefore: 'direct',
                sessionStorageAfter: 'direct',
                transportStrategy: 'direct_peer',
                completedAtMs: 1,
            },
        });
    });
});
