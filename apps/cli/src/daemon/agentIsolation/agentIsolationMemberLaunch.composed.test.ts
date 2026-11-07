import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { materializeQualifiedConnectedAccountLaunchUses } from '@/daemon/connectedServices/materialize/materializeQualifiedConnectedAccountLaunchUses';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { prepareAgentIsolationEffects, applyAgentIsolationMemberEffects } from './agentIsolationProvisioner';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from './provisioning';
import { createAgentIsolationSessionContext } from './agentIsolationSessionContext';
import { readAgentLaunchFrame } from './agentLaunchFrame';
import type { AgentLaunchMaterialization } from './agentLaunchMaterials';
import { PLUGIN_MANIFEST as CODEX_MANIFEST } from '@happier-dev/plugins-codex/manifest';

const os = vi.hoisted(() => ({ actual: '', homes: new Map<string, number>(), workspaces: new Set<string>() }));
// OS metadata/commands are the only substituted boundaries. Setup interpretation,
// bindings, selected-material production, Session context and Exec stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      const uid = os.homes.get(String(path));
      return uid === undefined ? actual.lstat(path)
        : Object.assign(await actual.lstat(os.actual), { uid, gid: uid, mode: 0o40700 });
    },
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => os.homes.has(String(path)) || os.workspaces.has(String(path))
      ? String(path) : actual.realpath(path),
  };
});
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (args[0] === 'getent' && args[1]?.at(-1) === 'happier-agent') {
      return { stdout: 'happier-agent:x:999:999::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
    }
    return actual.execFileWithDeadline(...args);
  } };
});

describe.skipIf(process.platform !== 'linux')('member setup → selected material → Session → Exec composition', () => {
  let activeServerDir: string;
  beforeEach(async () => {
    activeServerDir = await mkdtemp(join(tmpdir(), 'happier-member-composed-'));
    os.actual = activeServerDir;
    os.homes.clear();
    os.workspaces.clear();
  });
  afterEach(async () => { await rm(activeServerDir, { recursive: true, force: true }); });

  it('preserves the owner launch tuple with isolation disabled', async () => {
    const launch = await authorizeResolvedProjectExecLaunchForHost({
      launch: { command: '/bin/cat', args: [], cwd: activeServerDir, env: { OWNER_VALUE: 'kept' }, release() {} },
      signal: new AbortController().signal, assertCurrent() {}, agentNativeLaunch: true,
      agentIsolation: createAgentIsolationSessionContext({
        machine: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
        managedHappierBinaryPath: '/opt/happier/cli/current/happier',
        sessionRequester: { serverId: 'saved-profile', accountId: 'owner', machineId: 'machine', installationId: 'installation' },
        sessionRequesterHomeServerIdentityId: 'canonical-home', hostHomeServerIdentityId: 'canonical-home',
        sessionCustodianAccountId: 'owner', readMaterial: () => undefined,
      }),
    });
    try {
      expect(launch.command).toBe('/bin/cat');
      expect(launch.env).toEqual({ OWNER_VALUE: 'kept' });
    } finally { await launch.release(); }
  });

  it('carries the owner and members through the same provisioner and Provider handoff with separate RunAs and private material', async () => {
    const transport = await prepareSessionMcpLocalTransport({ agentUid: process.getuid!() });
    try {
      const usernames: string[] = [];
      const members: Array<{ requester: AgentIsolationMemberRequester; material: AgentLaunchMaterialization }> = [];
      for (const [index, accountId] of ['member-a', 'member-b', 'owner'].entries()) {
        const requester: AgentIsolationMemberRequester = {
          kind: 'isolated', separationRequired: accountId !== 'owner', homeServerIdentityId: 'canonical-home',
          requester: { serverId: 'saved-profile', accountId, machineId: 'machine', installationId: 'installation' },
        };
        const expected = deriveAgentIsolationMemberIdentity(requester);
        const uid = 2401 + index;
        os.homes.set(expected.home, uid);
        os.workspaces.add(expected.workspaceRoot);
        const { effects } = createAgentIsolationEffectsBoundary({
          installationId: 'installation', installedCli: '/opt/happier/cli/current/happier',
          readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async () => {},
          backend: {
            observe: async step => ({ stepId: step.id, status: 'satisfied',
              facts: step.kind === 'user' ? { present: true, uid, gid: uid } : { present: true } }),
            apply: async () => { throw new Error('Already provisioned accounts must not be recreated'); },
          },
        });
        const signal = new AbortController().signal;
        const input = { machineId: 'machine', requesterIdentity: requester, operationId: `setup-${accountId}`,
          activeServerDir, signal, verifyCurrent: async () => true,
          port: { read: async () => ({ status: 'ready' as const, metadataVersion: 1,
            metadata: { agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } }), compareAndSwap: async () => ({ status: 'unavailable' as const }) },
          status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const },
        };
        const preview = await prepareAgentIsolationEffects({ ...input, enabled: true }, effects);
        expect(preview).not.toBeNull();
        const setup = await machineNativeEffectAdmission.run({
          operation: { operationId: input.operationId, kind: 'agentIsolation', signal }, keys: [{ kind: 'machineSetup' }],
        }, nativeEffectContext => applyAgentIsolationMemberEffects({ ...input, nativeEffectContext,
          expectedPlanDigest: preview!.setupPlan.planDigest }, effects));
        expect(setup.kind).toBe('ready');
        if (setup.kind !== 'ready') throw new Error('Member fixture setup failed');
        const target = { runtimeHome: join(expected.home, 'runtime', 'session'), memberIdentity: setup.identity };
        const projection = await materializeQualifiedConnectedAccountLaunchUses({
          connectedAccountsOwner: createUnavailablePluginServices().connectedAccounts,
          snapshot: { purposes: [], bindings: [] }, signal, agentLaunchTarget: target,
        });
        const material = projection.agentLaunchMaterials;
        expect(material).toBeDefined();
        if (!material) throw new Error('Selected material producer returned no projection');
        members.push({ requester, material });
        const context = createAgentIsolationSessionContext({
          machine: { read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1', status: input.status, workspaceRoots: [activeServerDir] }) },
          managedHappierBinaryPath: effects.installedCli,
          sessionRequester: requester.requester, sessionRequesterHomeServerIdentityId: requester.homeServerIdentityId,
          hostHomeServerIdentityId: requester.homeServerIdentityId, sessionCustodianAccountId: 'owner',
          readMaterial: () => material,
          providerEnvironmentKeys: CODEX_MANIFEST.contributes.agents[0]!.providerRequirements!.authIsolation.ownedEnvKeys,
        });
        expect(context.requesterIdentity).toEqual({ kind: requester.kind, requester: requester.requester,
          separationRequired: requester.separationRequired });
        for (const agentNativeLaunch of [true, false]) {
          const launch = await authorizeResolvedProjectExecLaunchForHost({
            launch: { command: '/bin/cat', args: [], cwd: activeServerDir,
              env: { PATH: '/usr/bin', HAPPIER_DAEMON_TOKEN: 'synthetic-private-value',
                HAPPIER_CODEX_PROVIDER_API_KEY: 'synthetic-selected-provider-value', RANDOM_SECRET: 'ambient-value' }, release() {} },
            agentIsolation: context, agentNativeLaunch,
            ...(agentNativeLaunch ? { sessionMcpContext: transport.localContext } : {}),
            signal, assertCurrent() {},
          });
          try {
            expect(launch.args).toEqual(['-n', '-u', expected.username, '--', effects.installedCli, 'agent-launch']);
            const frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble], { objectMode: false }));
            expect(frame.nativeIdentity).toEqual({ username: expected.username, agentUid: uid, agentGid: uid, home: expected.home });
            expect(frame.runtimeHome).toBe(target.runtimeHome);
            expect(frame.environment).not.toHaveProperty('HAPPIER_DAEMON_TOKEN');
            expect(frame.environment.HAPPIER_CODEX_PROVIDER_API_KEY === 'synthetic-selected-provider-value').toBe(true);
            expect(frame.environment).not.toHaveProperty('RANDOM_SECRET');
            expect(JSON.stringify({ args: launch.args, env: launch.env })).not.toContain('synthetic-selected-provider-value');
            usernames.push(launch.args[2]!);
          } finally { await launch.release(); }
        }
      }
      expect(new Set(usernames).size).toBe(3);
      const a = members[0]!, b = members[1]!;
      const copiedMaterial = createAgentIsolationSessionContext({
        machine: { read: () => ({ enabled: true,
          status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [activeServerDir] }) },
        managedHappierBinaryPath: '/opt/happier/cli/current/happier',
        sessionRequester: a.requester.requester, sessionRequesterHomeServerIdentityId: 'canonical-home',
        hostHomeServerIdentityId: 'canonical-home', sessionCustodianAccountId: 'owner',
        resolveRequesterIdentity: async () => a.requester, readMaterial: () => b.material,
      });
      await expect(authorizeResolvedProjectExecLaunchForHost({
        launch: { command: '/bin/cat', args: [], cwd: activeServerDir, env: {}, release() {} },
        agentIsolation: copiedMaterial, agentNativeLaunch: true, sessionMcpContext: transport.localContext,
        signal: new AbortController().signal, assertCurrent() {},
      })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted' });
    } finally { await transport.retire(); }
  });
});
