import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import type { McpExecutionSource } from './mcpExecutionSource';
import { resolveSessionMcpNativeLaunchMaterial } from './sessionMcpNativeLaunchMaterial';
import { prepareDaemonConnectedServices } from '@/daemon/spawn/prepareDaemonConnectedServices';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { RunnerDaemonPluginServiceOperationV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import type { ApiClient } from '@/api/api';

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
      identity: { home: member.home, agentUid: member.agentUid, agentGid: member.agentGid },
      target: { runtimeHome: memberRuntime, memberIdentity: member },
    });
    await expect(resolveSessionMcpNativeLaunchMaterial({ ...input,
      source: { ...source, identity: { ...source.identity, kind: 'isolated', requester: { ...requester, accountId: 'other-member' }, separationRequired: true } },
      launch: { agentIsolationRuntimeHome: memberRuntime, agentIsolationMemberIdentity: member } })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });

  it('passes isolated Use-member MCP material for a brokered Team model through the strict runner consumer without a local login', async () => {
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    let cleanup: (() => void | Promise<void>) | undefined;
    try {
      const member = { ...deriveAgentIsolationMemberIdentity({ requester, homeServerIdentityId }), agentUid: 2404, agentGid: 2404 };
      // Admission already selected this native member. No local Account login
      // or connected-service secret may be acquired for the brokered model.
      const api = new Proxy({} as ApiClient, { get() { throw new Error('Brokered member launch must not acquire local credentials'); } });
      const prepared = await prepareDaemonConnectedServices({
        options: { directory: member.workspaceRoot, requesterWorkAttributionV1: requester,
          modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null, modelId: 'gpt-5.6-luna' } },
          teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'team-model',
            teamId: 'team', expectedResourceRevision: 1, deliveryMode: 'brokered' }] },
        preparedAgentIsolationIdentity: { memberIdentity: member, nativeIdentity: member },
        normalizedExistingSessionId: '', requestedSessionId: 'session-b', effectiveResume: '', catalogAgentId: 'codex',
        credentials: { token: 'synthetic-requester', encryption: null }, api,
        activeServerDir: `${runtime.happyHomeDir}/server`,
        connectedServicesMaterializationBaseDir: `${runtime.happyHomeDir}/materialized`, connectedServiceRefreshCoordinator: null,
        processEnv: {}, pluginRuntimeRegistry: runtime.registry,
      });
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) throw new Error('Brokered member preparation refused');
      cleanup = prepared.auth?.cleanupOnExit ?? undefined;
      const material = prepared.agentLaunchMaterials;
      if (!material) throw new Error('Member native material unavailable');
      const resolved = await resolveSessionMcpNativeLaunchMaterial({ ...input,
        launch: { agentIsolationRuntimeHome: material.runtimeHome, agentIsolationMemberIdentity: material.memberIdentity } });
      if (!resolved?.target) throw new Error('Native MCP target unavailable');
      // The real placement producer's values enter the same private operation
      // envelope as native Session and stdio MCP launch preparation.
      const mcpLaunchMaterial = { ...resolved.target, nativeIdentity: resolved.identity,
        environment: material.environment, selectedMaterials: material.selectedMaterials };
      expect(mcpLaunchMaterial.memberIdentity).toEqual(member);
      for (const operation of [{
        kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec',
        launch: { command: '/native/agent', args: [], env: {} },
      }, {
        kind: 'plugin_exec.launch.authorize_v1', agentNativeLaunch: true,
        request: { executable: { kind: 'systemTool', id: 'native-agent' }, args: [] },
      }]) expect(RunnerDaemonPluginServiceOperationV1Schema.parse({
        ...operation, requestId: 'mcp-material', invocationId: 'member-team', mcpLaunchMaterial,
      })).toMatchObject({ mcpLaunchMaterial });
    } finally { await cleanup?.(); await runtime.dispose(); }
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
