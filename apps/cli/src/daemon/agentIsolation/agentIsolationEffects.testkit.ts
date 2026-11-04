import { PassThrough, Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import * as machineSetup from '@happier-dev/cli-common/machineSetup';
import type { MachineAdminAccessObservationV1, MachineAdminAccessV1 } from '@happier-dev/protocol';
import type { MachineElevationSpawn } from '@/machines/adminAccess/runElevatedEffect';
import { MachineEffectInternalRequestSchema } from '@/machines/setup/effectInternalProtocol';
import type { AgentIsolationEffectDependencies } from './agentIsolationProvisioner';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createAgentIsolationMemberOperations } from './createAgentIsolationMemberOperations';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from './provisioning';

import type { AgentIsolationReadinessSystem } from './agentIsolationReadiness';
import { readAgentLaunchFrame } from './agentLaunchFrame';

/** Virtual OS execution of the fixed member readiness frame. Native fixture
 * homes stand in for actual uid-owned homes; the readiness owner stays real. */
export async function runAgentIsolationMemberReadinessBoundary(input: Readonly<{
  request: Parameters<AgentIsolationReadinessSystem['run']>;
  nativeHome?: Readonly<{ path: string; uid: number }>;
  fail?: boolean;
}>) {
  const [command, args, options] = input.request;
  if (command !== 'sudo' || args?.at(-1) !== 'agent-launch' || !options?.inputBytes || !input.nativeHome)
    return undefined;
  const frame = await readAgentLaunchFrame(Readable.from([options.inputBytes], { objectMode: false }), undefined, true);
  if (input.fail || frame.nativeIdentity?.home !== input.nativeHome.path || frame.nativeIdentity.agentUid !== input.nativeHome.uid)
    throw Object.assign(new Error('Constructed native payload permission failure'), { code: 73 });
  if ('action' in frame) return { stdout: '', stderr: '' };
  if (frame.executable !== '/bin/sh' || !frame.args.includes('happier-isolation-readiness'))
    throw Object.assign(new Error('Constructed native payload permission failure'), { code: 73 });
  return { stdout: 'member-native-ready\n', stderr: '' };
}

/** Native OS/process boundary only; Actions, field CAS and setup interpretation stay real. */
export function createAgentIsolationEffectsBoundary(input: Pick<AgentIsolationEffectDependencies,
  'installedCli' | 'readRoots' | 'readSessionsToReplace' | 'publishStatus'> & Readonly<{
    installationId: string; backend?: machineSetup.MachineSetupBackend; adminAccess?: MachineAdminAccessV1;
  }>) {
  const installed = new Set<string>();
  const mutations: string[] = [], boundaryFailures: unknown[] = [];
  const launches: Parameters<MachineElevationSpawn>[0][] = [];
  let loseConfirmation = false;
  const backend: machineSetup.MachineSetupBackend = {
    async observe(step, ...rest) { if (input.backend) return input.backend.observe(step, ...rest);
      if (step.kind === 'file' && step.state === 'absent') return { stepId: step.id,
        status: installed.has(step.id) ? 'drifted' : 'satisfied', facts: { present: installed.has(step.id) } };
      return { stepId: step.id, status: installed.has(step.id) ? 'satisfied' : 'drifted',
      facts: { present: installed.has(step.id) } }; },
    async apply(step, ...rest) { mutations.push(step.id);
      if (input.backend) await input.backend.apply(step, ...rest);
      else if (step.kind === 'file' && step.state === 'absent') installed.delete(step.id);
      else installed.add(step.id); },
  };
  const observation: MachineAdminAccessObservationV1 = { version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
    daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid',
    tailscaledOperator: { authorization: 'unknown' } };
  const spawn: MachineElevationSpawn = request => {
    launches.push(request);
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    let settle!: (value: { code: number | null; signal: string | null }) => void;
    const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => { settle = resolve; });
    let closed = false;
    const finish = (code: number | null) => { if (closed) return; closed = true; stdout.end(); stderr.end(); stdin.destroy(); settle({ code, signal: null }); };
    void (async () => {
      const lines = createInterface({ input: stdin });
      try {
        const iterator = lines[Symbol.asyncIterator]();
        if (request.args.includes('-S')) {
          const policy = input.adminAccess;
          if (policy?.mode !== 'ask') throw new Error('Ask fixture requires the configured OS administrator');
          stderr.write(`[happier-sudo-password:${policy.administratorUsername}]\n`);
          const password = await iterator.next();
          if (password.done || password.value !== 'one-use-password') { finish(1); return; }
        }
        stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
        while (true) {
          const next = await iterator.next();
          if (next.done) { finish(1); return; }
          const frame = MachineEffectInternalRequestSchema.parse(JSON.parse(next.value));
          if (frame.mode === 'check' && !('steps' in frame))
            throw new Error('Isolation OS fixture requires a step-based setup check');
          const result = frame.mode === 'check'
            ? { status: 'checked', plan: await machineSetup.checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps, backend }) }
            : await machineSetup.applyMachineSetupEffectPlans({
              ...('intent' in frame ? { intent: frame.intent } : { plans: frame.plans }),
              ...('daemonUsername' in frame && frame.daemonUsername ? { daemonUsername: frame.daemonUsername } : {}), backend,
              onProgress: event => stdout.write(JSON.stringify({ type: 'progress', ...event }) + '\n') });
          if (!loseConfirmation) stdout.write(JSON.stringify({ type: 'result', result }) + '\n');
          if (frame.mode === 'check' && 'continueWithApply' in frame && frame.continueWithApply && !loseConfirmation) continue;
          finish(0); break;
        }
      } finally { lines.close(); }
    })().catch(error => { boundaryFailures.push(error); finish(1); });
    return { stdin, stdout, stderr, settled, terminate: async () => finish(null) };
  };
  const effects: AgentIsolationEffectDependencies = { ...input, platform: 'linux', backend,
    readDaemonObservation: () => observation,
    elevation: { installationId: input.installationId, installedCli: input.installedCli, spawn,
      readPolicy: async () => input.adminAccess ?? ({ version: 1, mode: 'preauthorized' }), observe: async () => observation } };
  return { effects, mutations, launches, boundaryFailures, loseConfirmation: () => { loseConfirmation = true; } };
}

/** Real member operation/setup composition. Only native account/process facts
 * are represented here; callers provide the filesystem's native home facts. */
export function createAgentIsolationMemberPreparationBoundary(input: Readonly<{
  activeServerDir: string;
  requesterIdentity: AgentIsolationMemberRequester;
  custodianAccountId: string;
  encryptionMode: NonNullable<RpcHandlerContext['machineAdmission']>['encryptionMode'];
  uid: number;
  adminAccess?: MachineAdminAccessV1;
  readActivityInventory?: Parameters<typeof createAgentIsolationMemberOperations>[0]['readActivityInventory'];
  /** Native OS state outlives the daemon runtime in restart fixtures. */
  nativeState?: { installed: Set<string>; drifted: Set<string>; accountUid: number };
}>) {
  const { requesterIdentity, activeServerDir, uid } = input;
  const derived = deriveAgentIsolationMemberIdentity(requesterIdentity);
  const installed = input.nativeState?.installed ?? new Set<string>();
  const drifted = input.nativeState?.drifted ?? new Set<string>();
  const nativeState = input.nativeState ?? { installed, drifted, accountUid: uid };
  let nextAllocatedUid = uid;
  let userObservations = 0, daemonInspections = 0, heldObservationAvailable = true, rootUid = uid;
  const permissionQueries: Readonly<{ command: string; args: readonly string[] }>[] = [];
  const permissionSystem: AgentIsolationReadinessSystem = { run: async (command, args, options) => {
    permissionQueries.push({ command, args: [...args ?? []] });
    if (command !== 'sudo' || JSON.stringify(args) !== JSON.stringify([
      '-n', '-u', derived.username, '--', '/opt/happier/cli/current/happier', 'agent-launch',
    ])) throw new Error('Unexpected member permission probe');
    if (!installed.has('agent-runas') || drifted.has('agent-runas'))
      throw Object.assign(new Error('Native RunAs permission denied'), { code: 1 });
    const readiness = await runAgentIsolationMemberReadinessBoundary({ request: [command, args, options],
      nativeHome: { path: derived.home, uid: nativeState.accountUid } });
    if (!readiness) throw new Error('Unexpected member readiness frame');
    return readiness;
  } };
  const backend: machineSetup.MachineSetupBackend = {
    async observe(step): Promise<machineSetup.MachineSetupStepObservationV1> {
      if (step.kind === 'user') userObservations++;
      if (step.kind === 'file' && step.state === 'absent') {
        const present = installed.has('agent-runas');
        return { stepId: step.id, status: present ? 'drifted' : 'satisfied', facts: { present } };
      }
      const present = installed.has(step.id);
      return { stepId: step.id, status: present && !drifted.has(step.id) ? 'satisfied' : 'drifted',
        facts: step.kind === 'user' && present ? { present, uid: 'locked' in step && rootUid !== uid ? rootUid : nativeState.accountUid, gid: uid,
          username: derived.username, home: derived.home } : step.id === 'member-workspace' && present
          ? { present, uid: nativeState.accountUid, gid: 1001 } : { present,
          ...(step.kind === 'user' && 'uid' in step && typeof step.uid === 'number' ? { availableUid: step.uid } : {}) } };
    },
    async apply(step) {
      if (step.kind === 'user' && !installed.has(step.id)) {
        nativeState.accountUid = 'uid' in step && typeof step.uid === 'number' ? step.uid : nextAllocatedUid;
      }
      if (step.kind === 'file' && step.state === 'absent') installed.delete('agent-runas');
      else installed.add(step.id);
      drifted.delete(step.id);
    },
  };
  const native = createAgentIsolationEffectsBoundary({ backend, adminAccess: input.adminAccess,
    installationId: requesterIdentity.requester.installationId,
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
    publishStatus: async () => {} });
  const effects: AgentIsolationEffectDependencies = { ...native.effects,
    nativeReadiness: { privateRoots: [], system: permissionSystem },
    readDaemonObservation: () => heldObservationAvailable ? native.effects.readDaemonObservation?.() ?? null : null,
    elevation: { ...native.effects.elevation, observe: async () => { daemonInspections++; return native.effects.elevation.observe(); } } };
  let metadata: Record<string, unknown> = { agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } };
  const port = { read: async () => ({ status: 'ready' as const, metadataVersion: 1, metadata }),
    compareAndSwap: async () => ({ status: 'unavailable' as const }) };
  let nextOperation = 0;
  const runtime = createHostActionOperationRuntime({ serverId: requesterIdentity.requester.serverId,
    machineId: requesterIdentity.requester.machineId,
    custodyBinding: { serverId: requesterIdentity.requester.serverId, installationId: requesterIdentity.requester.installationId },
    resolveAccountId: async () => input.custodianAccountId, generateOperationId: () => `member-setup-${++nextOperation}` });
  const members = createAgentIsolationMemberOperations({ observeExecution: runtime.observeExecution, operations: runtime,
    serverId: requesterIdentity.requester.serverId, readActivityInventory: input.readActivityInventory ?? (() => null), activeServerDir, effects,
    captureMetadataPort: () => port,
    target: () => ({ homeServerIdentityId: requesterIdentity.homeServerIdentityId,
      machineId: requesterIdentity.requester.machineId, installationId: requesterIdentity.requester.installationId,
      custodianAccountId: input.custodianAccountId, encryptionMode: input.encryptionMode }) });
  const prepare = (options: Readonly<{ rpcContext?: RpcHandlerContext; signal?: AbortSignal }> = {}) => {
    permissionQueries.length = 0;
    return members.prepare({ requesterIdentity, ...options });
  };
  return { ...native, effects, runtime, members, prepare, installed, drifted, port, nativeState, permissionQueries,
    filesystemHome: { path: derived.home, backingDirectory: activeServerDir, uid, gid: uid },
    run: () => prepare(),
    setPolicy(policy: unknown) { metadata = { agentIsolation: policy }; },
    setHeldObservation(available: boolean) { heldObservationAvailable = available; },
    setRootUid(value: number) { rootUid = value; },
    setNextAllocatedUid(value: number) { nextAllocatedUid = value; },
    userObservations: () => userObservations, daemonInspections: () => daemonInspections,
    resetObservations() { userObservations = 0; daemonInspections = 0; } };
}
