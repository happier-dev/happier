import { expect, it } from 'vitest';
import { MachineUpdateStateRequestSchema, type MachineUpdateStateRequest } from '@happier-dev/protocol/machines/metadataUpdate';
import type { Machine } from './types';
import { ApiMachineClient } from './apiMachine';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

function createPublicationBoundary(answer: (write: MachineUpdateStateRequest) => unknown | Promise<unknown>) {
  const machine: Machine = { id: 'daemon-publication', encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: { status: 'running' }, daemonStateVersion: 0 };
  const attempts: MachineUpdateStateRequest[] = [];
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event !== 'machine-update-state') throw new Error(`Unexpected publication: ${event}`);
    const write = MachineUpdateStateRequestSchema.parse(payload);
    attempts.push(write);
    return answer(write);
  } });
  const client = new ApiMachineClient(String(1), machine);
  Reflect.set(client, 'socket', socket);
  return { client, machine, attempts };
}

it('publishes setup updates only on real fact changes and preserves sibling observations', async () => {
    const f = createPublicationBoundary(write => ({ result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState }));
    const recipes = [{ ref: { pluginId: 'happier.machine.test', recipeId: 'fixture', revision: '1' }, status: 'satisfied' as const, steps: [] }];
    f.machine.metadata = { host: 'guest', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier',
      setup: { version: 1, revision: 3, sources: [{ kind: 'direct', setup: {} }], exclusions: [] } };
    f.machine.daemonState = { status: 'running', setup: { version: 1, desiredRevision: 3, status: 'satisfied', recipes } };
    try {
        const updates = { status: 'satisfied' as const, backend: 'apt', pendingSecurity: 2, pendingAll: 4, rebootNeeded: true };
        expect(await f.client.publishMachineSetupUpdates(updates)).toBe('published');
        for (let index = 0; index < 32; index++) {
            expect(await f.client.publishMachineSetupUpdates({ ...updates })).toBe('unchanged');
        }
        expect(f.attempts).toHaveLength(1);
        expect(f.machine.daemonState?.setup).toEqual({ version: 1, desiredRevision: 3, status: 'satisfied', recipes, updates });
        expect(await f.client.publishMachineSetupUpdates({ ...updates, pendingSecurity: 0, pendingAll: 0 })).toBe('published');
        expect(f.attempts).toHaveLength(2);
        expect(f.machine.daemonState?.setup?.updates).toMatchObject({ pendingSecurity: 0, pendingAll: 0, rebootNeeded: true });
    } finally { await f.client.shutdown(); }
});

it('retains last-known update facts when a native check becomes unavailable without republishing equal failures', async () => {
    const f = createPublicationBoundary(write => ({ result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState }));
    const unavailable = { status: 'unavailable' as const, reason: 'required_fact_unavailable' as const };
    try {
        await f.client.publishMachineSetupUpdates(unavailable);
        for (let index = 0; index < 16; index++) await f.client.publishMachineSetupUpdates({ ...unavailable });
        expect(f.attempts).toHaveLength(1);
        expect(f.machine.daemonState?.setup?.updates).toEqual(unavailable);
        const known = { status: 'drifted' as const, backend: 'apt', pendingAll: 4, pendingSecurity: 0, rebootNeeded: false };
        await f.client.publishMachineSetupUpdates(known);
        await f.client.publishMachineSetupUpdates(unavailable);
        expect(f.machine.daemonState?.setup?.updates).toEqual({ ...unavailable,
            pendingAll: 4, pendingSecurity: 0, rebootNeeded: false });
        for (let index = 0; index < 16; index++) await f.client.publishMachineSetupUpdates({ ...unavailable });
        expect(f.attempts).toHaveLength(3);
        await f.client.publishMachineSetupUpdates(known);
        expect(f.machine.daemonState?.setup?.updates).toEqual(known);
        expect(f.attempts).toHaveLength(4);
    } finally { await f.client.shutdown(); }
});
