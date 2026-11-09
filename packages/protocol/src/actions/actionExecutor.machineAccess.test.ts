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
import { MachineAccessGrantsListResponseV1Schema } from '../machines/machineAccessV1.js';

const target = { serverId: 'home', machineId: 'machine' };
const principal = { kind: 'account', accountId: 'bob' } as const;
const saved = { kind: 'saved', grant: { machineId: 'machine', principal, level: 'view' }, readiness: 'ready', canPrepareKeys: false } as const;
const currentAccess = MachineAccessGrantsListResponseV1Schema.parse({ machineId: 'machine',
  custodian: { accountId: 'alice', displayName: 'Alice' },
  access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
  canManage: true, ownDirectGrant: false, ownAccessSources: [], grants: [],
});
const cases = [
  ['machines.access.grants.list', target, { kind: 'refused', code: 'access_denied' }],
  ['machines.access.grant.set', { ...target, principal, level: 'view' }, saved],
  ['machines.access.grant.remove', { ...target, principal }, { kind: 'removed', effectiveAccess: 'manage' }],
  ['machines.access.leave', target, { kind: 'inherited_access_remains', role: 'use' }],
  ['machines.access.prepareKeys', target, { kind: 'pending_holder' }],
] as const;

describe('Machine access Action front door', () => {
  it('uses the host-established Home identity for every qualified access operation and refuses unknown Homes', async () => {
    const resolveServerProfileScopeId = (id: string) => ['creator', 'decider', 'srv_same_home'].includes(id) ? 'srv_same_home' : null;
    for (const [id, input, output] of cases) {
      let dispatches = 0;
      const executor = createActionExecutor({
        resolveServerProfileScopeId,
        machineAccessAction: async (args: Parameters<NonNullable<ActionExecutorDeps['machineAccessAction']>>[0]) => {
          if (args.actionId === 'machines.access.grants.list' && id !== args.actionId) return currentAccess;
          dispatches++;
          return output;
        },
        isActionApprovalRequired: () => false,
      } as unknown as ActionExecutorDeps);
      const context = { surface: 'ui', authority: 'present_user', serverId: 'decider', serverIdentityId: 'srv_same_home' } as const;
      expect(await executor.execute(id, { ...input, serverId: 'creator' }, context)).toEqual({ ok: true, result: output });
      expect(await executor.execute(id, { ...input, serverId: 'unknown' }, context))
        .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
      expect(dispatches).toBe(1);
    }
  });
  it('applies the same Home admission to neighboring qualified Machine families', async () => {
    const unavailable = async () => ({ ok: false as const, errorCode: 'machine_unavailable', error: 'machine_unavailable' });
    const executor = createActionExecutor({
      machineWorkSummaryGet: unavailable, machineProcessesAction: unavailable, machineStorageAction: unavailable,
      machineGuardAction: unavailable, machineResourcesPolicyAction: unavailable, machineVitalsAction: unavailable,
      machineTerminalAction: unavailable, machinePageAction: unavailable, machinesList: unavailable,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const neighbors = [
      ['machines.work.summary.get', {}], ['machines.processes.list', {}], ['machines.storage.summary.get', {}],
      ['machines.guard.idleStop.keepRunning', { sessionId: 'session' }], ['machines.resources.policy.get', {}],
      ['machines.vitals.get', { view: 'summary' }], ['machines.terminal.list', {}],
      ['machines.metadata.update', { patch: { displayName: 'alias' } }],
    ] as const;
    for (const [id, input] of neighbors) {
      const context = { surface: 'cli', authority: 'present_user', serverId: 'local-profile', serverIdentityId: 'srv_same_home' } as const;
      const target = { ...input, serverId: 'srv_same_home', machineId: 'machine' };
      expect(await executor.execute(id, target, context)).toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
      expect(await executor.execute(id, { ...target, serverId: 'foreign' }, context))
        .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    }
    const context = { surface: 'cli', serverId: 'local-profile', serverIdentityId: 'srv_same_home' } as const;
    expect(await executor.execute('machines.list', { serverId: 'srv_same_home' }, context))
      .toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
    expect(await executor.execute('machines.list', { serverId: 'foreign' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });
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
          machineAccessAction: async (args: { actionId: string; input: unknown }) => {
            if (args.actionId === 'machines.access.grants.list' && id !== args.actionId) {
              expect(args.input).toEqual(target);
              return currentAccess;
            }
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

  it('keeps exposure confirmation while reversible UI access removals apply directly, and honors explicit waivers', () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const dangerActions = cases.filter(([id]) => id !== 'machines.access.grants.list').map(([id]) => id);
    const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: Object.fromEntries(
      dangerActions.map(id => [id, ['ui', 'cli', 'agent', 'mcp', 'voice']]),
    ) });
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice'] as const) {
      for (const id of dangerActions) {
        const direct = surface === 'ui' && (id === 'machines.access.grant.remove' || id === 'machines.access.leave');
        expect(isApprovalRequiredByActionsSettings(id, settings, { surface, authority: 'present_user' })).toBe(!direct);
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
    expect(approval?.preview).toMatchObject({ machineAccessDisclosure: { machineId: 'machine',
      ownerCanInspectDeliveredMaterial: true, sharedAgentUidExposesSelectedMaterial: true,
      isolationRequiresObservedReadiness: true, trustedAdministrationCanDefeatIsolation: true,
      dedicatedMachineRecommended: true } });
    const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['voice'] } });
    const waivedExecutor = createActionExecutor({ ...deps,
      isActionApprovalRequired: (id: ActionId, ctx: ActionExecutorContext) => isApprovalRequiredByActionsSettings(id, waived, ctx),
    } as unknown as ActionExecutorDeps);
    expect(await waivedExecutor.execute(actionId, input, context)).toEqual({ ok: true, result: saved });
    expect(savedCount).toBe(1);
  });
});
