import { expect, it } from 'vitest';
import {
    MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema,
} from '@happier-dev/protocol/machines/managed/actionsV1';

import { prepareTeamSetupPlan, runTeamSetupPlan } from '@/components/teams/setup/teamSetupPlan';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { prepareMachineSetupPresetApplyInput } from './machineSetupApply';

it('projects a saved preset to the opaque Plan source without sending its opened setup', async () => {
    const setup = { scripts: [{ body: 'private setup body' }] };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0,
        sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [] });
    const requests: unknown[] = [];
    // Home Action execution is the transport boundary; the Plan/input schemas and preparation path stay real.
    const executeAction = async (_actionId: unknown, input: unknown) => {
        const request = MachineSetupPlanInputV1Schema.parse(input);
        requests.push(request);
        return { ok: true as const, result: request.mode
            ? { ...current, sources: request.sources, recipePlans: [] }
            : current };
    };

    const prepared = await prepareMachineSetupPresetApplyInput({ executeAction: executeAction as never,
        context: { surface: 'ui' }, homeId: 'home', machineId: 'machine', isCurrent: () => true,
        preset: { id: 'saved', revision: 3, contentEncryptionMode: 'plain', setup } });

    expect(prepared).toMatchObject({ ok: true, input: { targets: [{ sources: [
        { kind: 'accountPresetOpaque', presetId: 'saved', presetRevision: 3, contentEncryptionMode: 'plain' },
        { kind: 'direct', setup: {} },
    ] }] } });
    expect(requests[1]).not.toMatchObject({ sources: [expect.objectContaining({ setup })] });
});

it('applies an unchanged Tools-only Team review with its declared-Agent child', async () => {
    const target = { serverId: 'home', homeId: 'home', machineId: 'member-machine' };
    const context = { surface: 'ui' as const, serverId: target.serverId, expectedAccountId: 'member' };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 11,
        sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [] });
    const appChildren = [{ actionId: 'machines.agents.install', sourceIndex: 0, itemIndex: 0,
        input: { machineId: target.machineId, agentId: 'pi', intent: 'install', waitForTerminal: true,
            consent: { vendorRecipe: true } } }];
    const executeAction = createFrontDoorActionExecute({
        execute: async (actionId, input) => {
            if (actionId === 'action.operations.get') return { ok: true, result: { kind: 'not_found' } };
            expect(actionId).toBe('machines.setup.plan');
            const request = MachineSetupPlanInputV1Schema.parse(input);
            return { ok: true, result: request.mode === 'effects' ? MachineSetupPlanResultV1Schema.parse({
                ...current, sources: request.sources, recipePlans: [], appChildren,
            }) : current };
        },
        executeConfirmed: async (actionId, input) => {
            expect(actionId).toBe('machines.setup.apply');
            const apply = MachineSetupApplyInputV1Schema.parse(input);
            expect(apply.targets[0]?.appChildren).toEqual(appChildren);
            return { ok: true, result: { operationId: 'accepted-operation' } };
        },
    });
    const prepared = await prepareTeamSetupPlan({ executeAction, context, target, repositories: [],
        isCurrent: () => true, preset: { id: 'team-tools', revision: 0, setupRevision: 0, contentEncryptionMode: 'e2ee',
            setup: { items: [{ kind: 'agent', agentId: 'pi' }], scripts: [{ body: 'printf team-tools' }] } } });
    if (!prepared?.ok) throw new Error('Expected a successful Team review');

    const result = await runTeamSetupPlan({ executeAction, context, plan: prepared.plan });

    expect(result.machine).toEqual({ ok: true, result: { operationId: 'accepted-operation' } });
});
