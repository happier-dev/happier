import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentIsolationMemberPreparationBoundary, runAgentIsolationMemberReadinessBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from '@/daemon/agentIsolation/provisioning';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { registerMachineAgentInstallJobRpcHandlers } from '@/api/machine/rpcHandlers.agentInstallJobs';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createAgentInstallJobOwner } from './agentInstallJobOwner';
import type { TrackedSession } from '@/daemon/types';

const os = vi.hoisted(() => ({ directory: '', home: '', workspace: '', capture: '', dispatch: [] as { args: readonly string[]; env: unknown }[] }));
// Only native filesystem metadata and sudo are substituted. Binding reads,
// requester placement, RunAs framing, RPC jobs and process settlement stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (path: Parameters<typeof actual.lstat>[0]) => String(path) === os.home
    ? Object.assign(await actual.lstat(os.directory), { uid: 2401, gid: 2401, mode: 0o40700 }) : actual.lstat(path),
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => [os.home, os.workspace].includes(String(path))
      ? String(path) : actual.realpath(path) };
});
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...request: Parameters<typeof actual.execFileWithDeadline>) =>
    await runAgentIsolationMemberReadinessBoundary({ request, nativeHome: { path: os.home, uid: 2401 } })
      ?? actual.execFileWithDeadline(...request) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (args[0] !== 'sudo') return actual.spawn(...args);
    os.dispatch.push({ args: [...args[1] ?? []], env: args[2]?.env });
    // The OS fixture captures the private frame and operation then responds as
    // the selected process. Actual installer IO is covered by memberInstallEffect.
    return actual.spawn(process.execPath, ['-e', `
      const fs=require('fs'); let bytes=Buffer.alloc(0), replied=false;
      process.stdin.on('data', chunk=>{bytes=Buffer.concat([bytes,chunk]);
        if(bytes.length<12||replied)return; const end=12+bytes.readUInt32BE(8);
        if(bytes.length<end||!bytes.subarray(end).includes(10))return;
        fs.writeFileSync(${JSON.stringify(os.capture)},bytes); replied=true;
        process.stdout.write(JSON.stringify({t:'outcome',outcome:{kind:'succeeded',version:'1.0.0'}})+'\\n');
      });
    `], { ...args[2], cwd: os.directory });
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test.skipIf(process.platform !== 'linux').each(['use', 'manage'] as const)('registered %s member install uses existing UID and member-local roots without daemon secrets', async role => {
  const directory = await mkdtemp(join(tmpdir(), 'member-install-boundary-'));
  const requester: AgentIsolationMemberRequester = { kind: 'isolated', separationRequired: role === 'use', homeServerIdentityId: 'home',
    requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
  const identity = deriveAgentIsolationMemberIdentity(requester);
  Object.assign(os, { directory, home: identity.home, workspace: identity.workspaceRoot, capture: join(directory, 'capture'), dispatch: [] });
  const boundary = createAgentIsolationMemberPreparationBoundary({ activeServerDir: directory, requesterIdentity: requester,
    custodianAccountId: 'custodian', encryptionMode: 'plain', uid: 2401 });
  const prepared = await boundary.prepare();
  if (prepared.kind !== 'ready') throw new Error('Native fixture preparation failed');
  boundary.mutations.length = 0; boundary.launches.length = 0;
  const machine: HostAgentIsolationLaunchContext = { managedHappierBinaryPath: boundary.effects.installedCli,
    read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }),
    readMember: input => boundary.members.read(input),
    prepareMember: () => { throw new Error('Install must not provision or repair native users'); },
  };
  const session: TrackedSession = { pid: process.pid, startedBy: 'daemon',
    requesterWorkAttributionV1: { ...requester.requester, accountId: 'custodian' },
    spawnOptions: { directory, runtimeDescriptorV1: { v: 1, agentId: 'fixture', agent: {} } } };
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [session],
    readRegistry: () => ({ agents: [{ id: 'fixture',
      runtimeSpec: { id: 'fixture', title: 'Fixture', binaryName: 'fixture', sourcePreferenceDefault: 'system-first',
        managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false } }] }) });
  const handlers = new Map<string, RpcHandler>();
  registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
    deps: { agentIsolation: machine, resolveHostHomeServerIdentityId: async () => 'home',
      nativeOperationRuntime: { prepareNativeOperation: input => prepareRequesterNativeOperation(input, { machine,
        homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation' }) } } });
  const context: RpcHandlerContext = { signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: { actorAccountId: 'member', custodianAccountId: 'custodian', machineId: 'machine', installationId: 'installation', role, encryptionMode: 'plain' } };
  vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', '/owner-private/tools'); vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '/owner-private/install');
  vi.stubEnv('NPM_CONFIG_USERCONFIG', '/owner-private/.npmrc'); vi.stubEnv('GITHUB_TOKEN', 'owner-private-token');
  try {
    const result = await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({ agentId: 'fixture', intent: 'install', consent: { vendorRecipe: true } }, context);
    if (!result || typeof result !== 'object' || !('jobId' in result) || typeof result.jobId !== 'string') throw new Error(JSON.stringify(result));
    expect(await owner.read({ jobId: result.jobId, cursor: 0, waitForTerminal: true }, 'member'))
      .toMatchObject({ done: true, outcome: { kind: 'succeeded', version: '1.0.0' } });
    expect(owner.list('custodian')).toEqual({ ok: true, jobs: [] });
    expect(owner.list('member')).toMatchObject({ jobs: [{ executionScope: 'member' }] });
    const updated = await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({ agentId: 'fixture', intent: 'update', consent: { vendorRecipe: true } }, context);
    if (!updated || typeof updated !== 'object' || !('jobId' in updated) || typeof updated.jobId !== 'string') throw new Error(JSON.stringify(updated));
    expect(await owner.read({ jobId: updated.jobId, cursor: 0, waitForTerminal: true }, 'member'))
      .toMatchObject({ done: true, outcome: { kind: 'succeeded' } });
    session.requesterWorkAttributionV1 = requester.requester;
    expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({ agentId: 'fixture', intent: 'update', consent: { vendorRecipe: true } }, context))
      .toMatchObject({ ok: false, errorCode: 'in_use' });
    if (role === 'use') expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({ agentId: 'fixture', intent: 'uninstall', consent: { vendorRecipe: false } }, context))
      .toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    const bytes = await readFile(os.capture);
    const frame = await readAgentLaunchFrame(Readable.from([bytes], { objectMode: false }));
    expect(frame.nativeIdentity).toMatchObject({ username: identity.username, agentUid: 2401, home: identity.home });
    expect(frame.environment).toMatchObject({ HAPPIER_FIRST_PARTY_INSTALL_HOME: join(identity.home, '.happier'),
      HAPPIER_MANAGED_TOOLS_ROOT: join(identity.home, '.happier/tools'), XDG_CONFIG_HOME: join(identity.home, '.config') });
    expect(bytes.toString()).not.toContain('owner-private');
    expect(os.dispatch[0]?.args).toEqual(['-n', '-u', identity.username, '--', boundary.effects.installedCli, 'agent-launch']);
    expect(os.dispatch[0]?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(boundary.mutations).toEqual([]); expect(boundary.launches).toEqual([]);
  } finally { await owner.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
