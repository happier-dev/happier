import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from './actionSettings.js';
import { MachineAgentIsolationReadyPreviewV1Schema } from '../machines/agentIsolationV1.js';

describe('declared Machine approval scope', () => {
  it('lets a per-Machine preference decide confirmation only for the admitted target Machine', async () => {
    const actionId = 'machines.agentIsolation.set';
    const calls: string[] = [];
    // The target-daemon transport is the boundary; admission, scope resolution and policy stay real.
    const executor = createActionExecutor({ machineAgentIsolationAction: async ({ actionId, input }: { actionId: string; input: { machineId: string } }) => {
      if (actionId === 'machines.agentIsolation.preview') return MachineAgentIsolationReadyPreviewV1Schema.parse({
        kind: 'ready', policy: { enabled: false }, metadataVersion: 1, status: { kind: 'disabled' },
        plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: true, planDigest: 'digest' },
      });
      calls.push(input.machineId);
      return { kind: 'unchanged', metadataVersion: 1, status: { kind: 'disabled' } };
    } } as never);
    const input = (machineId: string) => ({ serverId: 'home', machineId, enabled: true, expectedMetadataVersion: 1,
      expectedPolicy: { enabled: false }, expectedPlanDigest: 'digest' });
    const actionsSettings = setScopedActionApprovalPreference({ actionId, scope: { kind: 'machine', machineId: 'vps-1' },
      surface: 'cli', mode: 'waived', settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
    const context = { surface: 'cli' as const, serverId: 'home', actionsSettings };
    const waived = await executor.prepare(actionId, input('vps-1'), context);
    const other = await executor.prepare(actionId, input('shop-prod'), context);
    expect(waived.kind).toBe('ready');
    if (waived.kind === 'ready') await waived.invocation.run();
    expect(calls).toEqual(['vps-1']);
    expect(other).toMatchObject({ kind: 'settled', result: { ok: false } });
    expect(calls).toEqual(['vps-1']);
    expect(getActionSpec(actionId).approvalScope).toBe('machine');
  });
});
