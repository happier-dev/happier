import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionIdSchema } from './actionIds.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from './actionSettings.js';
import { executeActionOperationActionV1 } from './executor/actionOperationActions.js';

describe('operation and retained output Actions', () => {
  it('refuses a conflicting observation Home before dispatch or approval', async () => {
    const transport = vi.fn();
    const executor = createActionExecutor({
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport }),
    } as ActionExecutorDeps);
    expect(await executor.execute('action.operations.get', {
      serverId: 'other-home', machineId: 'machine', operationId: 'operation',
    }, { surface: 'cli', serverId: 'bound-home' }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValue({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
    expect(await executor.execute('action.operations.get', {
      serverId: 'bound-home', machineId: 'machine', operationId: 'operation',
    }, { surface: 'cli', serverId: 'bound-home' }))
      .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
  });
  it('requires default present-user Stop confirmation but respects the canonical waiver', () => {
    const actionId = 'action.operations.cancel' as const;
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, context }).required).toBe(true);
    const settings = setActionApprovalOverride({
      settings: normalizeActionsSettingsV1(null), actionId, surface: 'ui', approvalRequired: false,
    });
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required).toBe(false);
  });
  it('declares exact-Home safe observation and configurable consequential cancellation', () => {
    const read = getActionSpec(ActionIdSchema.parse('projects.execution.output.read'));
    expect(read.safety).toBe('safe');
    expect(read.inputSchema.safeParse({ serverId: 'home', machineId: 'machine', operationId: 'operation', byteOffset: 0 }).success).toBe(true);
    expect(read.inputSchema.safeParse({ serverId: 'home', machineId: 'machine', operationId: 'operation', terminalId: 'forged', byteOffset: 0 }).success).toBe(false);
    expect(read.inputSchema.safeParse({ serverId: 'home', machineId: 'machine', operationId: 'operation', byteOffset: 4, ackedByteOffset: 4 }).success).toBe(true);
    const invalidCursor = read.inputSchema.safeParse({ serverId: 'home', machineId: 'machine', operationId: 'operation', byteOffset: 4, ackedByteOffset: 5 });
    expect(invalidCursor.success).toBe(false);
    if (!invalidCursor.success) expect(invalidCursor.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['ackedByteOffset'] }),
    ]));
    expect(getActionSpec(ActionIdSchema.parse('action.operations.cancel')).safety).toBe('danger');
  });

  it('refuses unsupported headless presentation and does not dispatch across an admitted Home', async () => {
    const executor = createActionExecutor({} as ActionExecutorDeps);
    expect(await executor.execute(ActionIdSchema.parse('projects.execution.output.open'), {
      serverId: 'home', machineId: 'machine', operationId: 'operation',
    }, { surface: 'agent', serverId: 'home' })).toMatchObject({ ok: false });
  });
});
