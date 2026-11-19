import { expect, it } from 'vitest';
import { isStrictPluginJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { projectMachineServiceObservation } from './machineOutcomeEvents.js';

it('projects native optional worktree facts to strict JSON at Event publication', () => {
    const observation = projectMachineServiceObservation({
        kind: 'worktreeCreated', serverId: 'home', occurredAt: 100,
        creation: { workspace: null, project: null, machineId: 'machine', operationId: 'create',
            originRunId: undefined, worktreePath: '/worktree', outcome: 'created' },
    }, 200);
    expect(observation).toMatchObject({ eventRef: { localId: 'worktree-created' },
        payload: { machineId: 'machine', operationId: 'create', outcome: 'created' } });
    expect(isStrictPluginJsonValue(observation?.payload)).toBe(true);
    expect(Object.hasOwn(observation!.payload as object, 'originRunId')).toBe(false);
});
