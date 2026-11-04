import { PassThrough, Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import * as machineSetup from '@happier-dev/cli-common/machineSetup';
import type { MachineAdminAccessObservationV1, MachineAdminAccessV1 } from '@happier-dev/protocol';
import type { MachineElevationSpawn } from '@/machines/adminAccess/runElevatedEffect';
import { MachineEffectInternalRequestSchema } from '@/machines/setup/effectInternalProtocol';
import type { AgentIsolationEffectDependencies } from './agentIsolationProvisioner';

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
  const frame = await readAgentLaunchFrame(Readable.from([options.inputBytes], { objectMode: false }));
  if (input.fail || frame.executable !== '/bin/sh' || !frame.args.includes('happier-isolation-readiness')
    || frame.nativeIdentity?.home !== input.nativeHome.path || frame.nativeIdentity.agentUid !== input.nativeHome.uid)
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
