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

/** One finite effect over the private frame pipe, to process settlement. The
 * caller's services receive the result; the incumbent supervisor owns the
 * launch once spawned. */
export async function runWorkspaceEffectChild(
  input: Readonly<{
    launch: HostAuthorizedPluginExecLaunch;
    signal: AbortSignal;
    /** Routing id for this one invocation. */
    id: string;
    effect: unknown;
    services: Readonly<Record<string, unknown>>;
    refusal(code: string): Error;
    beforeSpawn?(): Promise<void>;
  }>,
): Promise<WorkspaceEffectChildOutcome> {
  let transferred = false;
  try {
    await input.beforeSpawn?.();
    const process = spawnAuthorizedHostExecLaunchForHost(input.launch, {
      signal: input.signal,
    });
    transferred = true;
    const decoder = createBackgroundServiceProcessFrameDecoder();
    let failure: unknown;
    let settled = false;
    const send = (value: unknown) => {
      process.child.stdin.write(encodeBackgroundServiceProcessFrame(value));
    };
    const services = createBackgroundServiceProcessServiceHost({
      signal: input.signal,
      services: input.services,
      send: (message) => send({ kind: 'services', message }),
    });
    const receive = (chunk: Buffer) => {
      try {
        for (const raw of decoder.push(chunk)) {
          const message = parseBackgroundServiceProcessMessage(raw);
          if (message.kind === 'services') {
            services.receive(message.message);
            continue;
          }
          if (message.kind === 'settled' && message.id === input.id) {
            settled = true;
            process.child.stdin.end();
            continue;
          }
          if (message.kind === 'failed' && message.id === input.id) {
            failure = input.refusal(message.error.code);
            process.child.stdin.end();
            continue;
          }
          throw input.refusal('workspace_effect_protocol_invalid');
        }
      } catch (error) {
        failure = error;
        void process.dispose('caller');
      }
    };
    process.child.stdout.on('data', receive);
    process.child.stdin.on('error', () => {}); // The physical outcome below owns failed writes.
    try {
      send({
        kind: 'run',
        id: input.id,
        context: input.effect,
        services: services.description,
      });
      const completed = await process.handle.wait();
      // Root exit is not descendant settlement; the incumbent supervisor's disposal owns that proof.
      await process.dispose('caller');
      await process.waitForSettlement();
      return {
        settled,
        ...(failure !== undefined ? { failure } : {}),
        exitedCleanly:
          completed.termination.observed.kind === 'exit' &&
          completed.termination.observed.exitCode === 0,
      };
    } finally {
      process.child.stdout.off('data', receive);
      await services.dispose();
      await process.dispose('caller');
      await process.waitForSettlement();
    }
  } finally {
    if (!transferred) await input.launch.release();
  }
}
