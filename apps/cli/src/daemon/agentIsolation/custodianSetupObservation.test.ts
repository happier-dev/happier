import { expect, it, vi } from 'vitest';
import { checkMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { createCapabilitiesService, assertMachineSystemTaskResponseCurrent } from '@/capabilities/service';
import { createSystemTasksCapability } from '@/capabilities/registry/toolSystemTasks';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { runElevatedEffect } from '@/machines/adminAccess/runElevatedEffect';

it('keeps member operation scope while the real enrolled-custodian child exposes and authenticates its setup task only to the owner', async () => {
  let nextId = 0;
  const runtime = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
    custodyBinding: { serverId: 'home', installationId: 'installation' },
    resolveAccountId: async () => 'custodian', generateOperationId: () => `managed-setup-${++nextId}` });
  const context = (actorAccountId: string, role: 'use' | 'manage'): RpcHandlerContext => ({
    signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId, custodianAccountId: 'custodian', machineId: 'machine',
      installationId: 'installation', role, encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true,
  });
  const member = context('member', 'use'), owner = context('custodian', 'manage'), manager = context('manager', 'manage');
  await runtime.observeExecution({ actionId: 'projects.script.run', input: { requestId: 'member-script' }, rpcContext: member,
    execute: async () => ({ ok: true, result: {} }) });

  const native = createAgentIsolationEffectsBoundary({ installationId: 'installation',
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
    publishStatus: async () => {}, adminAccess: { version: 1, mode: 'ask', administratorUsername: 'operator' } });
  const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 },
    steps: [{ id: 'fixture-group', kind: 'group', name: 'fixture', members: [] }], backend: native.effects.backend! });
  const tasks = getLiveSystemTasksRunnerAdapter();
  const capabilities = createCapabilitiesService({ capabilities: [createSystemTasksCapability(tasks)],
    checklists: { 'new-session': [], 'machine-details': [] }, buildContext: async () => ({ cliSnapshot: null }) });
  let taskId: string | undefined;
  const child = runtime.observeExecution({
    actionId: 'machines.agentIsolation.set',
    input: { kind: 'memberIdentityProvisioning', homeServerIdentityId: 'home', machineId: 'machine',
      installationId: 'installation', accountId: 'member' },
    // Deliberate host-internal managed effect: the real runtime resolves its
    // enrolled Account. No owner RPC/admission or alternate scope is fabricated.
    execute: async operation => {
      const operationId = operation.operationAcceptance?.operationId;
      if (!operationId || !runtime.store.get({ accountId: 'custodian', machineId: 'machine' }, operationId))
        throw new Error('The actual enrolled operation owner must match the target custodian');
      const task = await tasks.startAdmitted({ run: async taskContext => {
        const result = await runElevatedEffect({ machineId: 'machine', operationId,
          effect: { kind: 'setupOperation', plans: [{ plan }] } },
        { ...native.effects.elevation, verifyCurrent: async () => !operation.signal.aborted,
          prompt: question => taskContext.prompt({ ...question, validateResponse: async authorization => {
            await assertMachineSystemTaskResponseCurrent(authorization, {
              admission: owner.machineAdmission!, verifyCurrent: async () => !operation.signal.aborted,
            });
          } }), emit: taskContext.emit });
        return { applied: result.outcome === 'applied' };
      } }, 'machine.setup.apply.v1');
      taskId = task.taskId;
      operation.operationOwnerUpdate.update({ domainRef: { kind: 'machineSetup', serverId: 'home',
        machineId: 'machine', setupTask: { id: task.taskId, taskKind: 'machine.setup.apply.v1' } } });
      const settled = await tasks.wait(task);
      return settled.ok ? { ok: true, result: {} } : { ok: false, errorCode: 'member_setup_required', error: 'Owner setup required' };
    },
  });
  try {
    await vi.waitFor(async () => {
      expect(taskId).toBeDefined();
      if (!taskId) throw new Error('Expected admitted task');
      expect(await tasks.poll({ taskId, cursor: 0 })).toMatchObject({ pendingPrompt: { kind: 'sudo.password' } });
    });
    const ownerRows = await runtime.handlers.listV2({}, owner);
    expect(ownerRows.items).toHaveLength(1);
    expect(ownerRows.items[0]).toMatchObject({ actionId: 'machines.agentIsolation.set',
      scope: { accountId: 'custodian' }, domainRef: { kind: 'machineSetup', setupTask: { id: taskId } } });
    const memberRows = await runtime.handlers.listV2({}, member);
    expect(memberRows.items).toHaveLength(1);
    expect(memberRows.items[0]).toMatchObject({ actionId: 'projects.script.run', scope: { accountId: 'member' } });
    expect(await runtime.handlers.getV2({ operationId: ownerRows.items[0]!.operationId }, member)).toEqual({ kind: 'not_found' });

    const responseContext = (caller: RpcHandlerContext) => ({
      admission: caller.machineAdmission!, callerAuthority: caller.callerAuthority,
      signal: caller.signal, verifyCurrent: caller.verifyMachineAdmissionCurrent!,
    });
    const respond = (caller: RpcHandlerContext) => capabilities.invoke({ id: 'tool.systemTasks', method: 'respond',
      params: { taskId, expectedPromptKind: 'sudo.password', answer: { password: 'one-use-password' },
        responseAuthorization: responseContext(owner) } }, { machineSystemTaskResponse: responseContext(caller) });
    // The real capability owner strips public responseAuthorization and uses
    // independent host-admitted response context. Knowing a task id is no grant.
    expect(await respond(member)).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(await respond(manager)).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(native.launches).toEqual([]);
    expect(native.mutations).toEqual([]);
    expect(await respond(owner)).toMatchObject({ ok: true });
    expect(await child).toMatchObject({ ok: true });
    expect(native.mutations).toContain('fixture-group');
    expect(native.launches).toHaveLength(1);
    expect(native.boundaryFailures).toEqual([]);
    expect(JSON.stringify(await tasks.poll({ taskId, cursor: 0 }))).not.toContain('one-use-password');
  } finally {
    if (taskId) await tasks.cancel({ taskId });
    await child;
  }
});
