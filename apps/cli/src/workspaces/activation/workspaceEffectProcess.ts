import type { Duplex, Readable, Writable } from 'node:stream';
import {
  authorizeResolvedProjectExecLaunchForHost,
  spawnAuthorizedHostExecLaunchForHost,
  type HostAuthorizedPluginExecLaunch,
} from '@/plugins/runtime/invocation/services/exec';
import { createBackgroundServiceProcessServiceHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBridge';
import { buildMemberAgentExecutionPath } from '@/capabilities/installJobs/memberInstallEnvironment';
import {
  createBackgroundServiceProcessFrameDecoder,
  encodeBackgroundServiceProcessFrame,
  parseBackgroundServiceProcessMessage,
} from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessProtocol';

type LaunchContext = Omit<
  Parameters<typeof authorizeResolvedProjectExecLaunchForHost>[0],
  'launch' | 'agentLaunchKind' | 'agentNativeLaunch'
>;

/** The one member child for Workspace effects (`workspace-effect`): the same
 * installed binary, run as the requester's member user with the member folder
 * as its working directory. Checkout, Sync, SCM repository work and Session import share it. */
export function authorizeWorkspaceEffectLaunch(
  input: LaunchContext &
    Readonly<{
      managedHappierBinaryPath: string;
      workspaceRoot: string;
      env?: Readonly<Record<string, string>>;
    }>,
): Promise<HostAuthorizedPluginExecLaunch> {
  const { managedHappierBinaryPath, workspaceRoot, env, ...context } = input;
  const memberHome = context.agentIsolation?.read()?.memberIdentity?.home;
  return authorizeResolvedProjectExecLaunchForHost({
    ...context,
    agentLaunchKind: 'workspaceExec',
    agentNativeLaunch: false,
    launch: {
      command: managedHappierBinaryPath,
      args: ['workspace-effect'],
      cwd: workspaceRoot,
      env: { PATH: buildMemberAgentExecutionPath({ HOME: memberHome }), ...env },
      maxStdoutBytes: 0,
      maxStderrBytes: 0,
    },
  });
}

export type WorkspaceEffectChildOutcome = Readonly<{
  /** The child reported the run settled (its services already delivered the result or failure). */
  settled: boolean;
  /** A transport, protocol or child-reported failure. */
  failure?: unknown;
  exitedCleanly: boolean;
}>;

type WorkspaceEffectInvocation = Readonly<{
  signal: AbortSignal;
  id: string;
  effect: unknown;
  services: Readonly<Record<string, unknown>>;
  refusal(code: string): Error;
}>;

type WorkspaceEffectPipe = Readonly<{
  input: Readable;
  output: Writable;
  wait(): Promise<boolean>;
  dispose(): Promise<void>;
}>;

/** One framing owner for an admitted OS-member process or managed-target byte
 * channel. This pipe carries services, never Account authentication material. */
async function runWorkspaceEffectPipe(input: WorkspaceEffectInvocation, pipe: WorkspaceEffectPipe): Promise<WorkspaceEffectChildOutcome> {
  const decoder = createBackgroundServiceProcessFrameDecoder();
  let failure: unknown;
  let settled = false;
  const send = (value: unknown) => { pipe.output.write(encodeBackgroundServiceProcessFrame(value)); };
  const services = createBackgroundServiceProcessServiceHost({ signal: input.signal, services: input.services,
    send: message => send({ kind: 'services', message }) });
  const receive = (chunk: Buffer) => {
    try {
      for (const raw of decoder.push(chunk)) {
        const message = parseBackgroundServiceProcessMessage(raw);
        if (message.kind === 'services') services.receive(message.message);
        else if (message.kind === 'settled' && message.id === input.id) { settled = true; pipe.output.end(); }
        else if (message.kind === 'failed' && message.id === input.id) { failure = input.refusal(message.error.code); pipe.output.end(); }
        else throw input.refusal('workspace_effect_protocol_invalid');
      }
    } catch (error) { failure = error; void pipe.dispose(); }
  };
  const ignoreWriteError = () => {}; // Physical completion below owns failed writes.
  pipe.input.on('data', receive);
  pipe.output.on('error', ignoreWriteError);
  try {
    send({ kind: 'run', id: input.id, context: input.effect, services: services.description });
    const exitedCleanly = await pipe.wait();
    return { settled, ...(failure !== undefined ? { failure } : {}), exitedCleanly };
  } finally {
    pipe.input.off('data', receive);
    pipe.output.off('error', ignoreWriteError);
    try { await services.dispose(); } finally { await pipe.dispose(); }
  }
}

/** Existing native provider admission owns this channel's process and cancel
 * lifetime. Completion of its framed result is the guest's outcome authority. */
export async function runWorkspaceEffectChannel(input: WorkspaceEffectInvocation & Readonly<{ channel: Duplex }>): Promise<WorkspaceEffectChildOutcome> {
  const channel = input.channel;
  input.signal.throwIfAborted();
  let ended = false;
  const finished = new Promise<boolean>((resolve, reject) => {
    channel.once('end', () => { ended = true; resolve(true); });
    channel.once('close', () => { if (!ended) resolve(false); });
    channel.once('error', reject);
  });
  const abort = () => { channel.destroy(input.signal.reason instanceof Error ? input.signal.reason : new Error('workspace_effect_cancelled')); };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    return await runWorkspaceEffectPipe(input, { input: channel, output: channel,
      wait: () => finished, dispose: async () => { channel.destroy(); } });
  } finally { input.signal.removeEventListener('abort', abort); }
}

/** One finite effect over the private frame pipe, to process settlement. The
 * caller's services receive the result; the incumbent supervisor owns the launch. */
export async function runWorkspaceEffectChild(input: WorkspaceEffectInvocation & Readonly<{
  launch: HostAuthorizedPluginExecLaunch;
  beforeSpawn?(): Promise<void>;
}>): Promise<WorkspaceEffectChildOutcome> {
  let transferred = false;
  try {
    await input.beforeSpawn?.();
    const process = spawnAuthorizedHostExecLaunchForHost(input.launch, { signal: input.signal });
    transferred = true;
    return await runWorkspaceEffectPipe(input, { input: process.child.stdout, output: process.child.stdin,
      wait: async () => {
        const completed = await process.handle.wait();
        await process.dispose('caller');
        await process.waitForSettlement();
        return completed.termination.observed.kind === 'exit' && completed.termination.observed.exitCode === 0;
      },
      dispose: async () => { await process.dispose('caller'); await process.waitForSettlement(); },
    });
  } finally { if (!transferred) await input.launch.release(); }
}
