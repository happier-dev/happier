import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createDaemonSessionHandoffMetadataBridge } from './createDaemonSessionHandoffMetadataBridge';
import type { TrackedSession } from '../types';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('createDaemonSessionHandoffMetadataBridge', () => {
    it('resolves an attachment directory only for an exact currently hosted Happier Session', async () => {
        const tracked: TrackedSession = {
            trackingKey: legacyPidSessionTrackingKey(301), startedBy: 'daemon', pid: 301, happySessionId: 'session-a', vendorResumeId: 'vendor-a',
            spawnOptions: {
                directory: '/repo-session-a',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                transcriptStorage: 'direct',
            },
        };
        const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
        const bridge = createDaemonSessionHandoffMetadataBridge({ trackedSessionsByKey, getMachineId: () => 'machine-a' });
        expect(bridge).toHaveProperty('resolveHostedSessionWorkingDirectory');
        // This owner gains the exact Session-only resolver before transfer consumers use it.
        const resolveDirectory = (bridge as unknown as Readonly<{
            resolveHostedSessionWorkingDirectory: (sessionId: string) => Promise<string | null>;
        }>).resolveHostedSessionWorkingDirectory;
        await expect(resolveDirectory('session-a')).resolves.toBe('/repo-session-a');
        await expect(resolveDirectory('vendor-a')).resolves.toBeNull();
        await expect(resolveDirectory('foreign-session')).resolves.toBeNull();
        trackedSessionsByKey.delete(legacyPidSessionTrackingKey(tracked.pid));
        await expect(resolveDirectory('session-a')).resolves.toBeNull();
    });

    it('reads the current machine id when loading current tracked-session metadata', async () => {
        let currentMachineId = 'machine-initial';
        const trackedSession: TrackedSession = {
            trackingKey: legacyPidSessionTrackingKey(101), startedBy: 'daemon',
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
            trackedSessionsByKey: new Map([[trackedSession.trackingKey, trackedSession]]),
            getMachineId: () => currentMachineId,
        });

        currentMachineId = 'machine-rotated';

        await expect(bridge.loadLocalSessionMetadataForHandoff('sess-live-machine')).resolves.toEqual({
            exportMetadata: {
                machineId: 'machine-rotated',
                path: '/repo-source-current',
                homeDir: homedir(),
                flavor: 'claude',
            },
        });

    });

    it('matches provider-only handoff ids exactly while keeping Happier id normalization', async () => {
        const opaqueVendorResumeId = ' provider-only-session\n';
        const opaqueSpawnResumeId = '\tspawn-only-session ';
        const providerOnlySession: TrackedSession = {
            trackingKey: legacyPidSessionTrackingKey(202), startedBy: 'daemon',
            pid: 202,
            vendorResumeId: opaqueVendorResumeId,
            spawnOptions: {
                directory: '/repo-provider-only',
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
        const happierIdentifiedSession: TrackedSession = {
            trackingKey: legacyPidSessionTrackingKey(203), startedBy: 'daemon',
            pid: 203,
            happySessionId: 'happier-session-id',
            happySessionMetadataFromLocalWebhook: {
                machineId: 'machine-source',
                path: '/repo-happier-id',
                host: 'localhost',
                homeDir: '/Users/target',
                happyHomeDir: '/Users/target/.happier',
                happyLibDir: '/Users/target/.happier/lib',
                happyToolsDir: '/Users/target/.happier/tools',
                flavor: 'claude',
            },
        };
        const spawnResumeOnlySession: TrackedSession = {
            trackingKey: legacyPidSessionTrackingKey(204), startedBy: 'daemon',
            pid: 204,
            spawnOptions: {
                directory: '/repo-spawn-resume-only',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'claude',
                    sourceKind: 'built_in',
                },
                resume: opaqueSpawnResumeId,
                transcriptStorage: 'direct',
                environmentVariables: {
                    HOME: '/Users/target',
                    CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                },
            },
        };
        const bridge = createDaemonSessionHandoffMetadataBridge({
            trackedSessionsByKey: new Map([
                [providerOnlySession.trackingKey, providerOnlySession],
                [happierIdentifiedSession.trackingKey, happierIdentifiedSession],
                [spawnResumeOnlySession.trackingKey, spawnResumeOnlySession],
            ]),
            getMachineId: () => 'machine-current',
        });
        await expect(bridge.loadLocalSessionMetadataForHandoff(opaqueVendorResumeId)).resolves.toEqual(
            expect.objectContaining({
                exportMetadata: expect.objectContaining({
                    path: '/repo-provider-only',
                }),
            }),
        );
        await expect(
            bridge.loadLocalSessionMetadataForHandoff(opaqueVendorResumeId.trim()),
        ).resolves.toBeNull();
        await expect(bridge.loadLocalSessionMetadataForHandoff(' \n\t ')).resolves.toBeNull();
        await expect(
            bridge.loadLocalSessionMetadataForHandoff(opaqueSpawnResumeId),
        ).resolves.toEqual(
            expect.objectContaining({
                exportMetadata: expect.objectContaining({
                    path: '/repo-spawn-resume-only',
                }),
            }),
        );
        await expect(
            bridge.loadLocalSessionMetadataForHandoff(opaqueSpawnResumeId.trim()),
        ).resolves.toBeNull();
        await expect(
            bridge.loadLocalSessionMetadataForHandoff('  happier-session-id\n'),
        ).resolves.toEqual(
            expect.objectContaining({
                exportMetadata: expect.objectContaining({
                    path: '/repo-happier-id',
                }),
            }),
        );
    });
});
