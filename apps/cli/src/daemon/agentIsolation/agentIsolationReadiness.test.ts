import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { appendFile, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MachineAgentIsolationPreviewResultV1Schema, readMachineAgentIsolationPolicyV1,
  type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { readAgentLaunchFrame } from './agentLaunchFrame';
import { withTempDir } from '@/testkit/fs/tempDir';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createDaemonAgentIsolationEffects } from './createDaemonAgentIsolationEffects';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { readAgentIsolationSnapshot } from './agentIsolationPolicy';
import { createAgentIsolationSessionContext } from './agentIsolationSessionContext';
import { selectHostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { materializeQualifiedConnectedAccountLaunchUses } from '@/daemon/connectedServices/materialize/materializeQualifiedConnectedAccountLaunchUses';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { observeAgentIsolationNativeReadiness, type AgentIsolationReadinessSystem } from './agentIsolationReadiness';
import type { TrackedSession } from '@/daemon/types';
import { waitForExistingSessionExitIfStopRequested } from '@/daemon/sessions/waitForExistingSessionExitIfStopRequested';
import { logger } from '@/ui/logger';

// ACL commands are an OS boundary; the transport's exact ACL validation and
// real Unix socket lifecycle are not mocked.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => {
    const [command] = args;
    if (command === 'getent') {
      return Reflect.apply(actual.execFile, undefined, [process.execPath,
        ['-e', 'process.stdout.write("happier-agent:x:999:988::/var/lib/happier-agent:/usr/sbin/nologin\\n")'], ...args.slice(2)]);
    }
    if (command !== 'setfacl') return Reflect.apply(actual.execFile, undefined, args);
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
    return undefined;
  } };
});

afterEach(() => { vi.useRealTimers(); });

it.skipIf(process.platform !== 'linux')('reports unresolved probe cleanup without deleting a substituted path or losing cancellation', async () => {
  const warning = vi.spyOn(logger, 'warn');
  try {
  await withTempDir('isolation-readiness-cleanup-', async directory => {
    for (const cancel of [false, true]) {
      const workspace = join(directory, cancel ? 'cancelled' : 'unresolved');
      await mkdir(workspace);
      const controller = new AbortController();
      let replacement = '';
      const system: AgentIsolationReadinessSystem = { run: async (command, args, options) => {
        if (command === 'getent') return { stdout: args.includes('group')
          ? args.at(-1) === 'happier-agent' ? 'happier-agent:x:988:\n' : 'happier-workspace:x:1001:happier,happier-agent\n'
          : 'happier-agent:x:999:988::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
        if (!options?.inputBytes) throw new Error('Expected framed native probe');
        const frame = await readAgentLaunchFrame(Readable.from([options.inputBytes], { objectMode: false }));
        replacement = frame.args.at(-1)!;
        await rename(replacement, `${replacement}.held`);
        await mkdir(replacement);
        await writeFile(join(replacement, 'sentinel'), 'retained');
        if (cancel) controller.abort();
        throw Object.assign(new Error('Native probe refused'), { code: 76 });
      } };
      const result = observeAgentIsolationNativeReadiness({ installedCli: '/opt/happier/cli/current/happier',
        roots: [workspace], privateRoots: [], system, signal: controller.signal });
      if (cancel) await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(result).resolves.toEqual({ kind: 'unavailable', code: 'workspace_not_ready' });
      expect(await readFile(join(replacement, 'sentinel'), 'utf8')).toBe('retained');
      expect(warning).toHaveBeenCalledWith(expect.any(String), {
        code: 'agent_isolation_probe_cleanup_failed', phase: 'workspace',
      });
      warning.mockClear();
    }
  });
  } finally { warning.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('publishes effective only after current native qualification, preserves refusal and performs no idle probes', async () => {
  await withTempDir('isolation-readiness-', async directory => {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    let enabled = false, metadataVersion = 1, current = true, probes = 0;
    const trackedSessions = new Map<number, TrackedSession>();
    let status: MachineAgentIsolationStatusV1 = { kind: 'disabled' };
    let failProbe = false, revokeDuringProbe = false, wrongChallenge = false, skipAnonymous = false, plantedLink = false;
    let probeFailureCode = 72;
    const outside = join(directory, 'private-sentinel');
    await writeFile(outside, 'agent');
    const privateRoot = join(directory, 'daemon-private');
    await mkdir(privateRoot, { mode: 0o700 });
    const publications: MachineAgentIsolationStatusV1[] = [];
    const native = createAgentIsolationEffectsBoundary({ installationId: 'installation',
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => [{ rootId: 'workspace', path: workspace }],
      readSessionsToReplace: () => trackedSessions.size, publishStatus: async value => { publications.push(value); status = value; } });
    const production = createDaemonAgentIsolationEffects({ getMachineClient: () => null,
      adminAccess: { target: () => ({ serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }),
        observer: createMachineAdminAccessObserver({ onChanged: async () => {} }) },
      readRoots: native.effects.readRoots, trackedSessions,
      protectedRoots: [privateRoot], privateRoots: [privateRoot] });
    let qualificationEnabled = false;
    const nativeReadiness = production.nativeReadiness && { ...production.nativeReadiness, system: {
      // Process/OS boundary only. The actual frame, finite readiness owner,
      // setup interpreter, metadata CAS and registered RPC handler stay real.
      run: async (command: string, args: readonly string[], options: Parameters<AgentIsolationReadinessSystem['run']>[2]) => {
        if (command === 'getent') return { stdout: args.includes('group') ? args.at(-1) === 'happier-agent' ? 'happier-agent:x:988:\n' : 'happier-workspace:x:1001:happier,happier-agent\n'
          : 'happier-agent:x:999:988::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
        probes++;
        expect(command).toBe('sudo');
        expect(args).toEqual(['-n', '-u', 'happier-agent', '--', effects.installedCli, 'agent-launch']);
        const frame = await readAgentLaunchFrame(Readable.from([options.inputBytes!], { objectMode: false }));
        expect(frame.executable).toBe('/bin/sh');
        await execFileWithDeadline('/bin/sh', ['-n', '-c', frame.args[1]!], { encoding: 'utf8' });
        expect(frame.args.slice(9, 11)).toEqual(['1', privateRoot]);
        expect(frame.environment).not.toHaveProperty('HAPPIER_DAEMON_TOKEN');
        if (revokeDuringProbe) current = false;
        if (failProbe) throw Object.assign(new Error('Native probe refused'), { code: probeFailureCode });
        const socketPath = frame.args[7]!;
        const header = Buffer.from(frame.selectedMaterials.find(file => file.relativePath === 'files/headers')!.contentBase64, 'base64').toString('utf8').trim().slice('Authorization: '.length);
        for (const authorization of skipAnonymous ? [header] : [header, undefined]) await new Promise<void>((resolve, reject) => {
          const request = httpRequest({ socketPath, path: '/readiness', ...(authorization ? { headers: { authorization } } : {}) }, response => {
            response.resume(); response.once('end', resolve);
          });
          request.once('error', reject); request.end();
        });
        for (const path of frame.args.slice(11)) {
          await appendFile(join(path, 'daemon'), 'agent');
          if (plantedLink) await symlink(outside, join(path, 'agent'));
          else await writeFile(join(path, 'agent'), 'agent');
        }
        // Replace sudo/native identity at the OS boundary, preserving the real
        // process capture: decoding arbitrary challenge bytes as UTF-8 must fail.
        const challenge = wrongChallenge ? Buffer.from('corrupted binary transport').toString('base64')
          : frame.selectedMaterials.find(file => file.relativePath === 'files/challenge')!.contentBase64;
        return execFileWithDeadline(process.execPath, ['-e',
          'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(Buffer.from(process.argv[1], "base64")));',
          challenge], options);
      },
      // Native local transport setup is exercised separately below the same
      // OS boundary; this handler test has no Session/socket authority.
    } };
    const effects = { ...native.effects, readSessionsToReplace: production.readSessionsToReplace,
      get nativeReadiness() { return qualificationEnabled ? nativeReadiness : undefined; } };
    const handlers: RpcHandlerMap = new Map();
    registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      target: () => ({ serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }),
      read: () => ({ enabled, status }), effects,
      runActionOperation: createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
        resolveAccountId: async () => 'owner' }).runActionOperation,
      captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion, metadata: { agentIsolation: { enabled } } }),
        compareAndSwap: async input => {
          const policy = readMachineAgentIsolationPolicyV1(input.metadata);
          if (policy.status !== 'ready') throw new Error('Invalid metadata boundary');
          enabled = policy.policy.enabled; metadataVersion++;
          return { status: 'applied', metadataVersion, metadata: { agentIsolation: { enabled } } }; } }),
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current, transportRequestId: 'readiness-operation' };
    const preview = () => handlers.get('machines.agentIsolation.preview')!({ machineId: 'machine', enabled: true }, context);
    let requestIndex = 0;
    const apply = async () => {
      const observed = MachineAgentIsolationPreviewResultV1Schema.parse(await preview());
      if (observed.kind !== 'ready') throw new Error('Preview unavailable');
      return handlers.get('machines.agentIsolation.set')!({ machineId: 'machine', enabled: true,
        expectedMetadataVersion: observed.metadataVersion, expectedPolicy: observed.policy,
        expectedPlanDigest: observed.plan.planDigest }, { ...context, transportRequestId: `readiness-operation-${++requestIndex}` });
    };
    // A separate Session transport and the real selected-material projector
    // supply launch bytes; readiness's retired probe endpoint is never reused.
    const transport = await prepareSessionMcpLocalTransport({ agentUid: 999 });
    try {
    const materialized = await materializeQualifiedConnectedAccountLaunchUses({
      connectedAccountsOwner: createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: async () => { throw new Error('Unexpected binding update'); }, subscribe: () => ({ dispose() {} }) },
        selectTarget: async () => { throw new Error('Unexpected target selection'); },
        resolveTarget: async () => { throw new Error('Unexpected target resolution'); },
        materializeAccount: async () => { throw new Error('Unexpected materialization'); },
        projectTargetAccounts: async () => { throw new Error('Unexpected account projection'); },
        assertTargetAccountMaterializable: async () => { throw new Error('Unexpected account validation'); },
      }),
      snapshot: { purposes: [], bindings: [] }, signal: context.signal,
      agentLaunchTarget: { runtimeHome: join(directory, 'session-runtime') },
    });
    let material = materialized.agentLaunchMaterials;
    const machineContext = { read: () => ({ ...readAgentIsolationSnapshot({
      metadata: { status: 'ready', metadataVersion, metadata: { agentIsolation: { enabled } } },
      daemonState: { runtimeId: 'current-daemon', agentIsolation: status },
      runtimeId: 'current-daemon', platform: process.platform,
    }), workspaceRoots: [workspace] }) };
    // This registered global readiness path owns the existing shared account.
    // Member-native qualification is covered through its separate own-status owner.
    const ownerAgent = createAgentIsolationSessionContext({ machine: machineContext,
      managedHappierBinaryPath: effects.installedCli, readMaterial: () => material,
      sessionRequester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' },
      sessionCustodianAccountId: 'owner', hostHomeServerIdentityId: 'home', sessionRequesterHomeServerIdentityId: 'home' });
    const input = { launch: { command: '/usr/bin/true', args: [], cwd: workspace,
        env: { HAPPIER_DAEMON_TOKEN: 'synthetic-custodian-secret' }, release() {} },
      agentNativeLaunch: true, sessionMcpContext: transport.localContext,
      signal: context.signal, assertCurrent() {} };
    const restrictedLaunch = () => authorizeResolvedProjectExecLaunchForHost({ ...input, agentIsolation: ownerAgent });
    const policyOffOwner = await restrictedLaunch();
    expect(policyOffOwner.command).toBe(input.launch.command);
    await policyOffOwner.release();
    const ownerIdentity = selectHostRequesterExecutionIdentity({ rpcContext: { ...context, callerAuthority: 'present_user' },
      hostHomeServerIdentityId: 'home' });
    const owner = await authorizeResolvedProjectExecLaunchForHost({ ...input, agentIsolation: machineContext,
      requesterIdentity: ownerIdentity, executionKind: 'person_break_glass' });
    expect(owner.command).toBe(input.launch.command);
    await owner.release();
    await expect(authorizeResolvedProjectExecLaunchForHost({ ...input, agentIsolation: ownerAgent,
      executionKind: 'person_break_glass' })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted' });
    // Provisioning alone cannot advance launch admission: this is the actual
    // registered edge with the native qualification producer unavailable.
    await expect(apply()).resolves.toMatchObject({ kind: 'accepted', status: { kind: 'applying' } });
    expect(probes).toBe(0);
    await expect(restrictedLaunch()).rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted' });
    qualificationEnabled = true;
    await expect(apply()).resolves.toMatchObject({ kind: 'accepted', status: { kind: 'effective' } });
    expect(status).toEqual({ kind: 'effective', platform: 'linux', agentUser: 'happier-agent' });
    expect(probes).toBe(1);
    const admitted = await restrictedLaunch();
    expect(admitted.command).toBe('sudo');
    expect(admitted.args).toEqual(['-n', '-u', 'happier-agent', '--', effects.installedCli, 'agent-launch']);
    const frame = await readAgentLaunchFrame(Readable.from([admitted.stdinPreamble!], { objectMode: false }));
    expect(frame.executable).toBe(input.launch.command);
    expect(frame.environment).not.toHaveProperty('HAPPIER_DAEMON_TOKEN');
    expect(frame.selectedMaterials.some(file => file.relativePath === '.happier/session-mcp.json')).toBe(true);
    await admitted.release();
    const terminal = await authorizeResolvedProjectExecLaunchForHost({ ...input, agentIsolation: ownerAgent, agentLaunchKind: 'terminal' });
    expect(terminal.command).toBe('sudo');
    await terminal.release();
    for (const agentLaunchKind of ['managedService', 'attach'] as const) {
      await expect(authorizeResolvedProjectExecLaunchForHost({ ...input, agentIsolation: ownerAgent, agentLaunchKind }))
        .rejects.toMatchObject({ code: 'agent_isolation_unavailable', details: { reason: 'agent_launch_kind_unavailable' }, execLaunch: 'notStarted' });
    }
    const retainedMaterial = material;
    material = undefined;
    await expect(restrictedLaunch()).rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted' });
    material = retainedMaterial;
    const settledPublications = publications.length;
    await expect(apply()).resolves.toMatchObject({ kind: 'unchanged', status: { kind: 'effective' } });
    expect(probes).toBe(1); expect(publications).toHaveLength(settledPublications);
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(60_000); vi.useRealTimers();
    expect(probes).toBe(1);
    status = { kind: 'applying', phase: 'runtime_replacement' };
    trackedSessions.set(12345, { pid: 12345, startedBy: 'daemon', happySessionId: 'stopping-session', stopRequestedAtMs: 1 });
    // Production census + registered Apply: requested stop is not actual exit.
    await expect(apply()).resolves.toMatchObject({ status: { kind: 'applying', phase: 'runtime_replacement' } });
    expect(probes).toBe(1);
    const pendingPublications = publications.length;
    const pendingMutations = native.mutations.length;
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(apply()).resolves.toMatchObject({ kind: 'unchanged', status: { kind: 'applying', phase: 'runtime_replacement' } });
    }
    expect(publications.length - pendingPublications).toBe(0);
    expect(native.mutations.length - pendingMutations).toBe(0);
    expect(probes).toBe(1);
    const waitForRetirement = (readRunState: Parameters<typeof waitForExistingSessionExitIfStopRequested>[0]['readRunState'],
      onExitObserved: NonNullable<Parameters<typeof waitForExistingSessionExitIfStopRequested>[0]['onExitObserved']>) =>
      waitForExistingSessionExitIfStopRequested({ sessionId: 'stopping-session', pidToTrackedSession: trackedSessions,
        timeoutMs: 0, pollIntervalMs: 0, readRunState, onExitObserved });
    const retire = async (pid: number) => { trackedSessions.delete(pid); };
    for (const runState of ['stopped', 'servable'] as const) {
      // A paused runner or the OS owner's unknown/alive fallback retains custody.
      await waitForRetirement(async () => runState, retire);
      await expect(apply()).resolves.toMatchObject({ kind: 'unchanged', status: { kind: 'applying' } });
      expect(probes).toBe(1);
    }
    let finishRetirement!: () => void;
    const retiring = new Promise<void>(resolve => { finishRetirement = resolve; });
    let exitObserved = false;
    const retirement = waitForRetirement(async () => 'dead', async pid => {
      exitObserved = true; await retiring; await retire(pid);
    });
    await vi.waitFor(() => expect(exitObserved).toBe(true));
    await expect(apply()).resolves.toMatchObject({ kind: 'unchanged', status: { kind: 'applying' } });
    expect(probes).toBe(1);
    finishRetirement(); await retirement;
    await expect(apply()).resolves.toMatchObject({ kind: 'accepted', status: { kind: 'effective' } });
    expect(probes).toBe(2);
    status = { kind: 'applying', phase: 'runtime_replacement' }; wrongChallenge = true;
    await expect(apply()).resolves.toMatchObject({ status: { kind: 'unavailable', code: 'launch_probe_failed' } });
    wrongChallenge = false; skipAnonymous = true;
    await expect(apply()).resolves.toMatchObject({ status: { kind: 'unavailable', code: 'mcp_socket_access_unavailable' } });
    skipAnonymous = false;
    plantedLink = true;
    await expect(apply()).resolves.toMatchObject({ status: { kind: 'unavailable' } });
    expect(await readFile(outside, 'utf8')).toBe('agent');
    plantedLink = false;
    status = { kind: 'applying', phase: 'runtime_replacement' }; failProbe = true;
    await expect(apply()).resolves.toMatchObject({ status: { kind: 'unavailable', code: 'launch_probe_failed' } });
    expect(status.kind).toBe('unavailable');
    probeFailureCode = 74;
    await expect(apply()).resolves.toMatchObject({ status: { kind: 'unavailable', code: 'local_admin_api_accessible' } });
    await expect(restrictedLaunch()).rejects.toMatchObject({ code: 'agent_isolation_unavailable',
      details: { reason: 'local_admin_api_accessible' }, execLaunch: 'notStarted' });
    failProbe = false; revokeDuringProbe = true;
    await expect(apply()).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(status.kind).not.toBe('effective');
    } finally { await transport.retire(); }
  });
});
