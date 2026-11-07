import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDaemonAgentIsolationIdentity } from './prepareDaemonAgentIsolationIdentity';
import { deriveAgentIsolationMemberIdentity } from '../agentIsolation/provisioning';
import { readAgentIsolationNativeIdentity } from '../agentIsolation/agentIsolationNativeIdentity';
import { createSessionAgentIsolationMemberPreparation } from '../agentIsolation/sessionPreparation';
import { ApiMachineClient } from '@/api/apiMachine';
import { createAgentIsolationMemberPreparationBoundary } from '../agentIsolation/agentIsolationEffects.testkit';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SessionSpawnNewActionResultV1Schema, projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { observeAgentIsolationMemberLaunchReadiness } from '../agentIsolation/agentIsolationReadiness';
import { admitAgentIsolationLaunchForHost } from '../agentIsolation/agentIsolationLaunchPolicy';

const nativeHomes = vi.hoisted(() => new Map<string, Readonly<{ backingDirectory: string; uid: number; gid: number }>>());
// Only native passwd/home metadata is simulated. Native identity observation,
// canonical requester selection and payload placement execute their real owners.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      const home = nativeHomes.get(String(path));
      return home ? Object.assign(await actual.lstat(home.backingDirectory), { uid: home.uid, gid: home.gid, mode: 0o40700 }) : actual.lstat(path);
    },
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => nativeHomes.has(String(path)) ? String(path) : actual.realpath(path),
  };
});
vi.mock('@happier-dev/cli-common/process', async original => {
  const actual = await original<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => args[0] === 'getent' && args[1]?.at(-1) === 'happier-agent'
    ? { stdout: 'happier-agent:x:2403:2403::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' }
    : actual.execFileWithDeadline(...args) };
});
afterEach(() => { nativeHomes.clear(); vi.restoreAllMocks(); });

function sharedPreparation(birth = { serverId: 'canonical-home', accountId: 'owner', machineId: 'machine', installationId: 'installation' }) {
  return createSessionAgentIsolationMemberPreparation({ machineId: 'machine', custodianAccountId: 'owner',
    agentIsolation: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }) },
    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: 'canonical-home' }),
  })({ bootstrap: { attribution: birth, homeServerIdentityId: 'canonical-home', savedSecretOperationContext: { machineAdmission: null } } }, new AbortController().signal);
}

describe.skipIf(process.platform !== 'linux')('managed cwd native identity preparation', () => {
  it('retains the native cause when execution admission consumes an unavailable probe status', async () => {
    const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'canonical-home',
      requester: { serverId: 'saved-profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } }),
      agentUid: 2401, agentGid: 2401 };
    const status = await observeAgentIsolationMemberLaunchReadiness({ installedCli: '/opt/happier/current/happier', memberIdentity,
      system: { run: async () => { throw Object.assign(new Error('PRIVATE_NATIVE_STDERR'), { code: 71 }); } } });
    if (status.kind !== 'unavailable') throw new Error('Expected failed native readiness');
    await expect(admitAgentIsolationLaunchForHost({ context: { read: () => ({ enabled: true, status, workspaceRoots: [] }) },
      cwd: memberIdentity.home, agentNativeLaunch: true })).rejects.toMatchObject({ data: { details: {
        reason: 'launch_probe_failed', probeFailure: { check: 'uid', exitCode: 71,
          identity: { username: memberIdentity.username, uid: 2401, gid: 2401, home: memberIdentity.home, cwd: memberIdentity.home } },
      } } });
  });
  it('keeps a failed native launch probe distinct from missing setup after member setup succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'member-probe-refusal-'));
    const birth = { serverId: 'saved-home-profile', accountId: 'member', machineId: 'machine', installationId: 'installation' };
    const requesterIdentity = { kind: 'isolated' as const, requester: birth, separationRequired: true, homeServerIdentityId: 'canonical-home' };
    const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
    const client = new ApiMachineClient('token', { id: 'machine', encryptionMode: 'plain', metadataVersion: 1,
      daemonStateVersion: 1, metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3',
        homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' }, daemonState: { status: 'running' } });
    try {
      await mkdir(join(root, 'server'), { mode: 0o700 });
      nativeHomes.set(identity.home, { backingDirectory: join(root, 'server'), uid: 2401, gid: 2401 });
      const native = createAgentIsolationMemberPreparationBoundary({ activeServerDir: join(root, 'server'), requesterIdentity,
        custodianAccountId: 'owner', encryptionMode: 'plain', uid: 2401 });
      // The OS process is the boundary: native setup, bindings, readiness and
      // Session transport all execute their real owners beneath it.
      native.effects.nativeReadiness!.system!.run = async () => {
        throw Object.assign(new Error('PRIVATE_NATIVE_STDERR'), { code: 71, stderr: 'PRIVATE_NATIVE_STDERR' });
      };
      Reflect.set(client, 'agentIsolationMemberOperations', native.members);
      const prepared = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
        requesterWorkAttributionV1: birth,
        prepareAgentIsolationMember: async () => ({ kind: 'member', requesterIdentity, snapshot: undefined, ...await client.prepareAgentIsolationMember({ requesterIdentity }) }),
      });
      expect(native.runtime.store.get({ accountId: 'owner', machineId: 'machine' }, 'member-setup-1'))
        .toMatchObject({ state: 'succeeded', result: { kind: 'ready' } });
      if (prepared.ok) throw new Error('Expected native probe refusal after successful setup');
      const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(prepared.result));
      const result = SessionSpawnNewActionResultV1Schema.parse(projectSessionSpawnNewActionResultV1(projectSessionSpawnFailure({
        errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
      })));
      expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', launchError: {
        agentIsolationRefusal: { reason: 'launch_probe_failed', phase: 'native_execution_preparation', readinessCode: 'launch_probe_failed' },
      } });
      if (result.type !== 'error' || result.code !== 'spawn_failed') throw new Error('Expected launch failure');
      expect(result.launchError?.agentIsolationRefusal).toMatchObject({ probeFailure: {
        check: 'uid', exitCode: 71,
        identity: { username: identity.username, uid: 2401, gid: 2401, home: identity.home, cwd: identity.home },
      } });
      expect(result.launchError?.agentIsolationRefusal?.remedy).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_NATIVE_STDERR');
    } finally { await client.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(['member', 'shared'] as const)('selects the admitted %s workspace before managed cwd allocation', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'managed-cwd-admission-'));
    try {
      await mkdir(join(root, 'server'), { mode: 0o700 });
      const birth = { serverId: 'saved-home-profile', accountId: kind === 'member' ? 'member' : 'owner', machineId: 'machine', installationId: 'installation' };
      const requesterIdentity = { kind: 'isolated' as const, requester: birth, separationRequired: true, homeServerIdentityId: 'canonical-home' };
      const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
      nativeHomes.set(identity.home, { backingDirectory: join(root, 'server'), uid: 2401, gid: 2401 });
      const prepared = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
        requesterWorkAttributionV1: birth,
        managedDirectory: { directory: join(root, 'server', 'session-directories', 'placeholder'), workspaceRoots: [root] },
        prepareAgentIsolationMember: kind === 'member' ? async input => {
          return { kind: 'member', requesterIdentity, snapshot: undefined, identity: await readAgentIsolationNativeIdentity({ requesterIdentity, signal: input.signal }, {
            observe: async step => ({ stepId: step.id, status: 'satisfied', facts: { uid: 2401, gid: 2401 } }),
          }) };
        } : sharedPreparation(birth),
      });
      expect(prepared).toMatchObject({ ok: true, payloadPlacement: {
        root: kind === 'member' ? deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'canonical-home', requester: birth }).workspaceRoot : root,
        agentUid: kind === 'member' ? 2401 : 2403,
      } });
      if (!prepared.ok) throw new Error('Managed cwd admission refused');
      if (kind === 'member') expect(prepared.memberIdentity).toBe(prepared.nativeIdentity);
    } finally { nativeHomes.clear(); await rm(root, { recursive: true, force: true }); }
  });

  it('refuses ambiguous shared managed placement before creating daemon-private payloads', async () => {
    const result = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
      prepareAgentIsolationMember: sharedPreparation(),
      managedDirectory: { directory: '/daemon/private/placeholder', workspaceRoots: ['/accepted/a', '/accepted/b'] },
    });
    expect(result).toMatchObject({ ok: false, result: { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorDetail: { kind: 'launch_error', code: 'agent_isolation_unavailable' } } });
  });

  it('selects the unique accepted containing workspace for shared managed placement', async () => {
    const result = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
      prepareAgentIsolationMember: sharedPreparation(),
      managedDirectory: { directory: '/accepted/b/work', workspaceRoots: ['/accepted/a', '/accepted/b'] },
    });
    expect(result).toMatchObject({ ok: true, payloadPlacement: { root: '/accepted/b', agentUid: 2403 } });
  });

  it('honors an explicit accepted root when accepted workspaces are nested', async () => {
    const result = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
      prepareAgentIsolationMember: sharedPreparation(),
      managedDirectory: { directory: '/accepted/project', workspaceRoots: ['/accepted', '/accepted/project'] },
    });
    expect(result).toMatchObject({ ok: true, payloadPlacement: { root: '/accepted/project', agentUid: 2403 } });
  });

});
