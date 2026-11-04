import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import type { McpExecutionSource } from './mcpExecutionSource';
import { resolveSessionMcpNativeLaunchMaterial } from './sessionMcpNativeLaunchMaterial';

const native = vi.hoisted(() => ({ missing: false }));
// Public passwd lookup is the OS boundary. Native parsing and placement stay real.
vi.mock('@happier-dev/cli-common/process', async importOriginal => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  execFileWithDeadline: vi.fn(async () => {
    if (native.missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { stdout: 'happier-agent:x:2403:2403::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
  }),
}));

afterEach(() => { native.missing = false; });
const homeServerIdentityId = 'home-server';
const requester = { accountId: 'member-b', machineId: 'machine', installationId: 'installation', serverId: 'profile' };
const source: McpExecutionSource = { kind: 'requester', hostHomeServerIdentityId: homeServerIdentityId,
  identity: { kind: 'isolated', separationRequired: true, requester } };
const runtimeHome = '/var/lib/happier-agent/runtime/operations/session-b';
const input = { source, homeServerIdentityId, isolationEnabled: false,
  launch: { agentIsolationRuntimeHome: runtimeHome } };

describe.skipIf(process.platform !== 'linux')('native Session MCP placement', () => {
  it.each([false, true])('uses the held shared-Agent target for another requester when metadata isolation is %s', async isolationEnabled => {
    await expect(resolveSessionMcpNativeLaunchMaterial({ ...input, isolationEnabled })).resolves.toEqual({
      identity: { agentUid: 2403, agentGid: 2403, home: '/var/lib/happier-agent' },
      target: { runtimeHome },
    });
  });

  it('retains the exact separated member target', async () => {
    const member = { ...deriveAgentIsolationMemberIdentity({ requester, homeServerIdentityId }), agentUid: 2404, agentGid: 2404 };
    const memberRuntime = `${member.home}/runtime/operations/session-b`;
    await expect(resolveSessionMcpNativeLaunchMaterial({ ...input,
      launch: { agentIsolationRuntimeHome: memberRuntime, agentIsolationMemberIdentity: member } })).resolves.toEqual({
      identity: member, target: { runtimeHome: memberRuntime, memberIdentity: member },
    });
    await expect(resolveSessionMcpNativeLaunchMaterial({ ...input,
      source: { ...source, identity: { ...source.identity, kind: 'isolated', requester: { ...requester, accountId: 'other-member' }, separationRequired: true } },
      launch: { agentIsolationRuntimeHome: memberRuntime, agentIsolationMemberIdentity: member } })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });

  it.each(['foreign-home', 'local-user', 'missing-host-home', 'outside-native-home', 'missing-native-user'] as const)(
    'refuses %s without an owner-UID fallback', async kind => {
      native.missing = kind === 'missing-native-user';
      const candidate = { ...input,
        ...(kind === 'foreign-home' ? { homeServerIdentityId: 'other-home' } : {}),
        ...(kind === 'local-user' ? { source: { kind: 'local_user' as const } } : {}),
        ...(kind === 'missing-host-home' ? { source: { ...source, hostHomeServerIdentityId: undefined } } : {}),
        ...(kind === 'outside-native-home' ? { launch: { agentIsolationRuntimeHome: '/home/owner/private' } } : {}),
      };
      await expect(resolveSessionMcpNativeLaunchMaterial(candidate)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    });

  it('does not manufacture native placement without a held target', async () => {
    await expect(resolveSessionMcpNativeLaunchMaterial({ ...input, launch: undefined })).resolves.toBeNull();
    await expect(resolveSessionMcpNativeLaunchMaterial({ ...input, launch: undefined, isolationEnabled: true }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });
});
