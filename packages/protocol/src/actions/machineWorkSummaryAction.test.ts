import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { MachineAccessActionIdSchema } from './specs/machineAccess.js';

describe('safe Machine work summary Action', () => {
    it('reaches its dedicated Machine read port on eligible surfaces without joining the HTTP access family', async () => {
        const spec = getActionSpec('machines.work.summary.get');
        expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine',
            surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true } });
        expect(MachineAccessActionIdSchema.safeParse(spec.id).success).toBe(false);
        const result = { kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 2, terminals: 0 }] } as const;
        const executor = createActionExecutor({ machineWorkSummaryGet: async () => result });
        for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice'] as const) {
            expect(await executor.execute('machines.work.summary.get', { serverId: 'home', machineId: 'machine' }, { surface, serverId: 'home' }))
                .toEqual({ ok: true, result });
        }
        expect(await executor.execute('machines.work.summary.get', { serverId: 'other', machineId: 'machine' }, { surface: 'ui', serverId: 'home' }))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    });
});
