import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import type { ActionExecutorDeps } from './executor/types.js';

describe('plugin lifecycle administration admission', () => {
  it('admits creation through the existing scaffold Action for the exact UI Machine', async () => {
    let subject: unknown;
    const executor = createActionExecutor({
      pluginsDevLoopAction: async args => { subject = args.input; return { ok: true, kind: 'plugins_scaffold',
        plugin: { pluginId: 'acme.plugin' }, createdPaths: { targetDir: '/plugins/acme' } }; },
    } as ActionExecutorDeps);
    const result = await executor.execute('plugins.scaffold', { machineId: 'machine-1', targetDir: '/plugins/acme',
      id: 'acme.plugin', name: 'Acme', ui: 'declarative' }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(result).toMatchObject({ ok: true, result: { plugin: { pluginId: 'acme.plugin' }, createdPaths: { targetDir: '/plugins/acme' } } });
    expect(subject).toMatchObject({ machineId: 'machine-1', targetDir: '/plugins/acme', ui: 'declarative' });
  });
  it('admits the same installed-plugin controls on UI, agent, CLI and MCP', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      pluginsDevLoopAction: async (request) => { requests.push(request.input); return {
        ok: true, kind: request.actionId.replaceAll('.', '_'), pluginId: 'acme.plugin', change: { kind: 'committed' },
      }; },
    } as ActionExecutorDeps);
    for (const actionId of ['plugins.enable', 'plugins.disable', 'plugins.rollback', 'plugins.trust.forget',
      'plugins.update_policy.set', 'plugins.uninstall'] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true, mcp: true });
      const input = { machineId: 'machine-1', pluginId: 'acme.plugin',
        ...(actionId === 'plugins.update_policy.set' ? { policy: 'pinned' } : {}) };
      const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, presentUserConfirmation: { actionId },
      });
      expect(result).toMatchObject({ ok: true, result: { pluginId: 'acme.plugin', change: { kind: 'committed' } } });
      expect(spec.outputSchema.safeParse(result.ok ? result.result : undefined).success).toBe(true);
    }
    expect(requests).toHaveLength(6);
  });

  it('withholds effects for Off and native Ask-first without losing the exact machine', async () => {
    const effects: unknown[] = [];
    const port: NonNullable<ActionExecutorDeps['pluginsDevLoopAction']> = async (args) => {
      effects.push(args);
      return { ok: true, kind: 'plugins_disable', pluginId: 'acme.plugin', change: { kind: 'committed' } };
    };
    const off = createActionExecutor({ isActionEnabled: () => false, pluginsDevLoopAction: port } as ActionExecutorDeps);
    expect(await off.execute('plugins.disable', { machineId: 'machine-1', pluginId: 'acme.plugin' }, { surface: 'ui' }))
      .toMatchObject({ ok: false });
    let stored: unknown;
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'plugins.disable': { approvalRequiredSurfaces: ['ui'] } },
    });
    const ask = createActionExecutor({ pluginsDevLoopAction: port,
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'plugin-approval' }; },
    } as ActionExecutorDeps);
    expect(await ask.execute('plugins.disable', { machineId: 'machine-1', pluginId: 'acme.plugin' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, actionsSettings,
      serverId: 'home', actionRequestId: 'disable-1',
    })).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(stored).toBeUndefined();
    expect(effects).toEqual([]);
    let confirmations = 0;
    const reviewed = createActionExecutor({ pluginsDevLoopAction: port,
      presentUserActionConfirmation: async () => { confirmations += 1; return true; },
    } as ActionExecutorDeps);
    await expect(reviewed.execute('plugins.disable', { machineId: 'machine-1', pluginId: 'acme.plugin' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      actionsSettings,
    })).resolves.toMatchObject({ ok: true });
    expect(effects).toEqual([expect.objectContaining({
      input: { machineId: 'machine-1', pluginId: 'acme.plugin' },
    })]);
    expect(confirmations).toBe(1);
    expect(stored).toBeUndefined();
  });
});
