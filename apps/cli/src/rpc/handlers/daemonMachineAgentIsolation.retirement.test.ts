import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationSetResultV1Schema } from '@happier-dev/protocol';
import type { MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { registerDaemonMachineAgentIsolationRpcHandlers } from './daemonMachineAgentIsolation';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';

// Native state is the OS boundary; preview, Manage admission, field mutation,
// operation ownership, elevation framing and CHECK/APPLY remain production code.
function fixture(foreignRule = false, adminMode: 'preauthorized' | 'none' = 'preauthorized',
  failure?: 'sudo' | 'identity' | 'identity-error', initiallyEnabled = false, activeServerDir?: string, memberRuleId?: string) {
  const target = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
  const residue = new Set(['agent-runas', 'agent-account', 'agent-primary-group', 'agent-home', 'workspace-group',
    'workspace-root', 'tools-root', 'happier-shared-git', 'happier-agent-shared-git']);
  if (memberRuleId) residue.add(memberRuleId);
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
  const elevation = { ...native.effects.elevation,
    ...(failure === 'sudo' ? { spawn: () => { throw new Error('sudo unavailable'); } } : {}),
    observe: async () => {
      if (failure === 'identity-error') throw new Error('identity unreadable');
      const observation = await native.effects.elevation.observe();
      return failure === 'identity' ? { ...observation, daemonUid: null, daemonUsername: null, daemonPrimaryGroup: null } : observation;
    } };
  let metadata: Record<string, unknown> = { agentIsolation: { enabled: initiallyEnabled } };
  let metadataVersion = 4;
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
    read: () => ({ enabled: false, status: { kind: 'disabled' } }), effects: { ...native.effects, backend: undefined, elevation,
      readMemberBindingScope: () => activeServerDir ? { activeServerDir, homeServerIdentityId: 'home', machineId: target.machineId,
        installationId: target.installationId } : null },
    readCanonicalHomeServerIdentityId: () => 'home', runActionOperation: operations.runActionOperation,
    captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion, metadata }),
      compareAndSwap: async input => {
        if (!initiallyEnabled) throw new Error('Already-off retirement must not rewrite policy');
        if (input.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
        metadata = input.metadata;
        return { status: 'applied', metadata, metadataVersion: ++metadataVersion };
      } }) });
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

it.each(['preauthorized', 'none'] as const)('includes retained member rules in off review without making elevation a prerequisite (%s)', async adminMode => {
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-member-retirement-'));
  try {
    const member = deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home',
      requester: { serverId: 'home', accountId: 'revoked-member', machineId: 'machine', installationId: 'installation' } });
    await writeAgentIsolationMemberBinding(activeServerDir, { ...member, agentUid: 2401, agentGid: 2401 });
    const ruleId = `member-runas-${member.digest}`;
    const f = fixture(false, adminMode, undefined, true, activeServerDir, ruleId);
    const review = await f.preview();
    expect(review).toMatchObject({ kind: 'ready', plan: { retirement: expect.arrayContaining([
      expect.objectContaining({ stepId: ruleId, target: `/etc/sudoers.d/91-happier-${member.username}`,
        action: adminMode === 'none' ? 'retain' : 'remove' }),
    ]) } });
    expect(await f.apply(review)).toMatchObject({ kind: 'accepted', status: { kind: 'disabled' } });
    expect(f.residue.has(ruleId)).toBe(adminMode === 'none');
  } finally { await rm(activeServerDir, { recursive: true, force: true }); }
});


it.each([
  { adminMode: 'none', failure: undefined },
  { adminMode: 'preauthorized', failure: 'sudo' },
  { adminMode: 'preauthorized', failure: 'identity' },
  { adminMode: 'preauthorized', failure: 'identity-error' },
] as const)('keeps off ready and retains uninspected residue with $adminMode/$failure', async ({ adminMode, failure }) => {
  const f = fixture(false, adminMode, failure, true);
  const review = await f.preview();
  expect(review).toMatchObject({ kind: 'ready', policy: { enabled: true }, plan: { requiresAdmin: false } });
  if (review.kind !== 'ready') throw new Error('Expected ready off recovery');
  expect(review.plan.retirement?.map(item => item.stepId)).toEqual(expect.arrayContaining([
    'agent-runas', 'agent-account', 'agent-primary-group', 'agent-home', 'workspace-group', 'workspace-root', 'tools-root',
  ]));
  for (const item of review.plan.retirement ?? []) expect(item).toMatchObject({ observation: 'unknown', action: 'retain',
    reasonCode: 'native_check_unavailable', remedy: expect.any(String) });
  expect(await f.apply(review)).toMatchObject({ kind: 'accepted',
    status: { kind: 'disabled' }, retirement: { removed: [], retained: review.plan.retirement } });
  expect(await f.preview()).toMatchObject({ kind: 'ready', policy: { enabled: false } });
  expect(f.residue.has('agent-runas')).toBe(true);
  expect(f.mutations).toEqual([]);
});
