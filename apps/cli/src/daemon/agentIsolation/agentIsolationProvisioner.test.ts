import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { prepareAgentIsolationEffects, prepareAgentIsolationEffectsResult, resolveAgentIsolationEffectIntent } from './agentIsolationProvisioner';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHostRequesterAgentPlacementForHost } from './agentIsolationLaunchPolicy';
import { buildAgentIsolationMemberRetirementSteps } from './provisioning';
import { createHash } from 'node:crypto';
import { resolveSeparateUserToolsLayout } from '@happier-dev/cli-common/firstPartyRuntime';

afterEach(() => vi.restoreAllMocks());

describe.runIf(process.platform !== 'win32')('isolation provisioning daemon identity', () => {
  it.skipIf(process.platform !== 'linux')('keeps the native missing-ACL repair in the personal setup refusal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-acl-'));
    try {
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const native = createMachineSetupNativeBackend({ run: async ({ executable }) => {
        if (executable === 'getent') return { code: 0, stdout: 'happier-agent:x:41001:41000::/home/agent:/usr/sbin/nologin\n', stderr: '' };
        if (executable === 'getfacl') return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
        throw new Error(`Unexpected native command ${executable}`);
      } });
      // Only OS observations are substituted; native ACL CHECK, intent and isolation projection stay real.
      const boundary = createAgentIsolationEffectsBoundary({ installationId: 'installation',
        installedCli: '/opt/happier/current/happier', readRoots: () => [{ rootId: 'workspace', path: workspace }],
        readSessionsToReplace: () => 0, publishStatus: async () => {}, backend: {
          observe: step => step.kind === 'pathTraversal' ? native.observe(step)
            : Promise.resolve({ stepId: step.id, status: 'satisfied', facts: {} }),
          apply: async () => { throw new Error('Read-only preview must not apply'); },
        } });
      const result = await prepareAgentIsolationEffectsResult({ machineId: 'machine', enabled: true, memberProvisioning: 'linuxUsersV1',
        port: { read: async () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
          compareAndSwap: async () => ({ status: 'unavailable' }) }, status: { kind: 'disabled' } }, boundary.effects);
      expect(result).toMatchObject({ kind: 'unavailable', setup: { outcome: 'not_applied', reasonCode: 'native_check_unavailable',
        failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', requiredFact: 'commandExecutable',
          remedy: 'Install the acl package on this Machine, then try again.' } } });
      expect(boundary.mutations).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['linux', 'darwin', 'win32'] as const)('keeps member preview Linux-only and selects fallback on %s', async platform => {
    const native = createAgentIsolationEffectsBoundary({ installationId: 'installation',
      installedCli: '/opt/happier/current/happier', readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async () => {} });
    const snapshot = { enabled: true, memberProvisioning: 'linuxUsersV1' as const };
    const identity = { kind: 'isolated' as const, separationRequired: true,
      requester: { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' } };
    expect(resolveHostRequesterAgentPlacementForHost({ identity, snapshot, platform })).toBe(platform === 'linux' ? 'member' : 'sharedAgent');
    const preview = await prepareAgentIsolationEffects({ machineId: 'machine', ...snapshot,
      port: { read: async () => ({ status: 'ready' as const, metadataVersion: 1, metadata: {} }),
        compareAndSwap: async () => ({ status: 'unavailable' as const }) }, status: { kind: 'disabled' } }, { ...native.effects, platform });
    expect(preview === null).toBe(platform !== 'linux');
    expect(native.mutations).toEqual([]);
  });
  it('binds future qualified member creation into enable review without creating a roster or changing disable', async () => {
    const native = createAgentIsolationEffectsBoundary({ installationId: 'installation',
      installedCli: '/home/happier/.happier/stack-state/agent-qa/cli/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
      publishStatus: async () => {} });
    const port = { read: async () => ({ status: 'ready' as const, metadataVersion: 1, metadata: {} }),
      compareAndSwap: async () => ({ status: 'unavailable' as const }) };
    const enabled = await prepareAgentIsolationEffects({ machineId: 'machine', enabled: true, memberProvisioning: 'linuxUsersV1',
      port, status: { kind: 'disabled' } }, native.effects);
    expect(enabled?.preview.plan).toMatchObject({ memberProvisioning: 'linuxUsersV1' });
    expect(enabled?.setupPlan.basis).toMatchObject({ kind: 'agentIsolation',
      review: { memberProvisioning: 'linuxUsersV1' } });
    expect(enabled?.setupPlan.steps.some(step => step.kind === 'user' && step.username.startsWith('hpm-'))).toBe(false);
    expect(native.mutations).toEqual([]);
    const historical = await prepareAgentIsolationEffects({ machineId: 'machine', enabled: true,
      port, status: { kind: 'disabled' } }, native.effects);
    expect(historical?.preview.plan).not.toHaveProperty('memberProvisioning');
    expect(historical?.setupPlan.basis).not.toHaveProperty('review.memberProvisioning');
    expect(historical?.setupPlan.planDigest).not.toBe(enabled?.setupPlan.planDigest);
    const disabled = await prepareAgentIsolationEffects({ machineId: 'machine', enabled: false,
      port, status: { kind: 'disabled' } }, native.effects);
    expect(disabled?.preview.plan).not.toHaveProperty('memberProvisioning');
    expect(disabled?.setupPlan.steps).toEqual([]);
    expect(disabled?.setupPlan.planDigest).not.toBe(enabled?.setupPlan.planDigest);
  });

  it('uses the observed existing-user daemon for RunAs, workspace membership and user-manager refresh', async () => {
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(1001);
    const { effects } = createAgentIsolationEffectsBoundary({ installationId: 'installation',
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
      publishStatus: async () => {} });
    const observe = effects.elevation.observe;
    const intent = await resolveAgentIsolationEffectIntent(true, { ...effects, elevation: { ...effects.elevation,
      observe: async () => ({ ...await observe(), daemonUid: 2002, daemonUsername: 'alice', daemonPrimaryGroup: 'engineers' }) } });
    expect(intent).not.toBeNull();
    expect(intent?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'group', name: 'happier-workspace', members: ['alice', 'happier-agent'] }),
      expect.objectContaining({ kind: 'directory', path: '/srv/happier', owner: 'alice' }),
      expect.objectContaining({ kind: 'directory', path: resolveSeparateUserToolsLayout({ machineStateRoot: '/var/lib/happier' }).toolsRoot,
        owner: 'alice', group: 'engineers' }),
    ]));
    const rule = intent?.steps.find(step => step.kind === 'file');
    expect(rule).toMatchObject({ content: { kind: 'literal', value: expect.stringContaining('alice ALL=(happier-agent)') } });
    const refresh = intent?.steps.find(step => step.kind === 'command' && step.executable === 'systemctl');
    expect(refresh).toMatchObject({ args: ['restart', '--', 'user@2002.service'],
      check: { kind: 'userManagerGroups', username: 'alice' } });
    expect(JSON.stringify(intent?.steps)).not.toContain('happier ALL=');
  });

  it('refuses enabling with unknown daemon identity while keeping off ready without native removal', async () => {
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(1001);
    const { effects } = createAgentIsolationEffectsBoundary({ installationId: 'installation',
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
      publishStatus: async () => {} });
    const observe = effects.elevation.observe;
    const unknown = { ...effects, elevation: { ...effects.elevation,
      observe: async () => ({ ...await observe(), daemonUid: null, daemonUsername: null, daemonIdentity: 'unknown' as const }) } };
    expect(await resolveAgentIsolationEffectIntent(true, unknown)).toBeNull();
    expect(await resolveAgentIsolationEffectIntent(false, unknown)).toMatchObject({ steps: [], retirement: expect.arrayContaining([
      expect.objectContaining({ stepId: 'agent-runas', observation: 'unknown', action: 'retain', reasonCode: 'native_check_unavailable' }),
    ]) });
  });

  it('uses the same observed principal for qualified member grants and exact retirement', async () => {
    const { effects } = createAgentIsolationEffectsBoundary({ installationId: 'installation',
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
      publishStatus: async () => {} });
    const requesterIdentity = { kind: 'isolated', separationRequired: true, homeServerIdentityId: 'home',
      requester: { serverId: 'saved-profile', machineId: 'machine', installationId: 'installation', accountId: 'member' } } as const;
    const observe = effects.elevation.observe;
    const alice = { ...effects, elevation: { ...effects.elevation,
      observe: async () => ({ ...await observe(), daemonUsername: 'alice', daemonPrimaryGroup: 'engineers' }) } };
    const intent = await resolveAgentIsolationEffectIntent(true, alice, requesterIdentity);
    const grant = intent?.steps.find(step => step.kind === 'file');
    if (grant?.kind !== 'file' || grant.content?.kind !== 'literal') throw new Error('Expected the canonical member RunAs grant');
    expect(grant.content.value).toContain('alice ALL=(hpm-');
    expect(grant.content.value).not.toContain('happier ALL=');
    expect(intent?.steps.find(step => step.id === 'member-workspace')).toMatchObject({ group: 'engineers' });
    const [retirement] = buildAgentIsolationMemberRetirementSteps({ daemonUsername: 'alice', binaryPath: effects.installedCli, requesterIdentity });
    expect(retirement).toMatchObject({ path: grant.path, state: 'absent',
      expectedContentDigest: createHash('sha256').update(grant.content.value).digest('hex') });
    expect(await resolveAgentIsolationEffectIntent(true, { ...alice, elevation: { ...alice.elevation,
      observe: async () => ({ ...await observe(), daemonUsername: null }) } }, requesterIdentity)).toBeNull();
    const unknownGroup = { ...alice, elevation: { ...alice.elevation,
      observe: async () => ({ ...await observe(), daemonPrimaryGroup: null }) } };
    expect(await resolveAgentIsolationEffectIntent(true, unknownGroup, requesterIdentity)).toBeNull();
    expect(await resolveAgentIsolationEffectIntent(false, unknownGroup)).toMatchObject({ steps: [], retirement: expect.arrayContaining([
      expect.objectContaining({ stepId: 'agent-runas', observation: 'unknown', action: 'retain', reasonCode: 'native_check_unavailable' }),
    ]) });
  });
});
