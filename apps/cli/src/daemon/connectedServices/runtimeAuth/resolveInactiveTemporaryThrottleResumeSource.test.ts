import { describe, expect, it } from 'vitest';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { resolveInactiveTemporaryThrottleResumeSource } from './resolveInactiveTemporaryThrottleResumeSource';

function rawSession(overrides: Partial<RawSessionRecord>): RawSessionRecord {
    // RawSessionRecord is a protocol fixture; this helper only reads path and machineId.
    return overrides as RawSessionRecord;
}

describe('resolveInactiveTemporaryThrottleResumeSource', () => {
    // RD-REC-16 port: temporary-throttle resume snapshots are memory-only while the intent
    // is durable. After a daemon restart, a hydrated intent must be able to rebuild a
    // resume source from persisted session metadata instead of dead-lettering with
    // temporary_throttle_session_not_found.
    it('rebuilds a metadata-driven resume source for a session with no tracked child', async () => {
        const source = await resolveInactiveTemporaryThrottleResumeSource({
            sessionId: 'session-1',
            fallbackMachineId: 'machine-1',
            fetchSession: async (sessionId) => rawSession({
                id: sessionId,
                path: '/repo/project',
                machineId: 'machine-1',
            }),
            decryptSessionMetadata: () => ({
                flavor: 'claude',
                path: '/repo/project',
            }),
        });

        expect(source).not.toBeNull();
        expect(source?.happySessionId).toBe('session-1');
        expect(source?.spawnOptions).toMatchObject({
            existingSessionId: 'session-1',
            directory: '/repo/project',
            machineId: 'machine-1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        });
    });

    it('returns null when the session cannot be fetched', async () => {
        const source = await resolveInactiveTemporaryThrottleResumeSource({
            sessionId: 'session-1',
            fallbackMachineId: 'machine-1',
            fetchSession: async () => null,
            decryptSessionMetadata: () => ({ flavor: 'claude', path: '/repo/project' }),
        });
        expect(source).toBeNull();
    });

    it('returns null when metadata cannot be decrypted', async () => {
        const source = await resolveInactiveTemporaryThrottleResumeSource({
            sessionId: 'session-1',
            fallbackMachineId: 'machine-1',
            fetchSession: async (sessionId) => rawSession({ id: sessionId, path: '/repo/project' }),
            decryptSessionMetadata: () => null,
        });
        expect(source).toBeNull();
    });

    it('returns null when persisted metadata cannot produce spawn options', async () => {
        const source = await resolveInactiveTemporaryThrottleResumeSource({
            sessionId: 'session-1',
            fallbackMachineId: 'machine-1',
            fetchSession: async (sessionId) => rawSession({ id: sessionId }),
            // No agent id and no path: the inactive resume builder must refuse.
            decryptSessionMetadata: () => ({}),
        });
        expect(source).toBeNull();
    });

    it('swallows fetch failures into a null source (recovery stays scheduler-owned)', async () => {
        const source = await resolveInactiveTemporaryThrottleResumeSource({
            sessionId: 'session-1',
            fallbackMachineId: 'machine-1',
            fetchSession: async () => {
                throw new Error('network down');
            },
            decryptSessionMetadata: () => ({ flavor: 'claude', path: '/repo/project' }),
        });
        expect(source).toBeNull();
    });
});
