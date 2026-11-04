import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHostRequesterAgentPlacementForHost } from './agentIsolationLaunchPolicy';
import type { MachineAdminAccessV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { createCapabilitiesService } from '@/capabilities/service';
import { createSystemTasksCapability } from '@/capabilities/registry/toolSystemTasks';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { registerMachineAccessLossReceiver } from '@/daemon/externalActions/registerMachineAccessLossReceiver';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { readAgentIsolationMemberBindingForAccount, writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from '@/daemon/agentIsolation/provisioning';
import { ensureAgentIsolationMember } from './ensureAgentIsolationMember';

const os = vi.hoisted(() => ({ home: '', actual: '' }));
// Native account facts and home metadata are OS boundaries. P10 framing,
// CHECK/APPLY interpretation, operation custody and binding IO remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => String(path) === os.home
      ? Object.assign(await actual.lstat(os.actual), { uid: 2401, gid: 2401, mode: 0o40700 }) : actual.lstat(path),
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => String(path) === os.home ? os.home : actual.realpath(path),
  };
});
const requesterIdentity: AgentIsolationMemberRequester = { kind: 'isolated', separationRequired: true,
  homeServerIdentityId: 'canonical-home', requester: { serverId: 'saved-profile', accountId: 'member',
    machineId: 'machine', installationId: 'installation' } };
const derived = deriveAgentIsolationMemberIdentity(requesterIdentity);
const observed = { ...derived, agentUid: 2401, agentGid: 2401 };

describe.skipIf(process.platform !== 'linux')('existing P11/P10 first-use member setup', () => {
  let activeServerDir: string;
  beforeEach(async () => {
    activeServerDir = await mkdtemp(join(tmpdir(), 'happier-member-first-use-'));
    os.home = derived.home; os.actual = activeServerDir;
  });
  afterEach(async () => { await rm(activeServerDir, { recursive: true, force: true }); });

  const fixture = (adminAccess: MachineAdminAccessV1 = { version: 1, mode: 'preauthorized' }) =>
    createAgentIsolationMemberPreparationBoundary({ activeServerDir, requesterIdentity, uid: 2401,
      custodianAccountId: 'custodian', encryptionMode: 'plain', adminAccess });

  it('uses one local custody check and one real shim probe without re-reading an admitted member policy', async () => {
    const native = fixture();
    expect(await native.prepare()).toMatchObject({ kind: 'ready' });
    native.permissionQueries.length = 0;
    const read = vi.spyOn(native.port, 'read');
    let custodyChecks = 0;
    const result = await ensureAgentIsolationMember({ requesterIdentity, activeServerDir,
      verifyLocalCustody: async () => { custodyChecks++; return true; },
      setup: async () => { throw new Error('Warm member must not require repair'); } }, native.effects);
    expect(result).toMatchObject({ kind: 'ready' });
    expect({ custodyChecks, metadataReads: read.mock.calls.length,
      shimProbes: native.permissionQueries.filter(probe => !probe.args.includes('-l')).length,
      sudoListProbes: native.permissionQueries.filter(probe => probe.args.includes('-l')).length })
      .toEqual({ custodyChecks: 1, metadataReads: 0, shimProbes: 1, sudoListProbes: 0 });
  });

  it('creates only its admitted qualified user and reuses qualified warm native state without an elevated effect or operation', async () => {
    const native = fixture();
    const cold = await native.run();
    expect(cold).toMatchObject({ kind: 'ready', identity: { username: derived.username, agentUid: 2401 },
      daemonObservation: { daemonUsername: 'happier', daemonPrimaryGroup: 'happier' } });
    expect(native.launches).toHaveLength(1);
    expect(native.mutations).toContain('agent-account');
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir, homeServerIdentityId: 'canonical-home',
      machineId: 'machine', installationId: 'installation' }, 'member')).toMatchObject({ uid: 2401 });
    const path = join(activeServerDir, 'agent-isolation', 'members', `${derived.digest}.json`);
    const before = await lstat(path);
    const operationsBefore = native.runtime.store.readLiveWork().items.map(item => item.ownerRef);
    native.resetObservations(); native.mutations.length = 0; native.launches.length = 0;
    expect(await native.run()).toMatchObject({ kind: 'ready', identity: { agentUid: 2401 } });
    expect(native.userObservations()).toBeGreaterThan(0);
    expect(native.mutations).toEqual([]);
    expect(native.launches).toHaveLength(0);
    expect(native.runtime.store.readLiveWork().items.map(item => item.ownerRef)).toEqual(operationsBefore);
    expect(native.permissionQueries).toEqual([{ command: 'sudo', args: [
      '-n', '-u', derived.username, '--', '/opt/happier/cli/current/happier', 'agent-launch',
    ] }]);
    expect((await lstat(path)).ino).toBe(before.ino);
    expect(native.boundaryFailures).toEqual([]);
    native.setHeldObservation(false);
    expect(await native.run()).toMatchObject({ kind: 'ready' });
  });

  it.each(['ask', 'none'] as const)('uses retained native readiness in %s mode without prompting, elevating or recording setup', async mode => {
    const installed = fixture();
    expect(await installed.prepare()).toMatchObject({ kind: 'ready' });
    const native = createAgentIsolationMemberPreparationBoundary({ activeServerDir, requesterIdentity, uid: 2401,
      custodianAccountId: 'custodian', encryptionMode: 'plain', nativeState: installed.nativeState,
      adminAccess: mode === 'ask' ? { version: 1, mode, administratorUsername: 'operator' } : { version: 1, mode } });
    const lifetime = new AbortController();
    let prompted!: () => void;
    const prompt = new Promise<Readonly<{ kind: 'prompted' }>>(resolve => { prompted = () => resolve({ kind: 'prompted' }); });
    const unsubscribe = native.runtime.store.subscribe(() => {
      const rows = native.runtime.store.readLiveWork().items;
      if (rows.some(item => {
        if (typeof item.ownerRef !== 'string') return false;
        const row = native.runtime.store.get({ accountId: 'custodian', machineId: 'machine' }, item.ownerRef);
        return row?.domainRef?.kind === 'machineSetup' && !!row.domainRef.setupTask?.prompt;
      })) prompted();
    });
    const preparation = native.prepare({ signal: lifetime.signal });
    try {
      const outcome = await Promise.race([preparation.then(result => ({ kind: 'settled' as const, result })), prompt]);
      expect(outcome).toMatchObject({ kind: 'settled', result: { kind: 'ready', identity: { agentUid: 2401 } } });
      expect(native.launches).toEqual([]);
      expect(native.mutations).toEqual([]);
      expect(native.runtime.store.readLiveWork().items).toEqual([]);
      expect(native.permissionQueries).toHaveLength(1);
    } finally {
      unsubscribe(); lifetime.abort(); await preparation;
    }
  });

  it('repairs withdrawn RunAs at the next ordinary admitted start while preserving the reserved UID and private binding', async () => {
    const native = fixture();
    const rpcContext: RpcHandlerContext = { signal: new AbortController().signal, transportRequestId: 'same-admitted-request' };
    expect(await native.prepare({ rpcContext })).toMatchObject({ kind: 'ready' });
    const path = join(activeServerDir, 'agent-isolation', 'members', `${derived.digest}.json`);
    const before = await lstat(path);
    // OS fixture represents the exact managed rule withdrawn by retirement;
    // retained user/binding/private authored files survive that operation.
    native.installed.delete('agent-runas');
    native.mutations.length = 0; native.launches.length = 0;
    expect(await native.prepare({ rpcContext })).toMatchObject({ kind: 'ready', identity: { agentUid: 2401 } });
    expect(native.permissionQueries).toHaveLength(2);
    expect(native.permissionQueries.every(probe => !probe.args.includes('-l'))).toBe(true);
    expect(native.mutations).toEqual(['agent-runas']);
    expect(native.launches).toHaveLength(1);
    expect((await lstat(path)).ino).toBe(before.ino);
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir, homeServerIdentityId: 'canonical-home',
      machineId: 'machine', installationId: 'installation' }, 'member')).toMatchObject({ uid: 2401 });
  });

  it('refuses root-CHECK UID reassociation before any recovery mutation of a retained identity', async () => {
    const native = fixture();
    expect(await native.run()).toMatchObject({ kind: 'ready' });
    native.installed.delete('agent-runas');
    native.mutations.length = 0;
    // The retained projection reserves 2401; root CHECK now observes a changed
    // numeric account. Recovery must not chown its retained private data.
    native.setRootUid(2402);
    expect(await native.run()).toMatchObject({ kind: 'not_ready', result: { outcome: 'not_applied', reasonCode: 'denied' } });
    expect(native.mutations).toEqual([]);
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir, homeServerIdentityId: 'canonical-home',
      machineId: 'machine', installationId: 'installation' }, 'member')).toMatchObject({ uid: 2401 });
  });

  it('repairs changed effective RunAs permission at the next ordinary warm start without rewriting the retained identity', async () => {
    const native = fixture();
    expect(await native.prepare()).toMatchObject({ kind: 'ready' });
    const path = join(activeServerDir, 'agent-isolation', 'members', `${derived.digest}.json`);
    const before = await lstat(path);
    native.drifted.add('agent-runas');
    native.mutations.length = 0; native.launches.length = 0;
    expect(await native.prepare()).toMatchObject({ kind: 'ready', identity: { agentUid: 2401 } });
    expect(native.permissionQueries).toHaveLength(2);
    expect(native.mutations).toEqual(['agent-runas']);
    expect(native.drifted.has('agent-runas')).toBe(false);
    expect(native.launches).toHaveLength(1);
    expect((await lstat(path)).ino).toBe(before.ino);
  });

  it('repairs withdrawn RunAs after daemon restart through ordinary admitted start with only retained binding and native state', async () => {
    const native = fixture();
    expect(await native.prepare()).toMatchObject({ kind: 'ready' });
    native.installed.delete('agent-runas');
    const restarted = createAgentIsolationMemberPreparationBoundary({ activeServerDir, requesterIdentity, uid: 2401,
      custodianAccountId: 'custodian', encryptionMode: 'plain', nativeState: native.nativeState });
    expect(await restarted.prepare()).toMatchObject({ kind: 'ready', identity: { agentUid: 2401 } });
    expect(restarted.permissionQueries).toHaveLength(2);
    expect(restarted.mutations).toEqual(['agent-runas']);
    expect(restarted.launches).toHaveLength(1);
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir, homeServerIdentityId: 'canonical-home',
      machineId: 'machine', installationId: 'installation' }, 'member')).toMatchObject({ uid: 2401 });
  });

  it('refuses explicit off before member setup even with reviewed provisioning consent', async () => {
    const native = fixture();
    native.setPolicy({ enabled: false, memberProvisioning: 'linuxUsersV1' });
    expect(await native.prepare()).toMatchObject({ kind: 'not_ready', result: { outcome: 'not_applied', reasonCode: 'denied' } });
    expect(native.mutations).toEqual([]);
    expect(native.launches).toEqual([]);
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir, homeServerIdentityId: 'canonical-home',
      machineId: 'machine', installationId: 'installation' }, 'member')).toBeNull();
  });

  it.each([false, true])('keeps explicit member setup unavailable when provisioning is off (enabled=%s)', async enabled => {
    const native = fixture();
    native.setPolicy({ enabled });
    // Execution dispatch never invokes member setup for these placements.
    expect(resolveHostRequesterAgentPlacementForHost({ identity: requesterIdentity, snapshot: { enabled } }))
      .toBe(enabled ? 'sharedAgent' : 'daemon');
    expect(await native.run()).toMatchObject({ kind: 'not_ready', result: { reasonCode: 'denied' } });
    expect(native.launches).toEqual([]);
    expect(native.mutations).toEqual([]);
  });

  it('recreates a genuinely missing bound user at the retained UID before ordinary start, never at a new allocator UID', async () => {
    const native = fixture();
    expect(await native.prepare()).toMatchObject({ kind: 'ready', identity: { agentUid: 2401 } });
    const path = join(activeServerDir, 'agent-isolation', 'members', `${derived.digest}.json`);
    const before = await lstat(path);
    native.installed.delete('agent-account');
    native.setNextAllocatedUid(2402);
    native.mutations.length = 0; native.launches.length = 0;
    expect(await native.prepare()).toMatchObject({ kind: 'ready', identity: { agentUid: 2401 } });
    expect(native.nativeState.accountUid).toBe(2401);
    expect(native.mutations).toEqual(['agent-account']);
    expect(native.launches).toHaveLength(1);
    expect((await lstat(path)).ino).toBe(before.ino);
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir, homeServerIdentityId: 'canonical-home',
      machineId: 'machine', installationId: 'installation' }, 'member')).toMatchObject({ uid: 2401 });
  });

  it('settles None as setup-required without an OS mutation', async () => {
    const none = fixture({ version: 1, mode: 'none' });
    expect(await none.run()).toMatchObject({ kind: 'not_ready', result: { outcome: 'not_applied', reasonCode: 'mode_none' } });
    expect(none.mutations).toEqual([]);
    expect(none.launches).toEqual([]);
  });

  it('routes real member first use through an enrolled-owner child whose actual setup task admits only the owner response', async () => {
    const native = fixture({ version: 1, mode: 'ask', administratorUsername: 'operator' });
    const { runtime, members } = native;
    const ingressLifetime = new AbortController();
    const context = (actorAccountId: string, role: 'use' | 'manage'): RpcHandlerContext => ({
      signal: ingressLifetime.signal, callerAuthority: 'present_user', verifyMachineAdmissionCurrent: async () => true,
      machineAdmission: { actorAccountId, custodianAccountId: 'custodian', machineId: 'machine',
        installationId: 'installation', role, encryptionMode: 'plain' },
    });
    const member = context('member', 'use'), owner = context('custodian', 'manage'), manager = context('manager', 'manage');
    const tasks = getLiveSystemTasksRunnerAdapter();
    const capabilities = createCapabilitiesService({ capabilities: [createSystemTasksCapability(tasks)],
      checklists: { 'new-session': [], 'machine-details': [] }, buildContext: async () => ({ cliSnapshot: null }) });
    const original = runtime.observeExecution({ actionId: 'projects.script.run', input: { requestId: 'member-first-use' }, rpcContext: member,
      execute: async operation => {
        const result = await members.prepare({ requesterIdentity, signal: operation.signal,
          rpcContext: { ...member, signal: operation.signal, localActionContext: {
            operationAcceptance: operation.operationAcceptance, operationOwnerUpdate: operation.operationOwnerUpdate,
            operationProgress: operation.operationProgress,
          } } });
        return result.kind === 'ready' ? { ok: true, result: { nativeUid: result.identity.agentUid } }
          : { ok: false, errorCode: 'member_setup_required', error: 'Owner setup required' };
      } });
    let taskId: string | undefined;
    try {
      await vi.waitFor(async () => {
        const rows = await runtime.handlers.listV2({}, owner);
        const setup = rows.items[0]?.domainRef;
        expect(setup).toMatchObject({ kind: 'machineSetup', setupTask: { prompt: { kind: 'sudo.password' } } });
        if (setup?.kind === 'machineSetup') taskId = setup.setupTask?.id;
        expect(taskId).toBeDefined();
      });
      const owned = await runtime.handlers.listV2({}, owner), requested = await runtime.handlers.listV2({}, member);
      expect(owned.items).toHaveLength(1);
      expect(requested.items).toHaveLength(1);
      expect(requested.items[0]).toMatchObject({ actionId: 'projects.script.run', scope: { accountId: 'member' } });
      expect(await runtime.handlers.getV2({ operationId: owned.items[0]!.operationId }, member)).toEqual({ kind: 'not_found' });
      const responseContext = (caller: RpcHandlerContext) => ({ admission: caller.machineAdmission!,
        callerAuthority: caller.callerAuthority, signal: caller.signal, verifyCurrent: caller.verifyMachineAdmissionCurrent! });
      const respond = (caller: RpcHandlerContext) => capabilities.invoke({ id: 'tool.systemTasks', method: 'respond',
        params: { taskId, expectedPromptKind: 'sudo.password', answer: { password: 'one-use-password' },
          responseAuthorization: responseContext(owner) } }, { machineSystemTaskResponse: responseContext(caller) });
      expect(await respond(member)).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
      expect(await respond(manager)).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
      expect(native.mutations).toEqual([]);
      expect(native.launches).toEqual([]);
      expect(await respond(owner)).toMatchObject({ ok: true });
      expect(await original).toMatchObject({ ok: true, result: { nativeUid: 2401 } });
      expect(native.mutations).toContain('agent-account');
      expect(native.launches).toHaveLength(1);
      expect(native.boundaryFailures).toEqual([]);
      expect(JSON.stringify(await tasks.poll({ taskId, cursor: 0 }))).not.toContain('one-use-password');
    } finally {
      ingressLifetime.abort();
      if (taskId) await tasks.cancel({ taskId });
      await original;
    }
  });

  it('includes a dormant retained binding in the real receiver reconnect census without inventing live work', async () => {
    let inventory: ReturnType<typeof createManagedActivityInventory>;
    const native = createAgentIsolationMemberPreparationBoundary({ activeServerDir, requesterIdentity, uid: 2401,
      custodianAccountId: 'custodian', encryptionMode: 'plain', readActivityInventory: () => inventory });
    inventory = createManagedActivityInventory({ producers: [native.runtime.activity] });
    native.installed.add('agent-account');
    await writeAgentIsolationMemberBinding(activeServerDir, observed);
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
        resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
        verifyMachineAdmission: async () => true }) });
    registerMachineAccessLossReceiver(rpc, { serverId: 'saved-profile', machineId: 'machine',
      resolveInstallationId: () => 'installation', readLiveWorkInventory: inventory.read,
      ...{ memberOperations: native.members } });
    try {
      expect(await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
        requestId: 'reconnect-member-census', params: { v: 1, kind: 'requesters' },
        authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
        machineAdmission: { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' } }))
        .toEqual({ kind: 'requesters', accountIds: ['member'], coverage: 'complete' });
      expect(native.mutations).toEqual([]); expect(native.launches).toEqual([]);
    } finally { rpc.cancelTransportRequests(); inventory.dispose(); }
  });

  it('publishes retirement Ask to the real custodian and rejects other responses before withdrawing owned RunAs', async () => {
    let inventory: ReturnType<typeof createManagedActivityInventory>;
    const native = createAgentIsolationMemberPreparationBoundary({ activeServerDir, requesterIdentity, uid: 2401,
      custodianAccountId: 'custodian', encryptionMode: 'plain',
      adminAccess: { version: 1, mode: 'ask', administratorUsername: 'operator' }, readActivityInventory: () => inventory });
    inventory = createManagedActivityInventory({ producers: [native.runtime.activity] });
    native.installed.add('agent-account'); native.installed.add('agent-runas');
    await writeAgentIsolationMemberBinding(activeServerDir, observed);
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
        resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
        // Home's current admission is the network boundary; transport,
        // receiver custody, operation/task ownership and P10 remain real.
        verifyMachineAdmission: async () => true }) });
    registerMachineAccessLossReceiver(rpc, { serverId: 'saved-profile', machineId: 'machine',
      resolveInstallationId: () => 'installation', readLiveWorkInventory: inventory.read,
      ...{ memberOperations: native.members } });
    const context = (actorAccountId: string, role: 'use' | 'manage'): RpcHandlerContext => ({
      signal: new AbortController().signal, callerAuthority: 'present_user', verifyMachineAdmissionCurrent: async () => true,
      machineAdmission: { actorAccountId, custodianAccountId: 'custodian', machineId: 'machine',
        installationId: 'installation', role, encryptionMode: 'plain' } });
    const owner = context('custodian', 'manage'), member = context('member', 'use'), manager = context('manager', 'manage');
    const tasks = getLiveSystemTasksRunnerAdapter();
    const capabilities = createCapabilitiesService({ capabilities: [createSystemTasksCapability(tasks)],
      checklists: { 'new-session': [], 'machine-details': [] }, buildContext: async () => ({ cliSnapshot: null }) });
    const retirement = rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
      requestId: 'ask-retirement', params: { v: 1, subjectAccountId: 'member' },
      authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN, machineAdmission: owner.machineAdmission });
    let taskId: string | undefined;
    try {
      await vi.waitFor(async () => {
        const setup = (await native.runtime.handlers.listV2({}, owner)).items[0]?.domainRef;
        expect(setup).toMatchObject({ kind: 'machineSetup', setupTask: { prompt: { kind: 'sudo.password' } } });
        if (setup?.kind === 'machineSetup') taskId = setup.setupTask?.id;
        expect(taskId).toBeDefined();
      });
      const responseContext = (caller: RpcHandlerContext) => ({ admission: caller.machineAdmission!,
        callerAuthority: caller.callerAuthority, signal: caller.signal, verifyCurrent: caller.verifyMachineAdmissionCurrent! });
      const respond = (caller: RpcHandlerContext) => capabilities.invoke({ id: 'tool.systemTasks', method: 'respond',
        params: { taskId, expectedPromptKind: 'sudo.password', answer: { password: 'one-use-password' },
          responseAuthorization: responseContext(owner) } }, { machineSystemTaskResponse: responseContext(caller) });
      expect(await respond(member)).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
      expect(await respond(manager)).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
      expect(native.mutations).toEqual([]); expect(native.launches).toEqual([]);
      expect(await respond(owner)).toMatchObject({ ok: true });
      // Launch authority is withdrawn even when no resource owner can certify
      // physical cleanup. Inventory quiescence cannot supply that proof.
      expect(await retirement).toEqual({ kind: 'incomplete' });
      expect(native.installed.has('agent-runas')).toBe(false);
      expect(native.installed.has('agent-account')).toBe(true);
      expect(native.mutations).toEqual(['agent-runas-retire']);
      expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir, homeServerIdentityId: 'canonical-home',
        machineId: 'machine', installationId: 'installation' }, 'member')).toMatchObject({ uid: 2401 });
      expect(native.boundaryFailures).toEqual([]);
      expect(JSON.stringify(await tasks.poll({ taskId, cursor: 0 }))).not.toContain('one-use-password');
    } finally {
      rpc.cancelTransportRequests();
      if (taskId) await tasks.cancel({ taskId });
      await retirement; inventory.dispose();
    }
  });

});
