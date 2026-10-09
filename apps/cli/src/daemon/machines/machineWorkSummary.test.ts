import { describe, expect, it } from 'vitest';

import { projectMachineWorkSummary } from './machineWorkSummary';
import { createManagedActivityInventory } from '../lifecycle/managedActivity';
import { createActionOperationStore } from '../actionOperations/actionOperationStore';
import { createSessionLiveWorkProducer } from '../lifecycle/sessionLiveWorkProducer';
import type { TrackedSession } from '../types';

const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
const attribution = { ...target, accountId: 'bob' };
const requesterIdentities = new Map([['bob', { accountId: 'bob', displayName: 'Bob' }]]);

describe('projectMachineWorkSummary', () => {
    it('preserves distinct opaque owner occurrences even when their structures match', () => {
        const first = Object.freeze({});
        const second = Object.freeze({});
        expect(projectMachineWorkSummary({ target, custodianAccountId: 'alice', requesterIdentities,
            inventory: { coverage: 'complete', items: [
                { category: 'session', state: 'active', attribution, ownerRef: first },
                { category: 'session', state: 'active', attribution, ownerRef: second },
                { category: 'session', state: 'active', attribution, ownerRef: first },
            ] },
        })).toEqual({ kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions: 2, tasks: 0, terminals: 0 },
        ] });
    });
    it('counts an idle hosted Session while retention is idle, then removes it when its tracked process retires', async () => {
        let sessions: TrackedSession[] = [{ pid: 1, startedBy: 'daemon', happySessionId: 'private-session', requesterWorkAttributionV1: attribution }];
        const producer = createSessionLiveWorkProducer({ readSessions: () => sessions,
            // The live Session RPC is the boundary: a committed idle runtime is still hosted.
            readActivity: async () => ({ session: 'settled', input: 'settled' }),
        });
        const inventory = createManagedActivityInventory({ producers: [producer] });
        const project = async () => projectMachineWorkSummary({ inventory: await inventory.read(), target,
            custodianAccountId: 'alice', requesterIdentities });
        expect((await inventory.readDecision()).kind).toBe('idle');
        expect(await project()).toEqual({ kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 },
        ] });
        sessions = [];
        producer.notifyChanged();
        expect(await project()).toEqual({ kind: 'current', requesters: [] });
        inventory.dispose();
    });
    it('consumes the same real operation inventory as retention, deduplicating custody and failing unknown closed', async () => {
        const store = createActionOperationStore();
        const source = { read: store.readLiveWork, subscribe: store.subscribe };
        const inventory = createManagedActivityInventory({ producers: [source, source], now: () => 10 });
        const project = async () => projectMachineWorkSummary({ inventory: await inventory.read(),
            target, custodianAccountId: 'alice', requesterIdentities });
        store.create({ operationId: 'private-operation', actionId: 'projects.script.run', title: 'Command',
            scope: { accountId: attribution.accountId, machineId: target.machineId },
            requesterWorkAttributionV1: attribution, cancellation: 'supported', inputIdentity: '{}' });
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['finite'] });
        expect(await project()).toEqual({ kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
        ] });
        store.updateObservation('private-operation', { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' });
        expect((await inventory.readDecision()).kind).toBe('unknown');
        expect(await project()).toEqual({ kind: 'unavailable' });
        store.cancel('private-operation');
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 10 });
        expect(await project()).toEqual({ kind: 'current', requesters: [] });
        inventory.dispose();
    });
    it('projects work by others without adding the Machine custodian to that audience', () => {
        const params = {
            target, custodianAccountId: 'alice',
            requesterIdentities: new Map([
                ...requesterIdentities,
                ['alice', { accountId: 'alice', displayName: 'Alice' }],
            ]),
            inventory: { coverage: 'complete', items: [
                { category: 'session', state: 'active', attribution: { ...target, accountId: 'alice' }, ownerRef: 'alice-session' },
                { category: 'session', state: 'active', attribution, ownerRef: 'bob-session' },
            ] },
        } as const;
        expect(projectMachineWorkSummary(params)).toEqual({ kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 },
        ] });
    });

    it('projects active work once and excludes associated task terminals and retained output', () => {
        const terminal = { terminalId: 'task-terminal' };
        const task = { operationId: 'task' };
        const summary = projectMachineWorkSummary({ target, custodianAccountId: 'alice', requesterIdentities, inventory: {
            coverage: 'complete', items: [
                { category: 'session', state: 'active', attribution, ownerRef: { sessionId: 'session' } },
                { category: 'finite', state: 'active', attribution, ownerRef: task, associatedTerminal: terminal },
                { category: 'execution_run', state: 'active', attribution, ownerRef: task },
                { category: 'workflow_run', state: 'active', attribution, ownerRef: { runId: 'workflow' } },
                { category: 'terminal', state: 'active', attribution, ownerRef: terminal },
                { category: 'terminal', state: 'active', attribution, ownerRef: { terminalId: 'shell' } },
                { category: 'finite', state: 'settled', attribution, ownerRef: { operationId: 'retained-output' } },
            ],
        } });
        expect(summary).toEqual({ kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 2, terminals: 1 },
        ] });
        expect(JSON.stringify(summary)).not.toMatch(/task-terminal|operationId|sessionId|runId|retained-output/);
    });

    it('keeps retention-only work out of the public three count columns', () => {
        expect(projectMachineWorkSummary({ target, custodianAccountId: 'alice', requesterIdentities, inventory: {
            coverage: 'complete', items: [
                { category: 'service', state: 'active', attribution: { kind: 'unknown' }, ownerRef: 'service' },
                { category: 'transfer', state: 'unknown', attribution: { kind: 'unknown' }, ownerRef: 'transfer' },
            ],
        } })).toEqual({ kind: 'current', requesters: [] });
    });

    it('returns unavailable for unproven relevant coverage, liveness, attribution or identity', () => {
        const item = { category: 'session', state: 'active', attribution, ownerRef: 'session' } as const;
        for (const inventory of [
            { coverage: 'unknown', items: [] } as const,
            { coverage: 'complete', items: [{ ...item, state: 'unknown' }] } as const,
            { coverage: 'complete', items: [{ ...item, attribution: { kind: 'unknown' } }] } as const,
            { coverage: 'complete', items: [{ ...item, attribution: { ...attribution, installationId: 'old' } }] } as const,
            { coverage: 'complete', items: [{ ...item, attribution: { ...attribution, accountId: 'missing' } }] } as const,
        ]) {
            expect(projectMachineWorkSummary({ target, custodianAccountId: 'alice', requesterIdentities, inventory })).toEqual({ kind: 'unavailable' });
        }
    });

    it('keeps requester attribution distinct when owner references happen to match', () => {
        const cara = { ...attribution, accountId: 'cara' };
        expect(projectMachineWorkSummary({ target, custodianAccountId: 'alice',
            requesterIdentities: new Map([...requesterIdentities, ['cara', { accountId: 'cara', displayName: 'Cara' }]]),
            inventory: { coverage: 'complete', items: [
                { category: 'finite', state: 'active', attribution, ownerRef: 'same-reference' },
                { category: 'finite', state: 'active', attribution: cara, ownerRef: 'same-reference' },
            ] },
        })).toEqual({ kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
            { accountId: 'cara', displayName: 'Cara', sessions: 0, tasks: 1, terminals: 0 },
        ] });
    });
});
