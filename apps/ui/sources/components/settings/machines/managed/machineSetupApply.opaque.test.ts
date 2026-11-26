import { expect, it } from 'vitest';
import {
    MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { TEAM_SETUP_RUN_ACTION_ID_V1, TeamSetupBatchInputV1Schema } from '@happier-dev/protocol/teams';

import { prepareTeamSetupPlan, runTeamSetupPlan } from '@/components/teams/setup/teamSetupPlan';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { prepareMachineSetupPresetApplyInput } from './machineSetupApply';
import { prepareMachineSetupSourcesApplyInput } from './machineSetupReview';
import { countMachineSetupTargetChanges, groupMachineSetupChanges } from './machineSetupReviewChanges';

// The receiving daemon addresses every script its effects Plan runs; these Plans run the preset's one script.
const reviewOneScript = (machineId: string) => ({ target: { homeId: 'home', machineId }, administratorRequired: null,
    downtime: 'unknown' as const, steps: [{ planIndex: 0, stepId: 'script:0', label: 'Script 1' }],
    presetUpdateEffects: { toolchain: false, scripts: [{ sourceIndex: 0, scriptIndex: 0 }] } });
const scriptLabel = (index: number) => ({ key: 'machinePresets.setup.scriptNumbered', fallback: 'Script {index}', params: { index } });

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
            ? { ...current, sources: request.sources, recipePlans: [], review: reviewOneScript('machine') }
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

it('runs the reviewed Team tools batch with its declared-Agent child and every executing script listed', async () => {
    const target = { serverId: 'home', homeId: 'home', machineId: 'member-machine' };
    const context = { surface: 'ui' as const, serverId: target.serverId, expectedAccountId: 'member' };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 11,
        sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo already-done' }, { body: 'printf pending' }] } }],
        exclusions: [], support: [] });
    const appChildren = [{ actionId: 'machines.agents.install', sourceIndex: 0, itemIndex: 0,
        input: { machineId: target.machineId, agentId: 'pi', intent: 'install', waitForTerminal: true,
            consent: { vendorRecipe: true } } }];
    const executeAction = createFrontDoorActionExecute({
        execute: async (actionId, input) => {
            expect(actionId).toBe('machines.setup.plan');
            const request = MachineSetupPlanInputV1Schema.parse(input);
            return { ok: true, result: request.mode === 'effects' ? MachineSetupPlanResultV1Schema.parse({
                ...current, sources: request.sources, recipePlans: [], appChildren, review: {
                    target: { homeId: target.homeId, machineId: target.machineId }, administratorRequired: null, downtime: 'unknown',
                    steps: [{ planIndex: 0, stepId: 'script:0', label: scriptLabel(1) },
                        { planIndex: 0, stepId: 'script:2', label: scriptLabel(3) }],
                    presetUpdateEffects: { toolchain: false, scripts: [{ sourceIndex: 0, scriptIndex: 0 }, { sourceIndex: 1, scriptIndex: 1 }] },
                },
            }) : current };
        },
        executeConfirmed: async (actionId, input) => {
            expect(actionId).toBe(TEAM_SETUP_RUN_ACTION_ID_V1);
            const batch = TeamSetupBatchInputV1Schema.parse(input);
            expect(batch).toMatchObject({ ...target, repositories: [], machine: { targets: [{ appChildren }] } });
            return { ok: true, result: { completed: true, machine: { ok: true, result: { operationId: 'accepted-operation' } },
                machineSettlement: null, repositories: [] } };
        },
    });
    const prepared = await prepareTeamSetupPlan({ executeAction, context, target, repositories: [],
        isCurrent: () => true, preset: { id: 'team-tools', revision: 0, setupRevision: 0, contentEncryptionMode: 'e2ee',
            setup: { items: [{ kind: 'agent', agentId: 'pi' }], scripts: [{ body: 'printf team-tools' }] } } });
    if (!prepared?.ok || !prepared.plan.machine) throw new Error('Expected a successful Team machine review');

    const { input, sourcePresentations } = prepared.plan.machine;
    const commands = groupMachineSetupChanges(input.targets, sourcePresentations).find(group => group.kind === 'commands');
    expect(commands?.lines.map(line => line.operand)).toEqual(['Script 1', '$ printf pending']);
    const result = await runTeamSetupPlan({ executeAction, context, plan: prepared.plan });

    expect(result.completed).toBe(true);
    expect(result.machine).toEqual({ ok: true, result: { operationId: 'accepted-operation' } });
});

it('reviews exactly the scripts the Plan will run, including a retained copy this viewer cannot open', async () => {
    const homeId = 'home';
    const machineId = 'machine';
    const sources = [
        { kind: 'accountPresetOpaque' as const, presetId: 'retained', presetRevision: 1, contentEncryptionMode: 'e2ee' as const },
        { kind: 'direct' as const, setup: { scripts: [{ body: 'echo already-done' }, { body: 'printf TEAM' }] } },
    ];
    // Home Action execution is the transport boundary; the receiving daemon's Plan shape is mirrored exactly.
    const executeAction = async (_actionId: unknown, input: unknown) => {
        const request = MachineSetupPlanInputV1Schema.parse(input);
        return { ok: true as const, result: MachineSetupPlanResultV1Schema.parse({ desiredRevision: 4, sources: request.sources,
            exclusions: [], support: [], recipePlans: [], resolvedSources: [null, request.sources?.[1]],
            review: { target: { homeId, machineId }, administratorRequired: null, downtime: 'unknown',
                steps: [{ planIndex: 0, stepId: 'script:1', label: scriptLabel(2) }, { planIndex: 0, stepId: 'script:3', label: scriptLabel(4) }],
                presetUpdateEffects: { toolchain: false, scripts: [{ sourceIndex: 0, scriptIndex: 1 }, { sourceIndex: 1, scriptIndex: 1 }] } } }) };
    };

    const prepared = await prepareMachineSetupSourcesApplyInput({ executeAction: executeAction as never, context: { surface: 'ui' },
        homeId, machineId, combined: false, isCurrent: () => true, targets: [{ homeId, machineId, desiredRevision: 4, sources }] });
    if (!prepared.ok) throw new Error(`Expected a prepared review: ${prepared.errorCode}`);

    const commands = groupMachineSetupChanges(prepared.input.targets, prepared.sourcePresentations)
        .find(group => group.kind === 'commands');
    expect(commands?.lines.map(line => line.operand)).toEqual(['Script 2', '$ printf TEAM']);
    expect(countMachineSetupTargetChanges(prepared.input.targets[0]!, prepared.sourcePresentations?.[0])).toBe(2);
});
