import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseStatsObservationV1, DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { getPersistenceStorage, clearPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { createDatabaseStatsLastLook } from './lastLook';

const target: DatabaseTargetV1 = {
    kind: 'deployment_service', environment: { serverId: 'home', projectSourceId: 'project-source', environmentId: 'env' },
    deploymentId: 'deployment', targetLinkId: 'target-link', serviceId: 'postgres', database: 'app',
};
const scope = { serverId: 'home', accountId: 'viewer' };
const observation = (calls: string, observedAtMs: number): Extract<DatabaseStatsObservationV1, { status: 'available'; group: 'statements' }> => ({
    v: 1, engineId: 'postgresql', status: 'available', group: 'statements', observedAtMs,
    scope: { database: 'app' }, intervalBasis: { bindingKey: 'bound-service', databaseIdentity: '16384', selectionKey: 'top-statements', statsResetAt: 'first-reset' },
    coverage: { status: 'complete' }, completeness: { complete: false, reason: 'page' },
    data: [{ key: 'shown', database: 'app', shape: 'SELECT private_shape FROM accounts', calls, totalTimeMs: Number(calls) * 2, rows: calls, nativeTimeUnit: 'milliseconds' },
        { key: 'not-shown', database: 'app', shape: 'SELECT hidden_shape', calls: '100', totalTimeMs: 200, rows: '100', nativeTimeUnit: 'milliseconds' }],
});

afterEach(() => { vi.restoreAllMocks(); clearPersistenceStorage(); });

describe('device-local database last look', () => {
    it('holds the preceding-open baseline, writes only shown tuples once and uses the next open rather than refresh as last look', () => {
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        const first = createDatabaseStatsLastLook(scope, target);
        expect(writes).not.toHaveBeenCalled();
        expect(first.observe(observation('10', 1000), ['shown']).comparison).toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
        expect(writes).toHaveBeenCalledTimes(1);
        first.observe(observation('20', 2000), ['shown']);
        expect(writes).toHaveBeenCalledTimes(1);
        const second = createDatabaseStatsLastLook(scope, target);
        const comparison = second.observe(observation('30', 3000), ['shown']).comparison;
        expect(comparison).toMatchObject({ status: 'available', fromMs: 1000, rows: [{ key: 'shown', calls: '20', totalTimeMs: 40, rows: '20' }] });
        expect(writes).toHaveBeenCalledTimes(2);
        expect(second.observe(observation('40', 4000), ['shown']).comparison).toMatchObject({ status: 'available', fromMs: 1000, rows: [{ calls: '30' }] });
        expect(writes).toHaveBeenCalledTimes(2);
        const stored = writes.mock.calls.at(-1)?.[1];
        expect(typeof stored).toBe('string');
        expect(JSON.parse(String(stored))).toMatchObject({ observedAtMs: 3000, rows: [{ key: 'shown', calls: '30' }] });
        expect(String(stored)).not.toContain('private_shape');
        expect(String(stored)).not.toContain('not-shown');
        expect(String(stored)).not.toContain('hidden_shape');
    });

    it('preserves a usable baseline through partial observations and delegates resets and complete scope isolation to their owners', () => {
        createDatabaseStatsLastLook(scope, target).observe(observation('10', 1000), ['shown']);
        const partial = observation('20', 2000);
        partial.coverage = { status: 'partial', reasons: ['visibility_restricted'] };
        expect(createDatabaseStatsLastLook(scope, target).observe(partial, ['shown']).comparison).toEqual({ status: 'unavailable', reason: 'partial_observation' });
        expect(createDatabaseStatsLastLook(scope, target).observe(observation('30', 3000), ['shown']).comparison).toMatchObject({ status: 'available', fromMs: 1000 });
        const reset = observation('2', 4000);
        reset.intervalBasis.statsResetAt = 'new-reset';
        expect(createDatabaseStatsLastLook(scope, target).observe(reset, ['shown']).comparison).toEqual({ status: 'unavailable', reason: 'comparison_unavailable' });
        expect(createDatabaseStatsLastLook({ ...scope, accountId: 'other' }, target).observe(observation('50', 5000), ['shown']).comparison).toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
        expect(createDatabaseStatsLastLook({ ...scope, serverId: 'other' }, target).observe(observation('50', 5000), ['shown']).comparison).toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
        expect(createDatabaseStatsLastLook(scope, { ...target, database: 'another' }).observe(observation('50', 5000), ['shown']).comparison).toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
    });

    it('keeps read results and the previous baseline usable when the device rejects a write', () => {
        createDatabaseStatsLastLook(scope, target).observe(observation('10', 1000), ['shown']);
        vi.spyOn(getPersistenceStorage(), 'set').mockImplementationOnce(() => { throw new Error('device storage unavailable'); });
        const result = createDatabaseStatsLastLook(scope, target).observe(observation('20', 2000), ['shown']);
        expect(result.comparison).toMatchObject({ status: 'available', fromMs: 1000, rows: [{ calls: '10' }] });
        expect(result.persistenceError).toMatchObject({ name: 'UiStatePersistenceError' });
        expect(createDatabaseStatsLastLook(scope, target).observe(observation('30', 3000), ['shown']).comparison)
            .toMatchObject({ status: 'available', fromMs: 1000, rows: [{ calls: '20' }] });
    });

    it('retains Windows worktree identities through the web device-storage boundary', () => {
        const windows: DatabaseTargetV1 = {
            kind: 'worktree', accountId: 'viewer', installationId: 'install', projectKey: 'project',
            workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: 'C:\\work' },
            source: { kind: 'env_file', path: 'C:\\work\\.env', variable: 'DATABASE_URL' },
        };
        expect(createDatabaseStatsLastLook(scope, windows).observe(observation('10', 1000), ['shown']).persistenceError).toBeNull();
        expect(createDatabaseStatsLastLook(scope, windows).observe(observation('20', 2000), ['shown']).comparison)
            .toMatchObject({ status: 'available', fromMs: 1000, rows: [{ calls: '10' }] });
    });
});
