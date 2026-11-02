import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

describe('desktop.notch.set', () => {
  it('admits safe presentation once and passes state and position to the desktop owner', async () => {
    const id = ActionIdSchema.parse('desktop.notch.set');
    const spec = getActionSpec(id);
    expect(spec.executionPlacement).toBe('client');
    expect(isApprovalRequiredByActionsSettings(id, ActionsSettingsV1Schema.parse({ v: 1 }),
      { surface: 'mcp', authority: 'account_automation' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings(id, ActionsSettingsV1Schema.parse({ v: 1,
      actions: { [id]: { approvalRequiredSurfaces: ['mcp'] } },
    }), { surface: 'mcp', authority: 'account_automation' })).toBe(true);
    let admitted = 0;
    const received: unknown[] = [];
    const executor = createActionExecutor({
      isActionApprovalRequired: (actionId, context) => {
        admitted += 1;
        return isApprovalRequiredByActionsSettings(actionId, ActionsSettingsV1Schema.parse({ v: 1 }), context);
      },
      desktopNotchSet: async ({ input }) => { received.push(input); return { applied: true }; },
    } as ActionExecutorDeps);
    for (const input of [{ state: 'pinned' }, { state: 'rest' }, { position: 0.25 }, { state: 'open', position: { x: 0.2, y: 0.8 } }]) {
      expect(await executor.execute(id, input, { surface: 'mcp', authority: 'account_automation' }))
        .toEqual({ ok: true, result: { applied: true } });
    }
    expect(received).toEqual([{ state: 'pinned' }, { state: 'rest' }, { position: 0.25 }, { state: 'open', position: { x: 0.2, y: 0.8 } }]);
    expect(admitted).toBe(4);
    expect(spec.inputSchema.safeParse({ state: 'expanded' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ position: { x: 0.5 } }).success).toBe(false);
  });
});
