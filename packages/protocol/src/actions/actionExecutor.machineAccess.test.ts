import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import type { ActionExecutorContext } from './executor/types.js';
import type { ActionId } from './actionIds.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

const target = { serverId: 'home', machineId: 'machine' };
const principal = { kind: 'account', accountId: 'bob' } as const;
const saved = { kind: 'saved', grant: { machineId: 'machine', principal, level: 'view' }, readiness: 'ready' } as const;
const cases = [
  ['machines.access.grants.list', target, { kind: 'refused', code: 'access_denied' }],
  ['machines.access.grant.set', { ...target, principal, level: 'view' }, saved],
  ['machines.access.grant.remove', { ...target, principal }, { kind: 'removed', effectiveAccess: 'manage' }],
  ['machines.access.leave', target, { kind: 'inherited_access_remains', role: 'use' }],
  ['machines.access.prepareKeys', target, { kind: 'pending_holder' }],
] as const;

describe('Machine access Action front door', () => {
  it('refuses a qualified inventory target different from its captured Home', async () => {
    let reachedInventory = false;
    const executor = createActionExecutor({ machinesList: async () => { reachedInventory = true; return { items: [] }; },
      isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    expect(await executor.execute('machines.list', { serverId: 'foreign' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(reachedInventory).toBe(false);
  });
  it('advertises and executes the actual access operations on every answering surface', async () => {
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice'] as const) {
      for (const [rawId, input, output] of cases) {
        const id = ActionIdSchema.parse(rawId);
        expect(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === id)).toBe(true);
        // The family port is the authenticated server/crypto transport boundary.
        const executor = createActionExecutor({
          machineAccessAction: async (args: { input: unknown }) => {
            expect(args.input).toEqual(input);
            return output;
          },
          isActionApprovalRequired: () => false,
        } as unknown as ActionExecutorDeps);
        expect(await executor.execute(id, input, { surface, authority: 'present_user', serverId: 'home' }))
          .toEqual({ ok: true, result: output });
      }
    }
  });

  it('refuses raw proof/envelope authority and unknown machine roles at the public boundary', () => {
    const spec = getActionSpec(ActionIdSchema.parse('machines.access.grant.set'));
    const input = { ...target, principal, level: 'view' };
    for (const patch of [
      { level: 'edit' }, { requesterAccountId: 'alice' }, { admission: { role: 'manage' } },
      { encryptedDataKey: 'key' }, { recipientKeyEnvelopes: [] }, { expectedCallerDataEncryptionKey: 'proof' },
    ]) expect(spec.inputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ machineId: 'machine', principal, level: 'view' }).success).toBe(false);
    expect(getActionSpec(ActionIdSchema.parse('machines.access.leave')).inputSchema.safeParse({ ...target, principal }).success).toBe(false);
  });

  it('requires the configured danger approval and honors the same explicit waiver', () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const dangerActions = cases.filter(([id]) => id !== 'machines.access.grants.list').map(([id]) => id);
    const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: Object.fromEntries(
      dangerActions.map(id => [id, ['ui', 'cli', 'agent', 'mcp', 'voice']]),
    ) });
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice'] as const) {
      for (const id of dangerActions) {
        expect(isApprovalRequiredByActionsSettings(id, settings, { surface, authority: 'present_user' })).toBe(true);
        expect(isApprovalRequiredByActionsSettings(id, waived, { surface, authority: 'present_user' })).toBe(false);
      }
    }
  });

  it('presents host-owned exposure disclosure when asking, and executes a waived grant without acknowledgement state', async () => {
    const actionId = ActionIdSchema.parse('machines.access.grant.set');
    const input = { ...target, principal, level: 'view' };
    let approval: ApprovalRequest | undefined;
    let savedCount = 0;
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const deps = {
      machineAccessAction: async () => { savedCount++; return saved; },
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { approval = request; return { artifactId: 'approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }: { request: ApprovalRequest }) => ({
        decision: 'reject', request: { ...request, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } },
      }),
      isActionApprovalRequired: (id: ActionId, ctx: ActionExecutorContext) => isApprovalRequiredByActionsSettings(id, settings, ctx),
    };
    const context = { surface: 'voice', authority: 'present_user', serverId: 'home', runtimeAccountId: 'alice',
      actionRequestId: 'share-request', actionCaller: { kind: 'host' } } as const;
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(savedCount).toBe(0);
    expect(approval?.preview).toMatchObject({ machineAccessDisclosure: { machineId: 'machine', sameOsUser: true,
      localCredentialsExposed: true, accountEncryptionKeyExposedIfPresent: true, dedicatedMachineRecommended: true } });
    const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['voice'] } });
    const waivedExecutor = createActionExecutor({ ...deps,
      isActionApprovalRequired: (id: ActionId, ctx: ActionExecutorContext) => isApprovalRequiredByActionsSettings(id, waived, ctx),
    } as unknown as ActionExecutorDeps);
    expect(await waivedExecutor.execute(actionId, input, context)).toEqual({ ok: true, result: saved });
    expect(savedCount).toBe(1);
  });
});
