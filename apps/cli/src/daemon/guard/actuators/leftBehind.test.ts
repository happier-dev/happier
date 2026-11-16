import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestSchema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { MachineProcessesCleanUpInputV1Schema, MachineProcessesStartAgainInputV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { createProcessActionExecutor } from '../../processes/actions/processActionExecutor';
import { processRef } from '../../processes/view/processRef';
import { reconstructEndedSessionProcessRoot } from '../../processes/roots/listHappierProcessRoots';
import { createActivityLog } from '../activityLog';
import { createMinuteHistoryStore } from '../../vitals/history/minuteHistoryStore';
import { createMachineVitalsSampler } from '../../vitals/createMachineVitalsSampler';
import { createMachineResourceSummary } from '../../resources/machineResourceSummary';
import { createHostActionOperationRuntime } from '../../actionOperations/createHostActionOperationRuntime';
import { createGuardLeftBehindActionExecutor } from '../actions';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createDaemonApprovalExecutionOriginCurrentness } from '../../externalActions/daemonExternalActionTargetResolver';
import { createLeftBehindActuator, planLeftBehind, readLeftBehindRestoration, type LeftBehindRestoration } from './leftBehind';
import type { HappierProcessRootSource } from '../../processes/roots/listHappierProcessRoots';
import { createGuardLeftBehindFixture as fixture, guardLeftBehindOwner as owner,
  guardLeftBehindAttribution as attribution } from './leftBehind.testkit';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });

async function actionFixture(requireApproval = false) {
  const f = fixture();
  await f.observe(); f.advance(60_000); await f.observe();
  const signals: number[] = [];
  const nativeActions = createProcessActionExecutor({ ownership: f.ownership, leftBehind: f.tracker,
    allProcessesVisible: () => false, requesterForOwner: () => attribution, selfPid: process.pid, platform: 'darwin',
    systemBoundary: { platform: 'darwin', censusDependencies: f.censusDependencies,
      kill(pid) { signals.push(pid); f.rows.delete(pid); }, wait: async () => undefined } });
  const requests: ApprovalRequest[] = [];
  let stored: ApprovalRequest | undefined;
  let approvalUnavailable = false;
  const settings = ActionsSettingsV1Schema.parse({ v: 1,
    ...(requireApproval ? { actions: { 'machines.processes.leftBehind.cleanUp': { approvalRequiredSurfaces: ['rpc'] } } }
      : { approvalWaivedSurfaces: { 'machines.processes.leftBehind.cleanUp': ['rpc'] } }) });
  const coordinator = createBlockingApprovalCoordinator();
  cleanup.push(() => coordinator.dispose());
  const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
    custodyBinding: { serverId: 'home', installationId: 'install' }, resolveAccountId: async () => 'owner' });
  // The Machine RPC and Account Artifact boundaries are substituted; both real Action and cleanup owners run underneath.
  const deps: Partial<ActionExecutorDeps> = {
    readActionsSettings: () => settings,
    machineProcessesAction: async request => {
      if (request.actionId === 'machines.processes.startAgain') return nativeActions.startAgain(
        MachineProcessesStartAgainInputV1Schema.parse(request.input), { accountId: 'owner', isCustodian: true },
        { signal: request.signal ?? request.context.signal });
      if (request.actionId !== 'machines.processes.leftBehind.cleanUp') throw new Error('Unexpected fixture Action');
      return nativeActions.cleanUp(MachineProcessesCleanUpInputV1Schema.parse(request.input),
        { accountId: 'owner', isCustodian: true }, { signal: request.signal ?? request.context.signal });
    },
    approvalsCreate: async ({ request }) => {
      if (approvalUnavailable) throw new Error('Account unavailable');
      requests.push(request); stored = request; return { artifactId: 'approval' };
    },
    approvalsGet: async () => stored ?? null,
    approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
    approvalsWaitForDecision: async args => {
      const result = await coordinator.waitForDecision(args);
      return { ...result, request: ApprovalRequestSchema.parse(result.request) };
    },
    approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
    isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'owner', machineId: 'machine', serverId: 'home',
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: 'home-identity' }),
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine' }), isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }),
    }),
  };
  const actions = createActionExecutor(deps as ActionExecutorDeps);
  const getExecutor = (context?: ActionExecutorContext) => createActionExecutor({ ...deps,
    ...(context?.operationAcceptance && context.signal ? { hostActionApprovalLifetime: {
      operationId: context.operationAcceptance.operationId, signal: context.signal } } : {}) } as ActionExecutorDeps);
  const context: RpcActionExecutorContext = { surface: 'rpc', authority: 'account_automation',
    actionCaller: { kind: 'host' }, runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'home-identity',
    actionRequestId: 'guard-left-behind', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    defaultSessionMachineId: 'machine', machineAdmission: { machineId: 'machine', installationId: 'install',
      custodianAccountId: 'owner', actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true };
  const executeAction = createGuardLeftBehindActionExecutor({ readContext: async () => context, getExecutor,
    observeExecution: request => operations.observeExecution(request) });
  const directory = await mkdtemp(join(tmpdir(), 'happier-left-behind-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const history = await createMinuteHistoryStore({ directory: join(directory, 'history') });
  const sampler = createMachineVitalsSampler({ historyStore: history,
    readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) } });
  await sampler.start(); cleanup.push(() => sampler.stop());
  const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, nowMs: f.now,
    onError: error => { throw error; } });
  cleanup.push(() => summary.stop());
  const activity = await createActivityLog({ activeServerDir: directory, nowMs: f.now, resourceSummary: summary });
  let policy = { mode: 'automatic' as 'off' | 'ask' | 'automatic', graceMs: 0 };
  let endedRoots: readonly HappierProcessRootSource[] = f.roots;
  let restoration: LeftBehindRestoration | null | undefined;
  const actuator = createLeftBehindActuator({ activity, nowMs: f.now,
    readPolicy: () => policy, confirmed: () => f.tracker.confirmed(), readRestoration: owner => restoration === undefined
      ? readLeftBehindRestoration({ owner, endedRoots, machineId: 'machine' }) : restoration,
    executeAction,
  });
  const decision = () => planLeftBehind({ policy, confirmed: f.tracker.confirmed(), now: f.now() }).due[0]!;
  return { ...f, actuator, activity, summary, signals, requests, actions, decision, coordinator,
    setPolicy: (value: typeof policy) => { policy = value; },
    setRestoration: (value: LeftBehindRestoration | null) => { restoration = value; },
    setEndedRoots: (value: readonly HappierProcessRootSource[]) => { endedRoots = value; f.roots.splice(0, f.roots.length, ...value); },
    setApprovalUnavailable: (value: boolean) => { approvalUnavailable = value; } };
}

describe('Left-behind Guard policy consumes confirmed native verdicts', () => {
  it.each(['ask', 'automatic'] as const)('restores marker-owned restart leftovers into %s ingress after two native observations', async mode => {
    const f = await actionFixture();
    const restored = reconstructEndedSessionProcessRoot({ marker: { pid: 200, happySessionId: owner.sessionId,
      processStartTimeMs: 200, createdAt: 200, cwd: '/project', requesterWorkAttributionV1: attribution },
      session: { pid: 200, sessionId: owner.sessionId, processStartTimeMs: 200 }, endedAtMs: f.now() });
    expect(restored).not.toBeNull();
    f.setEndedRoots(restored ? [restored] : []);
    f.setPolicy({ mode, graceMs: 0 });
    const result = await f.actuator.execute(f.decision(), new AbortController().signal);
    expect(result.status).toBe(mode === 'ask' ? 'requested' : 'cleaned');
    expect(mode === 'ask' ? f.requests.length : f.signals.length).toBe(mode === 'ask' ? 1 : 2);
    if (mode === 'automatic') {
      const receipt = (await f.activity.list({ range: 'today' })).entries[0]!;
      const wayBack = receipt.wayBack?.[0];
      expect(wayBack?.actionId).toBe('machines.processes.startAgain');
      expect(await f.actions.execute('machines.processes.startAgain', wayBack!.input,
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' }))
        .toMatchObject({ ok: true, result: { status: 'already_wakes_on_next_message' } });
    }
  });

  it.each(['ask', 'automatic'] as const)('records unavailable %s recovery truthfully without borrowing requester authority or entering cleanup', async mode => {
    const f = await actionFixture();
    f.setPolicy({ mode, graceMs: 0 });
    const restored = reconstructEndedSessionProcessRoot({ marker: { pid: 200, happySessionId: owner.sessionId,
      processStartTimeMs: 200, createdAt: 200 },
      session: { pid: 200, sessionId: owner.sessionId, processStartTimeMs: 200 }, endedAtMs: f.now() });
    f.setEndedRoots(restored ? [restored] : []);
    expect(await f.actuator.execute(f.decision(), new AbortController().signal)).toEqual({ status: 'unsupported' });
    expect(f.signals).toEqual([]);
    expect(f.requests).toEqual([]);
    expect((await f.activity.list({ range: 'today' })).entries).toMatchObject([{ kind: 'stop_failed', outcome: 'failed',
      note: expect.any(String), attribution: { kind: 'unknown' } }]);
    expect(f.actuator.plan().due).toEqual([]);
    expect((await f.activity.list({ range: 'today' })).entries).toHaveLength(1);
  });

  it('refuses cleanup when the ended owner generation is unknown despite confirmed child identities', async () => {
    const f = await actionFixture();
    f.setEndedRoots(f.roots.map(({ start: _start, ...root }) => root));
    expect(f.tracker.confirmed()).toHaveLength(2);
    expect(await f.actuator.execute(f.decision(), new AbortController().signal)).toEqual({ status: 'unsupported' });
    expect(f.signals).toEqual([]);
    expect(f.requests).toEqual([]);
    expect((await f.activity.list({ range: 'today' })).entries).toMatchObject([{ kind: 'stop_failed', note: expect.any(String) }]);
  });

  it('does nothing when Off or unconfirmed and uses the exact confirmed grace deadline, including Custom values', async () => {
    const f = fixture();
    await f.observe();
    expect(planLeftBehind({ policy: { mode: 'automatic', graceMs: 0 }, confirmed: f.tracker.confirmed(), now: f.now() }))
      .toEqual({ due: [] });
    f.advance(60_000); await f.observe();
    const confirmed = f.tracker.confirmed();
    expect(confirmed).toHaveLength(2);
    expect(planLeftBehind({ policy: { mode: 'off', graceMs: 0 }, confirmed, now: f.now() })).toEqual({ due: [] });
    const graceMs = 2_147_483_647 + 123_456;
    const deadline = f.now() + graceMs;
    expect(planLeftBehind({ policy: { mode: 'ask', graceMs }, confirmed, now: deadline - 1 }))
      .toEqual({ due: [], nextAt: deadline });
    expect(planLeftBehind({ policy: { mode: 'ask', graceMs }, confirmed, now: deadline }).due)
      .toMatchObject([{ mode: 'ask', owner, refs: confirmed.map(item => item.ref).sort() }]);
    expect(planLeftBehind({ policy: { mode: 'automatic', graceMs: 0 }, confirmed, now: f.now() }).due)
      .toMatchObject([{ mode: 'automatic', owner, refs: confirmed.map(item => item.ref).sort() }]);
  });

  it('executes the canonical cleanup Action and records only the ended identities, never the candidate count', async () => {
    const f = await actionFixture();
    const decision = f.decision();
    f.rows.set(301, { ...f.rows.get(301)!, start: { startTimeMs: 999, native: 'darwin-proc:301:0:999' } });
    expect(await f.actuator.execute(decision, new AbortController().signal))
      .toEqual({ status: 'cleaned', ended: 1, skipped: 1 });
    expect(f.signals).toEqual([300]);
    expect((await f.activity.list({ range: 'today' })).entries).toMatchObject([{ kind: 'stopped_left_behind',
      rule: 'left_behind', subject: { kind: 'processes', count: 1 }, freedBytes: 3000, outcome: 'done',
      attribution, wayBack: [{ label: 'start_again', actionId: 'machines.processes.startAgain' }] }]);
    expect(f.summary.getSummary()?.lastAutomaticAction?.facts).toEqual({ rule: 'left_behind', freedBytes: 3000, count: 1 });
  });

  it('creates one Session-bound Ask for the exact set and approval cleans only that set after native recheck', async () => {
    const f = await actionFixture(); f.setPolicy({ mode: 'ask', graceMs: 0 });
    const decision = f.decision();
    expect(await f.actuator.execute(decision, new AbortController().signal)).toEqual({ status: 'requested', artifactId: 'approval' });
    expect(await f.actuator.execute(decision, new AbortController().signal)).toEqual({ status: 'already_requested' });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ actionId: 'machines.processes.leftBehind.cleanUp',
      actionArgs: { serverId: 'home-identity', machineId: 'machine', refs: [...decision.refs] }, createdBy: { sessionId: owner.sessionId } });
    expect(f.signals).toEqual([]);
    f.rows.set(301, { ...f.rows.get(301)!, start: { startTimeMs: 999, native: 'darwin-proc:301:0:999' } });
    expect(await f.actions.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' })).toMatchObject({ ok: true });
    expect(f.signals).toEqual([300]);
    expect(f.rows.has(301)).toBe(true);
  });

  it('records the actual approved subset after blocking approval narrows the original confirmed set', async () => {
    const f = await actionFixture(true);
    const decision = f.decision();
    const pending = f.actuator.execute(decision, new AbortController().signal);
    await vi.waitFor(() => expect(f.coordinator.getLiveWaiterCount('approval')).toBe(1));
    const ref = processRef(300, f.rows.get(300)!.start);
    expect(await f.actions.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve',
      narrowedInput: { serverId: 'home-identity', machineId: 'machine', refs: [ref] } },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' })).toMatchObject({ ok: true });
    expect(await pending).toEqual({ status: 'cleaned', ended: 1, skipped: 0 });
    expect(f.signals).toEqual([300]);
    expect(f.rows.has(301)).toBe(true);
    expect((await f.activity.list({ range: 'today' })).entries).toMatchObject([{ kind: 'stopped_left_behind',
      outcome: 'done', subject: { kind: 'processes', count: 1 }, freedBytes: 3000, attribution,
      wayBack: [{ label: 'start_again', actionId: 'machines.processes.startAgain' }] }]);
  });

  it('withdraws changed grace, Off, cancellation or unavailable restoration before reaching the Action', async () => {
    const f = await actionFixture(); const decision = f.decision();
    f.setPolicy({ mode: 'automatic', graceMs: 1 });
    expect(await f.actuator.execute(decision, new AbortController().signal)).toEqual({ status: 'stale' });
    f.setPolicy({ mode: 'off', graceMs: 0 });
    expect(await f.actuator.execute(decision, new AbortController().signal)).toEqual({ status: 'stale' });
    f.setPolicy({ mode: 'automatic', graceMs: 0 }); f.setRestoration(null);
    expect(await f.actuator.execute(decision, new AbortController().signal)).toEqual({ status: 'unsupported' });
    const controller = new AbortController(); controller.abort();
    expect(await f.actuator.execute(decision, controller.signal)).toEqual({ status: 'failed', reason: 'cancelled' });
    expect(f.signals).toEqual([]);
    expect((await f.activity.list({ range: 'today' })).entries).toMatchObject([{ kind: 'stop_failed', note: expect.any(String) }]);
  });

  it('keeps a failed Ask observable and allows a later owner edge to request it successfully', async () => {
    const f = await actionFixture(); f.setPolicy({ mode: 'ask', graceMs: 0 }); f.setApprovalUnavailable(true);
    expect(await f.actuator.execute(f.decision(), new AbortController().signal)).toMatchObject({ status: 'failed' });
    expect(f.actuator.plan().due).toEqual([]);
    f.setApprovalUnavailable(false);
    f.actuator.invalidateFailures();
    expect(await f.actuator.execute(f.decision(), new AbortController().signal)).toEqual({ status: 'requested', artifactId: 'approval' });
    expect(f.requests).toHaveLength(1);
    expect(f.signals).toEqual([]);
  });

  it('does not repeat requested identities when another child is confirmed later for the same owner', async () => {
    const f = await actionFixture(); f.setPolicy({ mode: 'ask', graceMs: 0 });
    const decision = f.actuator.plan().due[0]!;
    expect(await f.actuator.execute(decision, new AbortController().signal)).toMatchObject({ status: 'requested' });
    expect(f.actuator.plan().due).toEqual([]);
    f.rows.set(302, { ...f.rows.get(300)!, pid: 302, pgid: 302,
      start: { startTimeMs: 302, native: 'darwin-proc:302:0:302' } });
    await f.observe(); f.advance(60_000); await f.observe();
    const next = f.actuator.plan().due[0]!;
    expect(next.refs).toEqual([processRef(302, f.rows.get(302)!.start)]);
    expect(await f.actuator.execute(next, new AbortController().signal)).toMatchObject({ status: 'requested' });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.actionArgs).toMatchObject({ refs: next.refs });
    expect(f.signals).toEqual([]);
  });
});
