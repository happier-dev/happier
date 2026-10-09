import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { SessionTerminalTargetV1Schema } from '../terminal/workspace.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import type { ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './executor/types.js';

const routing = { serverId: 'home', machineId: 'machine' };
const workspace = { ...routing, workspaceId: 'checkout', rootPath: '/repo' };
const cases = [
  ['machines.terminal.open', { ...routing, terminalKey: 'owned', workspace }, { ok: true, terminalId: 'pty', reused: false }],
  ['machines.terminal.list', routing, { ok: true, terminals: [] }],
  ['machines.terminal.read', { ...routing, terminalId: 'pty', byteOffset: 0 }, { ok: true, terminalId: 'pty', frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: false }],
  ['machines.terminal.write', { ...routing, terminalId: 'pty', event: { t: 'text', text: 'pwd\r' } }, { ok: true }],
  ['machines.terminal.close', { ...routing, terminalId: 'pty' }, { ok: true }],
  ['machines.terminal.restart', { ...routing, terminalKey: 'owned', workspace }, { ok: true, terminalId: 'restarted-pty', reused: false }],
] as const;

describe('Machine terminal canonical Action family', () => {
  it('keeps the original Agent authority at the mounted intent port instead of borrowing a UI waiver', async () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
      'machines.terminal.restart': ['ui'],
      // The mounted intent has no process permission of its own. This also
      // discriminates the current context-loss bug before metadata is corrected.
      'session.terminals.restart': ['agent'],
    } });
    let spawned = false;
    let approvalRequest: ApprovalRequest | undefined;
    let waitedForHuman = false;
    const executor = createActionExecutor({
      sessionTerminalAction: async ({ context }: { context?: ActionExecutorContext }) => {
        if (!context) return { ok: false, errorCode: 'missing_original_context', error: 'missing_original_context' };
        const result = await executor.execute('machines.terminal.restart', cases[5][1], { ...context, bypassApprovals: false });
        return result.ok ? result.result : result;
      },
      machineTerminalAction: async () => { spawned = true; return cases[5][2]; },
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { approvalRequest = request; return { artifactId: 'agent-approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }: { request: ApprovalRequest }) => {
        waitedForHuman = true;
        return { decision: 'reject', request: { ...request, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } } };
      },
      isActionApprovalRequired: (actionId: ActionId, context: ActionExecutorContext) => isApprovalRequiredByActionsSettings(actionId, settings, context, getActionSpec(actionId).safety),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.terminals.restart', { scopeId: 'qualified-project', terminalId: 'member' }, {
      surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'bob',
      actionRequestId: 'agent-restart', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'agent-approval', actionId: 'machines.terminal.restart' } });
    expect(approvalRequest).toMatchObject({ createdBy: { surface: 'agent' }, approval: { flow: 'deferred', result: 'required' } });
    expect(waitedForHuman).toBe(false);
    expect(spawned).toBe(false);
    // This lifecycle choice belongs only to open/restart. Other Agent Actions
    // retain their incumbent blocking decision/result contract.
    expect(await executor.execute('machines.terminal.write', cases[3][1], {
      surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'bob',
      actionRequestId: 'agent-write', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(waitedForHuman).toBe(true);
  });
  it('keeps pane creation an intent while actual shell creation requires default approval before any PTY effect', async () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    for (const actionId of ['session.terminals.open', 'session.terminals.split', 'session.terminals.run_script', 'session.terminals.restart'] as const) {
      expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'ui', authority: 'present_user' }, getActionSpec(actionId).safety)).toBe(false);
      expect(getActionSpec(actionId).sideEffectClass).toBe('external');
    }
    let spawned = false;
    const executor = createActionExecutor({
      machineTerminalAction: async () => { spawned = true; return { ok: true, terminalId: 'pty', reused: false }; },
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async () => ({ artifactId: 'approval' }), approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }: { request: ApprovalRequest }) => ({ decision: 'reject',
        request: { ...request, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } } }),
      isActionApprovalRequired: (actionId: ActionId, context: ActionExecutorContext) => isApprovalRequiredByActionsSettings(actionId, settings, context, getActionSpec(actionId).safety),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('machines.terminal.open', cases[0][1], { surface: 'ui', authority: 'present_user',
      serverId: 'home', runtimeAccountId: 'bob', actionRequestId: 'open-shell', actionCaller: { kind: 'host' } }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval' } });
    expect(spawned).toBe(false);
  });
  it('advertises and executes every operation through its real terminal transport port', async () => {
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice'] as const) {
      for (const [rawId, input, output] of cases) {
        const id = ActionIdSchema.parse(rawId);
        expect(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === id)).toBe(true);
        const executor = createActionExecutor({
          // PTY transport is outside deterministic Action ownership.
          machineTerminalAction: async (request: { actionId: string; input: unknown }) => {
            expect(request).toMatchObject({ actionId: id, input });
            return output;
          }, isActionApprovalRequired: () => false,
        } as unknown as ActionExecutorDeps);
        expect(await executor.execute(id, input, { surface, serverId: 'home', authority: 'present_user' }))
          .toEqual({ ok: true, result: output });
      }
    }
  });

  it('refuses foreign Homes and caller-authored requester authority before reaching a PTY', async () => {
    let reached = false;
    const executor = createActionExecutor({ machineTerminalAction: async () => { reached = true; return { ok: true }; },
      isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    for (const [rawId, input] of cases) {
      const id = ActionIdSchema.parse(rawId);
      expect(getActionSpec(id).inputSchema.safeParse({ ...input, requesterAccountId: 'forged' }).success).toBe(false);
      expect(await executor.execute(id, { ...input, serverId: 'foreign' }, { surface: 'cli', serverId: 'home' }))
        .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    }
    expect(reached).toBe(false);
  });

  it('retains the accepted Project checkout in each terminal member instead of following pane selection', () => {
    expect(SessionTerminalTargetV1Schema.parse({ kind: 'workspace_shell', workspace }))
      .toEqual({ kind: 'workspace_shell', workspace });
    expect(SessionTerminalTargetV1Schema.safeParse({ kind: 'workspace_shell', workspace: { ...workspace, requesterAccountId: 'forged' } }).success).toBe(false);
  });
});
