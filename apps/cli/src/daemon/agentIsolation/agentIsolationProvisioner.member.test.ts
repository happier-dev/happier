import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import { machineNativeEffectAdmission, type MachineNativeEffectContext } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { applyAgentIsolationMemberEffects, prepareAgentIsolationEffects, retireAgentIsolationMemberIdentity,
  writeAgentIsolationMemberBinding } from './agentIsolationProvisioner';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from './provisioning';
import { readAgentIsolationMemberLaunchIdentity } from './memberBindings';

const filesystem = vi.hoisted(() => ({ home: '', actual: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    lstat: vi.fn(async (path: Parameters<typeof actual.lstat>[0]) => path === filesystem.home
      ? Object.assign(await actual.lstat(filesystem.actual), { uid: 2401, gid: 2401, mode: 0o40700 }) : actual.lstat(path)),
    realpath: vi.fn(async (path: Parameters<typeof actual.realpath>[0]) => path === filesystem.home ? filesystem.home : actual.realpath(path)),
  };
});

const requesterIdentity: AgentIsolationMemberRequester = { kind: 'isolated', separationRequired: true,
  homeServerIdentityId: 'home-setup', requester: { serverId: 'profile-setup', accountId: 'member-setup', machineId: 'machine-setup', installationId: 'installation-setup' } };
const scope = { homeServerIdentityId: 'home-setup', machineId: 'machine-setup', installationId: 'installation-setup' };
const port = { read: async () => ({ status: 'ready' as const, metadataVersion: 1,
    metadata: { agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } }),
  compareAndSwap: async () => ({ status: 'unavailable' as const }) };

describe.skipIf(process.platform !== 'linux')('member setup and native retirement owner', () => {
  let activeServerDir: string;
  beforeEach(async () => {
    activeServerDir = await mkdtemp(join(tmpdir(), 'happier-member-effects-'));
    filesystem.home = ''; filesystem.actual = activeServerDir;
  });
  afterEach(async () => { await rm(activeServerDir, { recursive: true, force: true }); });
  function fixture(foreign = false, reserved = false) {
    let rulePresent = true, cleanupCalls = 0, current = true;
    const mutations: string[] = [], observations: string[] = [];
    const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
    if (reserved) filesystem.home = identity.home;
    const backend: MachineSetupBackend = {
      async observe(step): ReturnType<MachineSetupBackend['observe']> {
        observations.push(step.id);
        if (step.kind === 'user') return reserved
          ? { stepId: step.id, status: 'satisfied', facts: { present: true, uid: 2401, gid: 2401 } }
          : { stepId: step.id, status: 'drifted', facts: { present: false } };
        if (step.kind === 'file') return { stepId: step.id,
          status: foreign ? 'unavailable' : rulePresent ? 'drifted' : 'satisfied',
          ...(foreign ? { reason: 'foreign_effect_conflict' as const } : {}), facts: { present: rulePresent } };
        return { stepId: step.id, status: 'drifted', facts: { present: false } };
      },
      async apply(step) { mutations.push(step.kind); if (step.kind !== 'file' || step.state !== 'absent'
        || step.path !== `/etc/sudoers.d/91-happier-${identity.username}`) throw new Error('Retirement must affect only the exact managed rule'); rulePresent = false; },
    };
    const native = createAgentIsolationEffectsBoundary({ backend, installationId: scope.installationId,
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async () => {} });
    return { effects: native.effects, mutations, observations, rulePresent: () => rulePresent, cleanupCalls: () => cleanupCalls,
      isCurrentInstallation: () => current,
      waitForNaturalBoundary: async () => ({ kind: 'settled' as const }),
      verifyCurrent: async () => current, invalidate() { current = false; },
      async cleanupOwnedWork() { cleanupCalls++; return { kind: 'settled' as const }; } };
  }
  const admitted = <T,>(effect: (context: MachineNativeEffectContext) => Promise<T>) =>
    machineNativeEffectAdmission.run({ operation: { operationId: 'member-native-operation', kind: 'agentIsolation' }, keys: [{ kind: 'machineSetup' }] }, effect);

  it('withdraws a leftover owned rule even when the managed account is missing, without recreating a user', async () => {
    const native = fixture();
    const result = await admitted(nativeEffectContext => retireAgentIsolationMemberIdentity({
      scope: { ...scope, activeServerDir }, accountId: requesterIdentity.requester.accountId, operationId: 'member-native-operation',
      nativeEffectContext, isCurrentInstallation: native.isCurrentInstallation,
      waitForNaturalBoundary: native.waitForNaturalBoundary, cleanupOwnedWork: native.cleanupOwnedWork,
    }, native.effects));
    expect(result).toEqual({ kind: 'settled' });
    expect(native.rulePresent()).toBe(false);
    expect(native.mutations).toEqual(['file']);
    expect(native.cleanupCalls()).toBe(1);
  });

  it('retains foreign policy, still cleans exact owned work, and reports incomplete', async () => {
    const native = fixture(true);
    const result = await admitted(nativeEffectContext => retireAgentIsolationMemberIdentity({
      scope: { ...scope, activeServerDir }, accountId: requesterIdentity.requester.accountId, operationId: 'member-native-operation',
      nativeEffectContext, isCurrentInstallation: native.isCurrentInstallation,
      waitForNaturalBoundary: native.waitForNaturalBoundary, cleanupOwnedWork: native.cleanupOwnedWork,
    }, native.effects));
    expect(result).toEqual({ kind: 'incomplete' });
    expect(native.rulePresent()).toBe(true);
    expect(native.mutations).toEqual([]);
    expect(native.cleanupCalls()).toBe(1);
  });

  it('does no withdrawal after local installation custody changes while awaiting the natural boundary', async () => {
    const native = fixture();
    const result = await admitted(nativeEffectContext => retireAgentIsolationMemberIdentity({
      scope: { ...scope, activeServerDir }, accountId: requesterIdentity.requester.accountId, operationId: 'member-native-operation',
      nativeEffectContext, isCurrentInstallation: native.isCurrentInstallation,
      waitForNaturalBoundary: async () => { native.invalidate(); return { kind: 'settled' }; },
      cleanupOwnedWork: native.cleanupOwnedWork,
    }, native.effects));
    expect(result).toEqual({ kind: 'incomplete' });
    expect(native.cleanupCalls()).toBe(0);
    expect(native.mutations).toEqual([]);
  });

  it('does not clean trusted work for a stale loss or cancelled delivery', async () => {
    for (const cancelled of [false, true]) {
      const native = fixture();
      const controller = new AbortController();
      if (cancelled) controller.abort();
      else native.invalidate();
      const result = await admitted(nativeEffectContext => retireAgentIsolationMemberIdentity({
        scope: { ...scope, activeServerDir }, accountId: requesterIdentity.requester.accountId,
        operationId: 'member-native-operation', nativeEffectContext, signal: controller.signal,
        isCurrentInstallation: native.isCurrentInstallation, cleanupOwnedWork: native.cleanupOwnedWork,
        waitForNaturalBoundary: native.waitForNaturalBoundary,
      }, native.effects));
      expect(result).toEqual({ kind: 'incomplete' });
      expect(native.cleanupCalls()).toBe(0);
      expect(native.mutations).toEqual([]);
    }
  });

  it('waits for admitted finite work before withdrawing exact RunAs, without another Home admission', async () => {
    const native = fixture(); let homeReads = 0;
    let entered!: () => void, settle!: (value: { kind: 'settled' }) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const boundary = new Promise<{ kind: 'settled' }>(resolve => { settle = resolve; });
    const result = admitted(nativeEffectContext => {
      const input = { scope: { ...scope, activeServerDir }, accountId: requesterIdentity.requester.accountId,
        operationId: 'member-native-operation', nativeEffectContext, isCurrentInstallation: native.isCurrentInstallation,
        verifyCurrent: async () => { homeReads++; return true; },
        waitForNaturalBoundary: () => { entered(); return boundary; }, cleanupOwnedWork: native.cleanupOwnedWork };
      return retireAgentIsolationMemberIdentity(input, native.effects);
    });
    await waiting;
    try { expect(native.observations).toEqual([]); expect(native.mutations).toEqual([]); expect(homeReads).toBe(0); }
    finally { settle({ kind: 'settled' }); await result; }
    expect(await result).toEqual({ kind: 'settled' }); expect(native.mutations).toEqual(['file']); expect(homeReads).toBe(0);
  });

  it('does no native work while the existing lifecycle boundary is incomplete', async () => {
    const native = fixture();
    const result = await admitted(nativeEffectContext => {
      const input = { scope: { ...scope, activeServerDir }, accountId: requesterIdentity.requester.accountId,
        operationId: 'member-native-operation', nativeEffectContext, isCurrentInstallation: native.isCurrentInstallation,
        verifyCurrent: native.verifyCurrent, waitForNaturalBoundary: async () => ({ kind: 'incomplete' as const }),
        cleanupOwnedWork: native.cleanupOwnedWork };
      return retireAgentIsolationMemberIdentity(input, native.effects);
    });
    expect(result).toEqual({ kind: 'incomplete' }); expect(native.observations).toEqual([]); expect(native.mutations).toEqual([]);
  });

  it('retains authored files, reserved UID and private binding for exact regrant', async () => {
    const native = fixture(false, true), identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
    await writeAgentIsolationMemberBinding(activeServerDir, { ...identity, agentUid: 2401, agentGid: 2401 });
    const path = join(activeServerDir, 'agent-isolation', 'members', `${identity.digest}.json`);
    const before = await lstat(path), bytes = await readFile(path, 'utf8');
    const authored = join(activeServerDir, 'authored.txt'); await writeFile(authored, 'retained authored content');
    expect(await admitted(nativeEffectContext => {
      const input = { scope: { ...scope, activeServerDir }, accountId: requesterIdentity.requester.accountId,
        operationId: 'member-native-operation', nativeEffectContext, isCurrentInstallation: native.isCurrentInstallation,
        verifyCurrent: native.verifyCurrent, waitForNaturalBoundary: native.waitForNaturalBoundary,
        cleanupOwnedWork: native.cleanupOwnedWork };
      return retireAgentIsolationMemberIdentity(input, native.effects);
    })).toEqual({ kind: 'settled' });
    expect(native.mutations).toEqual(['file']); expect(native.rulePresent()).toBe(false);
    expect(await readFile(authored, 'utf8')).toBe('retained authored content');
    expect(await readFile(path, 'utf8')).toBe(bytes); expect((await lstat(path)).ino).toBe(before.ino);
    expect(await readAgentIsolationMemberLaunchIdentity({ requesterIdentity, activeServerDir }, native.effects.backend))
      .toMatchObject({ agentUid: 2401, agentGid: 2401, home: identity.home });
  });

  it('withdraws exact managed RunAs after the natural boundary even when resource cleanup remains unproven', async () => {
    const native = fixture(false, true), identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
    await writeAgentIsolationMemberBinding(activeServerDir, { ...identity, agentUid: 2401, agentGid: 2401 });
    const path = join(activeServerDir, 'agent-isolation', 'members', `${identity.digest}.json`);
    const before = await lstat(path), bytes = await readFile(path, 'utf8');
    const authored = join(activeServerDir, 'authored-incomplete.txt'); await writeFile(authored, 'retained authored content');
    let cleanupCalls = 0, rulePresentAtCleanup: boolean | undefined;
    const result = await admitted(nativeEffectContext => {
      const input = { scope: { ...scope, activeServerDir }, accountId: requesterIdentity.requester.accountId,
        operationId: 'member-native-operation', nativeEffectContext, isCurrentInstallation: native.isCurrentInstallation,
        waitForNaturalBoundary: async () => ({ kind: 'settled' as const }),
        cleanupOwnedWork: async () => {
          cleanupCalls++;
          rulePresentAtCleanup = native.rulePresent();
          // No physical cleanup evidence is available. This deliberately
          // remains incomplete; it never fabricates a successful lease cleanup
          // from the lack of tracked PIDs or an empty runtime inventory.
          return { kind: 'incomplete' as const };
        } };
      return retireAgentIsolationMemberIdentity(input, native.effects);
    });
    expect(result).toEqual({ kind: 'incomplete' }); expect(cleanupCalls).toBe(1);
    expect(rulePresentAtCleanup).toBe(false);
    expect(native.rulePresent()).toBe(false); expect(native.mutations).toEqual(['file']);
    expect(await readFile(authored, 'utf8')).toBe('retained authored content');
    expect(await readFile(path, 'utf8')).toBe(bytes); expect((await lstat(path)).ino).toBe(before.ino);
  });

  it('prepares only the admitted member effects and refuses a stale reviewed digest before native mutation', async () => {
    const native = fixture();
    const input = { machineId: scope.machineId, enabled: true, port, status: { kind: 'disabled' as const },
      requesterIdentity, operationId: 'member-native-operation', verifyCurrent: native.verifyCurrent };
    const prepared = await prepareAgentIsolationEffects(input, native.effects);
    expect(prepared?.setupPlan.steps.some(step => step.kind === 'group')).toBe(false);
    expect(prepared?.setupPlan.steps.find(step => step.kind === 'user')).toMatchObject({ supplementaryGroups: [] });
    const result = await admitted(nativeEffectContext => applyAgentIsolationMemberEffects({ ...input, activeServerDir,
      expectedPlanDigest: '0'.repeat(64), nativeEffectContext }, native.effects));
    expect(result).toEqual({ kind: 'not_ready', result: { outcome: 'not_applied', reasonCode: 'plan_stale' } });
    expect(native.mutations).toEqual([]);
  });

  it('does not treat historical enabled policy as owner review of future member creation', async () => {
    const native = fixture();
    const legacyPort = { ...port, read: async () => ({ status: 'ready' as const, metadataVersion: 1,
      metadata: { agentIsolation: { enabled: true } } }) };
    const input = { machineId: scope.machineId, enabled: true, port: legacyPort, status: { kind: 'disabled' as const },
      requesterIdentity, operationId: 'member-native-operation', verifyCurrent: native.verifyCurrent };
    const prepared = await prepareAgentIsolationEffects(input, native.effects);
    expect(prepared).not.toBeNull();
    const result = await admitted(nativeEffectContext => applyAgentIsolationMemberEffects({ ...input, activeServerDir,
      expectedPlanDigest: prepared!.setupPlan.planDigest, nativeEffectContext }, native.effects));
    expect(result).toMatchObject({ kind: 'not_ready', result: { outcome: 'not_applied', reasonCode: 'denied' } });
    expect(native.mutations).toEqual([]);
  });

  it('uses one observed daemon primary group for setup and refuses missing facts without effects', async () => {
    const native = fixture();
    const observed = await native.effects.elevation.observe();
    let observations = 0;
    const daemon = { ...observed, daemonUsername: 'alice', daemonPrimaryGroup: 'engineers' as string | null };
    const effects = { ...native.effects, elevation: { ...native.effects.elevation, observe: async () => { observations++; return daemon; } } };
    const input = { machineId: scope.machineId, enabled: true, port, status: { kind: 'disabled' as const }, requesterIdentity };
    const prepared = await prepareAgentIsolationEffects(input, effects);
    expect(prepared?.setupPlan.steps.find(step => step.id === 'member-workspace')).toMatchObject({ group: 'engineers' });
    expect(prepared?.setupPlan.steps.find(step => step.id === 'member-workspaces')).toMatchObject({ owner: 'alice', group: 'engineers' });
    expect(prepared?.setupPlan.steps.find(step => step.id === 'tools-root')).toMatchObject({ owner: 'alice', group: 'engineers' });
    expect(observations).toBe(1);
    daemon.daemonPrimaryGroup = null;
    expect(await prepareAgentIsolationEffects(input, effects)).toBeNull();
    expect(native.mutations).toEqual([]);
  });

  it('never recreates a missing reserved account before checking its retained binding', async () => {
    const native = fixture();
    await writeAgentIsolationMemberBinding(activeServerDir, { ...deriveAgentIsolationMemberIdentity(requesterIdentity),
      agentUid: 2401, agentGid: 2401 });
    const input = { machineId: scope.machineId, enabled: true, port, status: { kind: 'disabled' as const },
      requesterIdentity, operationId: 'member-native-operation', verifyCurrent: native.verifyCurrent };
    const prepared = await prepareAgentIsolationEffects(input, native.effects);
    expect(prepared).not.toBeNull();
    expect(await admitted(nativeEffectContext => applyAgentIsolationMemberEffects({ ...input, activeServerDir,
      expectedPlanDigest: prepared!.setupPlan.planDigest, nativeEffectContext }, native.effects)))
      .toMatchObject({ kind: 'not_ready' });
    expect(native.mutations).toEqual([]);
  });

  it('commits only a qualified native binding and makes an exact setup retry write nothing', async () => {
    const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
    filesystem.home = identity.home;
    const backend: MachineSetupBackend = {
      observe: async (step): ReturnType<MachineSetupBackend['observe']> => ({ stepId: step.id, status: 'satisfied',
        facts: step.kind === 'user' ? { present: true, uid: 2401, gid: 2401,
          username: identity.username, home: identity.home } : { present: true } }),
      apply: async () => { throw new Error('An already-satisfied setup must not mutate native state'); },
    };
    const { effects } = createAgentIsolationEffectsBoundary({ backend, installationId: scope.installationId,
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
      publishStatus: async () => {} });
    const input = { machineId: scope.machineId, enabled: true, port, status: { kind: 'disabled' as const },
      requesterIdentity, operationId: 'member-native-operation', verifyCurrent: async () => true };
    const prepared = await prepareAgentIsolationEffects(input, effects);
    expect(prepared).not.toBeNull();
    const apply = () => admitted(nativeEffectContext => applyAgentIsolationMemberEffects({ ...input, activeServerDir,
      expectedPlanDigest: prepared!.setupPlan.planDigest, nativeEffectContext }, effects));
    expect(await apply()).toMatchObject({ kind: 'ready', identity: { digest: identity.digest, agentUid: 2401 } });
    const path = join(activeServerDir, 'agent-isolation', 'members', `${identity.digest}.json`);
    const before = await lstat(path);
    expect(await apply()).toMatchObject({ kind: 'ready', identity: { digest: identity.digest, agentUid: 2401 } });
    const after = await lstat(path);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
  });
});
