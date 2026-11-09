import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonApprovalExecutionOriginCurrentness } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createGuardLeftBehindActionExecutor } from './actions';

function fixture() {
  let current = true;
  let verifications = 0;
  let onEffect: (() => void) | undefined;
  const requests: unknown[] = [];
  const effects: unknown[] = [];
  const settings = ActionsSettingsV1Schema.parse({ v: 1 });
  let context: RpcActionExecutorContext = { authority: 'account_automation', surface: 'rpc', actionCaller: { kind: 'host' },
    serverId: 'home', serverIdentityId: 'home-identity', runtimeAccountId: 'owner', actionRequestId: 'guard-request',
    externalActionTarget: { kind: 'machine', machineId: 'machine' }, defaultSessionMachineId: 'machine',
    machineAdmission: { machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner',
      actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => { verifications++; return current; } };
  const coordinator = createBlockingApprovalCoordinator();
  const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
    custodyBinding: { serverId: 'home', installationId: 'installation' }, resolveAccountId: async () => 'owner', generateOperationId: () => 'cleanup-operation' });
  const getExecutor = (ctx?: ActionExecutorContext) => createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    ...(ctx?.operationAcceptance && ctx.signal ? { hostActionApprovalLifetime: { operationId: ctx.operationAcceptance.operationId, signal: ctx.signal } } : {}),
    // Account Artifact persistence and exact Machine RPC are genuine system boundaries.
    approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'approval' }; },
    approvalsUpdate: async () => ({ ok: true }),
    isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'owner', machineId: 'machine', serverId: 'home',
      // Fresh Home identity/target/account reads are network boundaries.
      resolveCurrentMachineExecutionOriginContext: async () => current ? { machineId: 'machine', serverIdentityId: 'home-identity' } : null,
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine' }), isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }),
    }),
    approvalsWaitForDecision: async args => {
      const result = await coordinator.waitForDecision(args);
      return { ...result, request: ApprovalRequestSchema.parse(result.request) };
    },
    machineProcessesAction: async request => { effects.push(request); onEffect?.(); return { ended: [{ ref: 'exact-ref', freedBytes: 100 }], skipped: [] }; },
    isActionEnabled: (id, ctx) => isActionEnabledByActionsSettings(id, settings, ctx),
    isActionApprovalRequired: (id, ctx) => isApprovalRequiredByActionsSettings(id, settings, ctx),
  });
  const execute = createGuardLeftBehindActionExecutor({ readContext: async () => context, getExecutor,
    observeExecution: request => operations.observeExecution(request) });
  return { execute, requests, effects, settings, operations, coordinator, context, setCurrent(value: boolean) { current = value; },
    verifications: () => verifications, onEffect: (effect: () => void) => { onEffect = effect; },
    setActor(actorAccountId: string) { context = { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId } }; } };
}
describe('Guard left-behind canonical Action bridge', () => {
  it('keeps the admitted cleanup effect result after revoke and re-admits the next request', async () => {
    const f = fixture();
    f.onEffect(() => { f.setCurrent(false); });
    expect(await f.execute({ mode: 'automatic', refs: ['exact-ref'] }))
      .toMatchObject({ ok: true, result: { ended: [{ ref: 'exact-ref', freedBytes: 100 }], skipped: [] } });
    expect(f.verifications()).toBe(1);
    expect(await f.execute({ mode: 'automatic', refs: ['exact-ref'] })).toMatchObject({ ok: false, errorCode: 'scope-retired' });
    expect(f.verifications()).toBe(2);
    expect(f.effects).toHaveLength(1);
  });
  it('accepts cleanup at the real installed operation owner before providing its approval lifetime', async () => {
    const f = fixture();
    let accepted: ActionExecutorContext['operationAcceptance'];
    await f.operations.observeExecution({ actionId: 'machines.processes.leftBehind.cleanUp', input: { machineId: 'machine', refs: ['exact-ref'] },
      rpcContext: f.context, execute: async context => { accepted = context.operationAcceptance; return { ok: true, result: { ended: [], skipped: [] } }; } });
    expect(accepted).toMatchObject({ operationId: 'cleanup-operation', actionId: 'machines.processes.leftBehind.cleanUp' });
  });
  it('creates a real exact-set Session-bound approval and performs no cleanup before approval', async () => {
    const f = fixture();
    expect(await f.execute({ mode: 'ask', refs: ['exact-ref'], sessionId: 'ended-session' })).toEqual({ ok: true, result: { artifactId: 'approval' } });
    expect(f.requests).toMatchObject([{ actionId: 'machines.processes.leftBehind.cleanUp',
      actionArgs: { serverId: 'home-identity', machineId: 'machine', refs: ['exact-ref'] }, createdBy: { surface: 'system', sessionId: 'ended-session' },
      executionOriginV1: { accountId: 'owner', serverIdentityId: 'home-identity', machineId: 'machine', sessionId: 'ended-session',
        authority: 'account_automation', caller: { kind: 'host' } } }]);
    expect(f.effects).toEqual([]);
  });
  it('retains the original approval policy and waits for a real decision before the exact-set effect', async () => {
    const f = fixture();
    f.settings.actions['machines.processes.leftBehind.cleanUp'] = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'machines.processes.leftBehind.cleanUp': { approvalRequiredSurfaces: ['rpc'] } } }).actions['machines.processes.leftBehind.cleanUp']!;
    let settled: unknown;
    const pending = f.execute({ mode: 'automatic', refs: ['exact-ref'], sessionId: 'ended-session' }).then(result => { settled = result; return result; });
    await vi.waitFor(() => expect(f.coordinator.getLiveWaiterCount('approval'), JSON.stringify(settled)).toBe(1));
    expect(f.effects).toEqual([]);
    await f.coordinator.resolveBlockingDecision({ artifactId: 'approval', request: ApprovalRequestSchema.parse(f.requests[0]), decision: 'approve', decisionAuthority: 'present_user' });
    const result = await pending;
    expect(result, JSON.stringify(result))
      .toMatchObject({ ok: true, result: { ended: [{ ref: 'exact-ref' }], skipped: [] } });
    expect(f.effects).toMatchObject([{ input: { serverId: 'home-identity', machineId: 'machine', refs: ['exact-ref'] },
      context: { authority: 'account_automation', surface: 'rpc', defaultSessionId: 'ended-session' } }]);
  });
  it('uses the canonical default internal RPC policy for Automatic without fabricating approval', async () => {
    const f = fixture();
    expect(await f.execute({ mode: 'automatic', refs: ['exact-ref'] })).toMatchObject({ ok: true, result: { ended: [{ ref: 'exact-ref' }] } });
    expect(f.requests).toEqual([]);
    expect(f.effects).toMatchObject([{ context: { operationAcceptance: { operationId: 'cleanup-operation' }, authority: 'account_automation', actionCaller: { kind: 'host' } } }]);
  });
  it('fails closed before persistence or effects on retired custody or a non-custodian context', async () => {
    const f = fixture(); f.setCurrent(false);
    expect(await f.execute({ mode: 'ask', refs: ['exact-ref'] })).toMatchObject({ ok: false, errorCode: 'scope-retired' });
    f.setCurrent(true); f.setActor('recipient');
    expect(await f.execute({ mode: 'automatic', refs: ['exact-ref'] })).toMatchObject({ ok: false, errorCode: 'scope-retired' });
    expect(f.requests).toEqual([]); expect(f.effects).toEqual([]);
  });
  it('keeps the original cleanup Action disabled by current Account policy', async () => {
    const f = fixture(); f.settings.actions['machines.processes.leftBehind.cleanUp'] = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'machines.processes.leftBehind.cleanUp': { enabled: false } } }).actions['machines.processes.leftBehind.cleanUp']!;
    expect(await f.execute({ mode: 'automatic', refs: ['exact-ref'] })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(f.requests).toEqual([]); expect(f.effects).toEqual([]);
  });
});
