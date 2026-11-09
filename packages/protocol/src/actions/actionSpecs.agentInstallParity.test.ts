import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { actionSpecToActionDefinitionV1 } from './actionCatalog.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

describe('machine agent install Action parity', () => {
  it('admits definition-qualified removal and enforces one confirmation for machine mutations', async () => {
    expect(ActionIdSchema.safeParse('machines.agents.uninstall').success).toBe(true);
    const uninstallId = ActionIdSchema.parse('machines.agents.uninstall');
    for (const id of ['machines.agents.install', uninstallId, 'agents.acp.backends.delete'] as const) {
      const spec = getActionSpec(id);
      expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface: 'ui', authority: 'present_user' } }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
    }
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
      machineAgentInstallStart: async (args: Parameters<NonNullable<ActionExecutorDeps['machineAgentInstallStart']>>[0]) => {
        requests.push(args); return { ok: true, jobId: 'definition-job' };
      },
    } as unknown as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    const target = { machineId: 'machine', agentId: 'custom-acp', definitionId: 'registry-agent' };
    expect(await executor.execute('machines.agents.install', { ...target, intent: 'install' }, context)).toMatchObject({ ok: true });
    expect(await executor.execute(uninstallId, target, context)).toMatchObject({ ok: true });
    expect(requests).toMatchObject([
      { ...target, intent: 'install', consent: { vendorRecipe: false }, context, effectActionId: 'machines.agents.install' },
      { ...target, intent: 'uninstall', consent: { vendorRecipe: false }, context, effectActionId: 'machines.agents.uninstall' },
    ]);
    expect(getActionSpec('machines.agents.install').inputSchema.safeParse({ ...target, intent: 'uninstall' }).success).toBe(false);
  });

  it('exposes install jobs across caller surfaces with machine mutation approval', () => {
    for (const id of ['machines.agents.install', 'machines.agents.install.status', 'machines.agents.install.cancel'] as const) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      const spec = getActionSpec(ActionIdSchema.parse(id));
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
      expect(actionSpecToActionDefinitionV1(spec).inputSchema).toBeDefined();
      expect(spec.outputSchema).toBeDefined();
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface, authority: 'account_automation' } }).required)
          .toBe(id !== 'machines.agents.install.status');
      }
    }
  });

  it('defaults omitted vendor consent to false and returns current status independently of the event cursor', async () => {
    const requests: unknown[] = [];
    const snapshot = {
      steps: [{ stepId: 'cli', label: 'Install CLI', state: 'running' as const }],
      progress: [{ stepId: 'cli', bytesDone: 32, bytesTotal: null }],
    };
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
      machineAgentInstallStart: async (args: Parameters<NonNullable<ActionExecutorDeps['machineAgentInstallStart']>>[0]) => {
        requests.push(args);
        return { ok: true, jobId: 'job-1' };
      },
      machineAgentInstallRead: async (args: Parameters<NonNullable<ActionExecutorDeps['machineAgentInstallRead']>>[0]) => args.cursor <= 1
        ? { ok: true, ...snapshot, events: args.cursor === 0 ? [{ t: 'progress', stepId: 'cli', bytesDone: 32, bytesTotal: null }] : [], nextCursor: 1, done: false, outcome: null }
        : { ok: false, errorCode: 'invalid_request', error: 'Unexpected cursor' },
      machineAgentInstallCancel: async () => ({ ok: false, errorCode: 'job_not_found', error: 'No job' }),
    } as unknown as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    expect(await executor.execute('machines.agents.install', { machineId: 'machine', agentId: 'acme/agent', intent: 'install' }, context)).toEqual({ ok: true, result: { ok: true, jobId: 'job-1' } });
    expect(requests[0]).toMatchObject({ machineId: 'machine', agentId: 'acme/agent', consent: { vendorRecipe: false } });
    expect(await executor.execute('machines.agents.install.status', { machineId: 'machine', jobId: 'job-1' }, context)).toMatchObject({ ok: true, result: { nextCursor: 1, events: [{ t: 'progress', bytesDone: 32 }] } });
    const status = await executor.execute('machines.agents.install.status', { machineId: 'machine', jobId: 'job-1', cursor: 1 }, context);
    expect(status).toMatchObject({ ok: true, result: { ...snapshot, nextCursor: 1, events: [] } });
    if (status.ok) expect(getActionSpec('machines.agents.install.status').outputSchema?.safeParse(status.result).success).toBe(true);
    expect(await executor.execute('machines.agents.install.cancel', { machineId: 'machine', jobId: 'job-1' }, context)).toMatchObject({ ok: false, errorCode: 'job_not_found' });
  });
});
