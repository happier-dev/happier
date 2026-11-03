import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDaemonAgentIsolationIdentity } from './prepareDaemonAgentIsolationIdentity';
import { deriveAgentIsolationMemberIdentity } from '../agentIsolation/provisioning';
import { readAgentIsolationNativeIdentity } from '../agentIsolation/agentIsolationNativeIdentity';
import { createSessionAgentIsolationMemberPreparation } from '../agentIsolation/sessionPreparation';

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

describe.skipIf(process.platform !== 'linux')('managed cwd native identity preparation', () => {
  it.each(['member', 'shared'] as const)('selects the admitted %s workspace before managed cwd allocation', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'managed-cwd-admission-'));
    try {
      await mkdir(join(root, 'server'), { mode: 0o700 });
      const birth = { serverId: 'saved-home-profile', accountId: kind === 'member' ? 'member' : 'owner', machineId: 'machine', installationId: 'installation' };
      const requesterIdentity = { kind: 'isolated' as const, requester: birth, separationRequired: true, homeServerIdentityId: 'canonical-home' };
      const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
      nativeHomes.set(identity.home, { backingDirectory: join(root, 'server'), uid: 2401, gid: 2401 });
      const prepared = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
        requesterWorkAttributionV1: birth, readAgentIsolationEnabled: () => true,
        managedDirectory: { directory: join(root, 'server', 'session-directories', 'placeholder'), workspaceRoots: [root] },
        prepareAgentIsolationMember: kind === 'member' ? async input => {
          return await readAgentIsolationNativeIdentity({ requesterIdentity, signal: input.signal }, {
            observe: async step => ({ stepId: step.id, status: 'satisfied', facts: { uid: 2401, gid: 2401 } }),
          });
        } : createSessionAgentIsolationMemberPreparation({ machineId: 'machine', custodianAccountId: 'owner' })(null, new AbortController().signal),
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
    const result = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true, readAgentIsolationEnabled: () => true,
      prepareAgentIsolationMember: createSessionAgentIsolationMemberPreparation({ machineId: 'machine', custodianAccountId: 'owner' })(null, new AbortController().signal),
      managedDirectory: { directory: '/daemon/private/placeholder', workspaceRoots: ['/accepted/a', '/accepted/b'] },
    });
    expect(result).toMatchObject({ ok: false, result: { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorDetail: { kind: 'launch_error', code: 'agent_isolation_unavailable' } } });
  });

  it('selects the unique accepted containing workspace for shared managed placement', async () => {
    const result = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true, readAgentIsolationEnabled: () => true,
      prepareAgentIsolationMember: createSessionAgentIsolationMemberPreparation({ machineId: 'machine', custodianAccountId: 'owner' })(null, new AbortController().signal),
      managedDirectory: { directory: '/accepted/b/work', workspaceRoots: ['/accepted/a', '/accepted/b'] },
    });
    expect(result).toMatchObject({ ok: true, payloadPlacement: { root: '/accepted/b', agentUid: 2403 } });
  });

  it('honors an explicit accepted root when accepted workspaces are nested', async () => {
    const result = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true, readAgentIsolationEnabled: () => true,
      prepareAgentIsolationMember: createSessionAgentIsolationMemberPreparation({ machineId: 'machine', custodianAccountId: 'owner' })(null, new AbortController().signal),
      managedDirectory: { directory: '/accepted/project', workspaceRoots: ['/accepted', '/accepted/project'] },
    });
    expect(result).toMatchObject({ ok: true, payloadPlacement: { root: '/accepted/project', agentUid: 2403 } });
  });

});
