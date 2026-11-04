import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ApiMachineClient } from '@/api/apiMachine';
import { env as hostEnvironment } from 'node:process';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { authorizeResolvedProjectExecLaunchForHost, spawnAuthorizedHostExecLaunchForHost,
  type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { SupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { createFilesystemEffectChannel, initializeFilesystemEffectChannel, type FilesystemEffectChannel } from './filesystemEffectChannel';
import type { FilesystemEffectConfiguration } from './filesystemEffectOperation';

const cleanupUnconfirmed = (cause?: unknown) => new PluginError({
  code: 'indeterminate', message: 'Native filesystem cleanup is unconfirmed',
}, { cause });

/** One accepted native operation over the incumbent Exec/frame/process owners.
 * The parent already selected its requester; this adapter never selects a UID,
 * reads Home, opens a listener, or lends daemon credentials to the worker. */
export async function prepareNativeFilesystemEffect(input: Readonly<{
  prepareNativeOperation: ApiMachineClient['prepareNativeOperation'];
  identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
  operationKey: string;
  configuration: FilesystemEffectConfiguration;
  signal: AbortSignal;
  ingress?: RpcHandlerContext;
  releaseRequester?: () => Promise<void>;
}>): Promise<FilesystemEffectChannel> {
  if (!input.operationKey) throw Object.assign(new Error('Filesystem operation custody is unavailable'),
    { code: 'filesystem_identity_custody_unavailable' });
  let material: AgentLaunchOperationMaterialization | undefined = Object.freeze({
    materializationKey: input.operationKey, environment: Object.freeze({}), selectedMaterials: Object.freeze([]),
  });
  let native: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>> | undefined;
  let process: SupervisedPluginProcess | undefined;
  let releaseLaunch: HostAuthorizedPluginExecLaunch['release'] | undefined;
  let initialized = false;
  let cleanup: Promise<void> | undefined;
  const assertOpen = () => { input.signal.throwIfAborted(); if (!material) throw new Error('Filesystem operation is closed'); };
  const dispose = () => cleanup ??= (async () => {
    if (process) {
      try {
        if (initialized) {
          // Channel disposal has sent EOF. Let the member finish its admitted
          // work and cleanup before verifying absence: the daemon's generic
          // terminator cannot signal a different Unix principal. Cancellation
          // still settles through the supervisor's existing uncertainty event.
          let unsubscribe = () => {};
          try {
            await Promise.race([process.handle.wait(), new Promise<never>((_resolve, reject) => {
              unsubscribe = process!.onOutcomeUncertain(reject);
            })]);
          } finally { unsubscribe(); }
        }
        await process.dispose();
      }
      catch (cause) {
        // An unconfirmed cleanup retains its material custody, but must still
        // settle the caller instead of awaiting a success-only settlement.
        throw cleanupUnconfirmed(cause);
      }
      const settlement = await process.waitForSettlement();
      if (settlement.remainder) throw cleanupUnconfirmed();
    }
    // Never release selected material while the physical child is unconfirmed.
    material = undefined;
    const released = await Promise.allSettled([Promise.resolve().then(() => releaseLaunch?.()),
      Promise.resolve().then(() => native?.dispose()), Promise.resolve().then(() => input.releaseRequester?.())]);
    const failure = released.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  })();
  try {
    assertOpen();
    native = await input.prepareNativeOperation({ requesterIdentity: input.identity,
      readMaterial: () => material,
      signal: input.signal, ...(input.ingress ? { ingress: input.ingress } : {}) });
    // Existing temp-file owners stay inside this selected operation directory;
    // a shared daemon-created system temp parent may be private to its UID.
    material = Object.freeze({ materializationKey: input.operationKey, selectedMaterials: Object.freeze([]),
      environment: Object.freeze({ TMPDIR: native.materialTarget.runtimeHome,
        TEMP: native.materialTarget.runtimeHome, TMP: native.materialTarget.runtimeHome }) });
    assertOpen();
    const installedBinary = native.agentIsolation.read()?.launch?.managedHappierBinaryPath;
    if (!installedBinary) throw Object.assign(new Error('Installed filesystem executable is unavailable'),
      { code: 'filesystem_identity_custody_unavailable' });
    const launch = await authorizeResolvedProjectExecLaunchForHost({
      launch: { command: installedBinary, args: ['filesystem-effect'],
        cwd: native.workingDirectory,
        // Discovery uses the same selected PATH as native Exec; Account and
        // Happier configuration remain owned by the member's native home.
        env: hostEnvironment.PATH === undefined ? {} : { PATH: hostEnvironment.PATH } },
      agentIsolation: native.agentIsolation, requesterIdentity: input.identity, agentLaunchKind: 'exec',
      signal: input.signal, assertCurrent: assertOpen,
    });
    releaseLaunch = launch.release;
    assertOpen();
    process = spawnAuthorizedHostExecLaunchForHost({ ...launch, maxStdoutBytes: 0, maxStderrBytes: 0,
      waitForGracefulRootExitBeforeTreeStop: true }, { signal: input.signal,
      retainLaunch: release => { releaseLaunch = release; } });
    const channel = createFilesystemEffectChannel({ input: process.child.stdin, output: process.child.stdout,
      signal: input.signal, dispose });
    try { await initializeFilesystemEffectChannel(channel, input.configuration); initialized = true; }
    catch (error) { await channel.dispose(); throw error; }
    return channel;
  } catch (error) { await dispose(); throw error; }
}
