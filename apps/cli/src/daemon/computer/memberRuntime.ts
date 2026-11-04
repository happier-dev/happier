import { randomUUID } from 'node:crypto';
import { env as hostEnvironment } from 'node:process';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity,
  resolveHostRequesterAgentPlacementForHost } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { authorizeResolvedProjectExecLaunchForHost, spawnAuthorizedHostExecLaunchForHost,
  type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { SupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import type { ManagedComputerDriver } from './driver/managedComputerDriver';
import type { ComputerDesktopConnection } from './desktop';
import type { ComputerProviderIdV1 } from '@happier-dev/protocol/computer/v1';
import { createMemberComputerRuntimeChannel, memberComputerUnavailable } from './memberRuntimeProtocol';

export type MemberComputerRuntime = Readonly<{
  connection: ComputerDesktopConnection;
  createDriver(parameters: Readonly<{ executablePath: string; provider: ComputerProviderIdV1 }>): Promise<ManagedComputerDriver>;
  dispose(): Promise<void>;
}>;

/** The route has selected placement and person. Native preparation/Exec retain
 * their existing authority; this adapter only gives the desktop a private child. */
export async function prepareMemberComputerRuntime(input: Readonly<{
  prepareNativeOperation: ApiMachineClient['prepareNativeOperation'];
  identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
  placement: ReturnType<typeof resolveHostRequesterAgentPlacementForHost>;
  agentIsolation?: HostAgentIsolationLaunchContext;
  signal?: AbortSignal;
  ingress?: RpcHandlerContext;
}>): Promise<MemberComputerRuntime> {
  const signal = input.signal ?? new AbortController().signal;
  const materializationKey = randomUUID();
  let material: AgentLaunchOperationMaterialization | undefined = Object.freeze({
    materializationKey, selectedMaterials: Object.freeze([]), environment: Object.freeze({}),
  });
  let native: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>> | undefined;
  let processHandle: SupervisedPluginProcess | undefined;
  let releaseLaunch: HostAuthorizedPluginExecLaunch['release'] | undefined;
  let disposal: Promise<void> | undefined;
  const assertOpen = () => { signal.throwIfAborted(); if (!material) throw memberComputerUnavailable(); };
  const dispose = () => disposal ??= (async () => {
    if (processHandle) {
      let unsubscribe = () => {};
      try {
        // The channel has sent EOF. Cleanup runs inside the selected uid before
        // the supervisor proves absence; the daemon cannot signal a member uid.
        await Promise.race([processHandle.handle.wait(), new Promise<never>((_resolve, reject) => {
          unsubscribe = processHandle!.onOutcomeUncertain(reject);
        })]);
        await processHandle.dispose();
        if ((await processHandle.waitForSettlement()).remainder) throw memberComputerUnavailable();
      } catch (cause) {
        throw new PluginError({ code: 'indeterminate', message: 'Member desktop cleanup is unconfirmed' }, { cause });
      } finally { unsubscribe(); }
    }
    material = undefined;
    const results = await Promise.allSettled([Promise.resolve().then(() => releaseLaunch?.()),
      Promise.resolve().then(() => native?.dispose())]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  })();
  let channel: ReturnType<typeof createMemberComputerRuntimeChannel> | undefined;
  try {
    assertOpen();
    let agentIsolation = input.agentIsolation;
    let launchSpec: { filePath: string; args: readonly string[]; env?: NodeJS.ProcessEnv };
    if (input.placement === 'daemon') {
      // Source and installed hosts share the binary-safe Happier launch owner.
      launchSpec = buildHappyCliSubprocessLaunchSpec(['computer-effect']);
    } else {
      native = await input.prepareNativeOperation({ requesterIdentity: input.identity,
        resolveRequesterIdentity: async () => input.identity, readMaterial: () => material, signal,
        ...(input.ingress ? { ingress: input.ingress } : {}) });
      material = Object.freeze({ materializationKey, selectedMaterials: Object.freeze([]), environment: Object.freeze({
        TMPDIR: native.materialTarget.runtimeHome, TEMP: native.materialTarget.runtimeHome, TMP: native.materialTarget.runtimeHome,
      }) });
      agentIsolation = native.agentIsolation;
      const binary = native.agentIsolation.read()?.launch?.managedHappierBinaryPath;
      if (!binary) throw memberComputerUnavailable();
      launchSpec = { filePath: binary, args: ['computer-effect'] };
    }
    assertOpen();
    const environment: Record<string, string> = hostEnvironment.PATH === undefined ? {} : { PATH: hostEnvironment.PATH };
    for (const [key, value] of Object.entries(launchSpec.env ?? {})) if (value !== undefined) environment[key] = value;
    const launch = await authorizeResolvedProjectExecLaunchForHost({ launch: { command: launchSpec.filePath,
      args: launchSpec.args, cwd: native?.workingDirectory, env: environment }, agentIsolation,
      requesterIdentity: input.identity, agentLaunchKind: 'exec', signal, assertCurrent: assertOpen });
    releaseLaunch = launch.release;
    assertOpen();
    // Lifetime cancellation closes the private protocol first, rather than
    // asking the daemon to kill processes it cannot signal under member uid.
    processHandle = spawnAuthorizedHostExecLaunchForHost({ ...launch, maxStdoutBytes: 0, maxStderrBytes: 0,
      waitForGracefulRootExitBeforeTreeStop: true }, { retainLaunch: release => { releaseLaunch = release; } });
    channel = createMemberComputerRuntimeChannel({ input: processHandle.child.stdin, output: processHandle.child.stdout,
      signal, dispose });
    const connection = await channel.initialize(native?.materialTarget.runtimeHome);
    return { connection, createDriver: channel.createDriver, dispose: channel.dispose };
  } catch (error) {
    if (channel) await channel.dispose();
    else { processHandle?.child.stdin.end(); await dispose(); }
    throw error;
  }
}
