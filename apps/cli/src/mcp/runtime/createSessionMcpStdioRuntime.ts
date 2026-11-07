import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { AgentIsolationMemberNativeIdentity } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import type { AgentLaunchMaterialization, AgentLaunchMaterializationTarget } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { captureAgentNativeLaunchAuthorityForHost, spawnAuthorizedHostExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createSupervisedMcpStdioTransport, type AdmittedMcpStdioRuntime } from './supervisedStdioTransport';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/machineEffectCli';
import { createFilesystemEffectChannel, initializeFilesystemEffectChannel,
  type FilesystemEffectChannel } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import type { FilesystemEffectConfiguration } from '@/rpc/handlers/fileSystem/filesystemEffectOperation';

/** The Session's incumbent Exec binding owns both selected MCP processes and
 * its host-private native filesystem pipe. Configuration alone cannot launch. */
export function createSessionMcpStdioRuntime(input: Readonly<{
  target: AgentLaunchMaterializationTarget;
  nativeIdentity: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>;
  environment: ProcessEnvInput;
  directory: string;
  signal: AbortSignal;
}>) {
  let service: ExecService | undefined;
  const unavailable = () => new PluginError({ code: 'agent_isolation_unavailable',
    message: 'Current Session native execution is unavailable', retryable: false,
    details: { phase: 'native_execution_preparation' } });
  const bindExec = (next: ExecService) => {
    input.signal.throwIfAborted();
    service = next;
    return () => { if (service === next) service = undefined; };
  };
  const openNativeProcess = async (request: Readonly<{
    command: string;
    args: readonly string[];
    environment: ProcessEnvInput;
    selectedMaterials: AgentLaunchMaterialization['selectedMaterials'];
    signal?: AbortSignal;
  }>) => {
    const combined = request.signal ? AbortSignal.any([input.signal, request.signal]) : input.signal;
    combined.throwIfAborted();
    const current = service;
    if (!current) throw unavailable();
    const material = Object.freeze({ ...input.target, nativeIdentity: input.nativeIdentity,
      environment: Object.freeze(buildScopedProcessEnv({ baseEnv: request.environment })),
      selectedMaterials: Object.freeze(request.selectedMaterials.map(file => Object.freeze({ ...file }))),
    });
    const authority = captureAgentNativeLaunchAuthorityForHost(current, 'exec', combined, () => material);
    if (!authority) throw unavailable();
    const launch = await authority.authorize({ command: request.command,
      args: request.args, cwd: input.directory, env: {} }, combined);
    let release = launch.release;
    try {
      combined.throwIfAborted();
      const process = spawnAuthorizedHostExecLaunchForHost({ ...launch,
        maxStdoutBytes: 0, maxStderrBytes: 0, waitForGracefulRootExitBeforeTreeStop: true },
      { signal: combined, retainLaunch: retained => { release = retained; } });
      return { process, signal: combined, release: async () => { await release(); } };
    } catch (error) { await release(); throw error; }
  };
  const runtime: AdmittedMcpStdioRuntime = Object.freeze({
    target: input.target,
    environment: input.environment,
    async prepareTransport({ config, selectedMaterials, signal }) {
      const { process, release } = await openNativeProcess({ command: config.command, args: config.args ?? [],
        environment: buildScopedProcessEnv({ baseEnv: input.environment, explicitEnv: config.env }), selectedMaterials, signal });
      let closing: Promise<void> | undefined;
      const transport = createSupervisedMcpStdioTransport({ ...process,
        dispose: () => closing ??= (async () => {
          await process.dispose();
          const settlement = await process.waitForSettlement();
          if (settlement.remainder) throw new PluginError({ code: 'indeterminate',
            message: 'Native MCP cleanup is unconfirmed', retryable: false,
            details: { phase: 'native_execution_settlement' } });
          await release();
        })(),
      });
      return { transport, stderr: process.child.stderr };
    },
  });
  const prepareFilesystemEffect = async (configuration: FilesystemEffectConfiguration,
    signal?: AbortSignal): Promise<FilesystemEffectChannel> => {
    const { process, release, signal: lifetime } = await openNativeProcess({
      command: resolveInstalledMachineEffectCli(), args: ['filesystem-effect'],
      environment: { HOME: input.nativeIdentity.home,
        ...(input.environment.PATH === undefined ? {} : { PATH: input.environment.PATH }),
        TMPDIR: input.target.runtimeHome, TEMP: input.target.runtimeHome, TMP: input.target.runtimeHome },
      selectedMaterials: [], signal,
    });
    let initialized = false;
    let closing: Promise<void> | undefined;
    const channel = createFilesystemEffectChannel({ input: process.child.stdin, output: process.child.stdout,
      signal: lifetime, dispose: () => closing ??= (async () => {
        // Channel disposal sends EOF first. Let the selected native member
        // close its descriptors before the existing supervisor settles it.
        try {
          if (initialized) {
            let unsubscribe = () => {};
            try {
              await Promise.race([process.handle.wait(), new Promise<never>((_resolve, reject) => {
                unsubscribe = process.onOutcomeUncertain(reject);
              })]);
            } finally { unsubscribe(); }
          }
          await process.dispose();
        } catch (cause) {
          throw new PluginError({ code: 'indeterminate',
            message: 'Native filesystem cleanup is unconfirmed', retryable: false,
            details: { phase: 'native_execution_settlement' } }, { cause });
        }
        const settlement = await process.waitForSettlement();
        if (settlement.remainder) throw new PluginError({ code: 'indeterminate',
          message: 'Native filesystem cleanup is unconfirmed', retryable: false,
          details: { phase: 'native_execution_settlement' } });
        await release();
      })(),
    });
    try { await initializeFilesystemEffectChannel(channel, configuration); initialized = true; return channel; }
    catch (error) { await channel.dispose(); throw error; }
  };
  return Object.freeze({ runtime, bindExec, prepareFilesystemEffect });
}
