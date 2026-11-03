import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationSetResultV1Schema } from '@happier-dev/protocol';
import type { MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { registerDaemonMachineAgentIsolationRpcHandlers } from './daemonMachineAgentIsolation';

// Native state is the OS boundary; preview, Manage admission, field mutation,
// operation ownership, elevation framing and CHECK/APPLY remain production code.
function fixture(foreignRule = false, adminMode: 'preauthorized' | 'none' = 'preauthorized') {
  const target = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
  const residue = new Set(['agent-runas', 'agent-account', 'agent-primary-group', 'agent-home', 'workspace-group',
    'workspace-root', 'tools-root', 'happier-shared-git', 'happier-agent-shared-git']);
  const backend: MachineSetupBackend = {
    async observe(step) {
      const present = residue.has(step.id);
      if (step.kind === 'file') {
        const safe = !foreignRule;
        return { stepId: step.id, status: step.state === 'absent'
          ? !present ? 'satisfied' : safe ? 'drifted' : 'unavailable'
          : present && safe ? 'satisfied' : present ? 'unavailable' : 'drifted',
          ...(present && !safe ? { reason: 'foreign_effect_conflict' } : {}),
          facts: { present, ...(present ? { kind: 'file' } : {}), ...(present ? { uid: 0, gid: 0, mode: 0o440,
            contentDigest: step.content?.kind === 'literal' ? createHash('sha256').update(step.content.value).digest('hex') : step.expectedContentDigest } : {}) } };
      }
      return { stepId: step.id, status: present ? 'satisfied' : 'drifted', facts: { present } };
    },
    async apply(step) {
      if (step.kind !== 'file' || step.state !== 'absent' || foreignRule) throw new Error('Only the reviewed managed rule may be removed');
      residue.delete(step.id);
    },
  };
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId, backend, adminAccess: { version: 1, mode: adminMode },
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
    publishStatus: async () => {} });
  let operation = 0;
  const operations = createHostActionOperationRuntime({ serverId: target.serverId, machineId: target.machineId,
    resolveAccountId: async () => 'owner', generateOperationId: () => `retirement-operation-${++operation}` });
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
    verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: target.machineId,
      installationId: target.installationId, role: 'manage', encryptionMode: 'plain' } };
  const rpc = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
    encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
  registerDaemonMachineAgentIsolationRpcHandlers(rpc, { target: () => target,
    read: () => ({ enabled: false, status: { kind: 'disabled' } }), effects: { ...native.effects, backend: undefined },
    readCanonicalHomeServerIdentityId: () => 'home', runActionOperation: operations.runActionOperation,
    captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion: 4,
      metadata: { agentIsolation: { enabled: false } } }),
      compareAndSwap: async () => { throw new Error('Already-off retirement must not rewrite policy'); } }) });
  const preview = async () => MachineAgentIsolationPreviewResultV1Schema.parse(await rpc.invokeLocal('machines.agentIsolation.preview',
    { machineId: target.machineId, enabled: false }, { rpcContext: context,
      localActionContext: { actionRequestId: 'retirement-preview' } }));
  const apply = async (review: Awaited<ReturnType<typeof preview>>, role: 'manage' | 'use' = 'manage') => {
    if (review.kind !== 'ready') throw new Error('Expected ready retirement review');
    return MachineAgentIsolationSetResultV1Schema.parse(await rpc.invokeLocal('machines.agentIsolation.set',
      { machineId: target.machineId, enabled: false, expectedPolicy: review.policy,
        expectedMetadataVersion: review.metadataVersion, expectedPlanDigest: review.plan.planDigest },
      { rpcContext: { ...context, machineAdmission: { ...context.machineAdmission!, role } },
        localActionContext: { actionRequestId: `retirement-${role}` } }));
  };
  return { ...native, residue, preview, apply };
}

it('reviews and retires bootstrap residue even while enabled:false, retaining unowned identities and authored data with remedies', async () => {
  const f = fixture();
  const review = await f.preview();
  expect(review).toMatchObject({ kind: 'ready', policy: { enabled: false }, plan: { requiresAdmin: true,
    retirement: expect.arrayContaining([
      expect.objectContaining({ stepId: 'agent-runas', target: '/etc/sudoers.d/91-happier-agent', action: 'remove' }),
      expect.objectContaining({ stepId: 'agent-account', action: 'retain', reasonCode: 'ownership_unproven', remedy: expect.any(String) }),
      expect.objectContaining({ stepId: 'agent-primary-group', action: 'retain', remedy: expect.any(String) }),
      expect.objectContaining({ stepId: 'agent-home', action: 'retain', reasonCode: 'authored_data', remedy: expect.any(String) }),
      expect.objectContaining({ stepId: 'workspace-group', action: 'retain', remedy: expect.any(String) }),
      expect.objectContaining({ stepId: 'workspace-root', action: 'retain', remedy: expect.any(String) }),
      expect.objectContaining({ stepId: 'tools-root', action: 'retain', reasonCode: 'shared_resource', remedy: expect.any(String) }),
      expect.objectContaining({ stepId: 'happier-shared-git', action: 'retain', remedy: expect.any(String) }),
    ]) } });
  expect(f.mutations).toEqual([]);
  await expect(f.apply(review, 'use')).rejects.toThrow();
  expect(f.mutations).toEqual([]);
  expect(await f.apply(review)).toMatchObject({ kind: 'accepted', status: { kind: 'disabled' },
    retirement: { removed: ['agent-runas'], retained: expect.arrayContaining([expect.objectContaining({ stepId: 'agent-account' })]) } });
  expect(f.residue.has('agent-runas')).toBe(false);
  expect(f.residue.has('agent-home')).toBe(true);
  expect(f.mutations).toEqual(['agent-runas']);
  expect(f.launches.some(launch => launch.executable === 'sudo')).toBe(true);
  expect(await f.preview()).toMatchObject({ kind: 'ready', plan: { requiresAdmin: false,
    retirement: expect.arrayContaining([expect.objectContaining({ stepId: 'agent-runas', observation: 'absent', action: 'none' })]) } });
});

it('leaves a changed or foreign sudoers rule untouched and returns its typed administrator remedy', async () => {
  const f = fixture(true);
  const review = await f.preview();
  expect(review).toMatchObject({ kind: 'ready', plan: { requiresAdmin: false,
    retirement: expect.arrayContaining([expect.objectContaining({ stepId: 'agent-runas', action: 'retain',
      reasonCode: 'foreign_effect_conflict', remedy: expect.any(String) })]) } });
  expect(await f.apply(review)).toMatchObject({ kind: 'unchanged', retirement: { removed: [],
    retained: expect.arrayContaining([expect.objectContaining({ stepId: 'agent-runas', reasonCode: 'foreign_effect_conflict' })]) } });
  expect(f.residue.has('agent-runas')).toBe(true);
  expect(f.mutations).toEqual([]);
});


it('reports the existing administrator recovery when off inventory cannot be inspected, without claiming no residue', async () => {
  const f = fixture(false, 'none');
  expect(await f.preview()).toMatchObject({ kind: 'unavailable', setup: { outcome: 'not_applied',
    recovery: { kind: 'configure_admin_access', mode: 'preauthorized' } } });
  expect(f.residue.has('agent-runas')).toBe(true);
  expect(f.mutations).toEqual([]);
});
