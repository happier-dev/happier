import { rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol';

import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { readProcessIdentityByPid } from '../processIdentity';
import { findAllHappyProcesses, findHappyProcessByPid } from '../doctor';
import { hashProcessCommand, listSessionMarkers, removeSessionMarker, writeSessionMarker } from '../sessionRegistry';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import type { TrackedSession } from '../types';
import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// Process discovery is an OS boundary; marker custody and directory records stay real.
vi.mock('../doctor', () => ({ findAllHappyProcesses: vi.fn(async () => []), findHappyProcessByPid: vi.fn(async () => null) }));

describe('managed directory reattach', () => {
    it('retains exact-process stop custody while reporting a missing managed directory', async () => {
        const owner = createManagedSessionDirectories();
        const sessionCreationTag = SessionCreationTagV1Schema.parse(`create:v1:${'r'.repeat(43)}`);
        const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag });
        const sessionId = `managed-reattach-${process.pid}`;
        await owner.bind({ allocationId: allocation.allocationId, sessionId });
        const identity = await readProcessIdentityByPid(process.pid);
        if (!identity?.processStartTimeMs) throw new Error('The fixture needs the current process generation');
        const command = identity.command;
        const processInfo = { pid: process.pid, command, type: 'daemon-spawned-session' };
        vi.mocked(findAllHappyProcesses).mockResolvedValue([processInfo]);
        vi.mocked(findHappyProcessByPid).mockResolvedValue(processInfo);
        const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
            directory: allocation.directory, sessionCreationTag,
            backendTarget: { kind: 'backend', backendId: 'my-acp', configuredBackendId: 'my-acp', sourceKind: 'configured' },
        });
        if (!respawn) throw new Error('The fixture needs a valid recovery descriptor');
        try {
            await writeSessionMarker({
                trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: sessionId,
                startedBy: 'daemon', cwd: allocation.directory, processCommand: command,
                processCommandHash: hashProcessCommand(command), processStartTimeMs: identity.processStartTimeMs,
                metadata: { path: allocation.directory, sessionDirectoryV1: { v: 1, kind: 'managed' } },
                respawn,
            });
            expect((await listSessionMarkers({ requireComplete: true })).find((marker) => marker.pid === process.pid)).toMatchObject({
                happySessionId: sessionId,
                processStartTimeMs: identity.processStartTimeMs,
                respawn: {
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
                        definitionId: 'my-acp',
                    },
                },
            });
            await rm(allocation.directory, { recursive: true });
            const tracked = new Map<SessionTrackingKey, TrackedSession>();
            const result = await reattachTrackedSessionsFromMarkers({ trackedSessionsByKey: tracked });
            expect(result).toMatchObject({ directoryMissingSessions: [{ sessionId, errorCode: 'SESSION_DIRECTORY_MISSING' }] });
            expect(tracked.get(legacyPidSessionTrackingKey(process.pid))).toMatchObject({ happySessionId: sessionId, processStartTimeMs: identity.processStartTimeMs });
            expect(tracked.get(legacyPidSessionTrackingKey(process.pid))?.spawnOptions).toMatchObject({ directoryKind: 'managed', approvedNewDirectoryCreation: false });
            expect((await listSessionMarkers()).some((marker) => marker.pid === process.pid)).toBe(true);
            expect(result.recoveredLiveSessionIds ?? []).not.toContain(sessionId);
        } finally {
            await removeSessionMarker(legacyPidSessionTrackingKey(process.pid));
            await owner.removeForSession({ sessionId, stopSession: async () => ({ status: 'not_found' }) });
        }
    });
});
