import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '../../rpc/methods.js';
import { resolveMachineRpcRoutePolicy } from '../peer/mediation/rpc/routePolicyV1.js';
import { MachineVitalsGetInputV1Schema, MachineVitalsSnapshotV1Schema, MachineVitalsWatchResultV1Schema } from './machineVitalsRpcV1.js';
import { MachineVitalsSampleV1Schema } from './machineVitalsSampleV1.js';

describe('Machine vitals V1 transport', () => {
    it('keeps optional off facts and drops unknown GPU presentation fields without changing known-field validation', () => {
        const sample = { v: 1, sampledAt: 1, intervalMs: 2000,
            cpu: { reported: false, reason: 'platform' }, memory: { reported: false, reason: 'platform' },
            disk: { reported: false, reason: 'platform' }, network: { reported: false, reason: 'platform' } };
        expect(MachineVitalsSampleV1Schema.parse({ ...sample, gpu: [{ name: 'GPU', powerState: 'off', futureDisplay: 'quiet' }] }).gpu)
            .toEqual([{ name: 'GPU', powerState: 'off' }]);
        expect(MachineVitalsSampleV1Schema.parse({ ...sample, gpu: [{ name: 'GPU', busyPct: 0 }] }).gpu)
            .toEqual([{ name: 'GPU', busyPct: 0 }]);
        expect(MachineVitalsSampleV1Schema.safeParse({ ...sample, gpu: [{ name: 'GPU', powerState: 'failed' }] }).success).toBe(false);
    });
    it('permits shared Machine Use reads over the ephemeral route', () => {
        for (const method of [RPC_METHODS.MACHINES_VITALS_GET, RPC_METHODS.MACHINES_VITALS_HISTORY_GET, RPC_METHODS.DAEMON_VITALS_WATCH]) {
            expect(resolveMachineRpcRoutePolicy(method)).toMatchObject({ routeClass: 'direct_ephemeral', sharedMachineAccess: 'use' });
        }
    });
    it('rejects extra authority or unbounded provider bags at every payload boundary', () => {
        expect(MachineVitalsGetInputV1Schema.safeParse({ machineId: 'm', accountId: 'other' }).success).toBe(false);
        expect(MachineVitalsWatchResultV1Schema.safeParse({ changed: false, data: {} }).success).toBe(false);
        expect(MachineVitalsSnapshotV1Schema.safeParse({ state: 'reporting', sample: null,
            series5m: { cpu: [{ t: 0, y: null, native: {} }], memory: [], networkRx: [], networkTx: [] } }).success).toBe(false);
    });
});
