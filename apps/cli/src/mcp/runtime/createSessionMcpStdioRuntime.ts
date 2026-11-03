import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { AgentIsolationMemberNativeIdentity } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import type { AgentLaunchMaterialization, AgentLaunchMaterializationTarget } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { captureAgentNativeLaunchAuthorityForHost, spawnAuthorizedHostExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createSupervisedMcpStdioTransport, type AdmittedMcpStdioRuntime } from './supervisedStdioTransport';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';

/** Configuration preparation precedes the incumbent invocation's Exec binding;
 * only a later custom-tool request can open its selected third-party process. */
export function createSessionMcpStdioRuntime(input: Readonly<{
  target: AgentLaunchMaterializationTarget;
  nativeIdentity: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>;
  environment: ProcessEnvInput;
  directory: string;
  signal: AbortSignal;
}>) {
  let service: ExecService | undefined;
  const unavailable = () => new PluginError({ code: 'agent_isolation_unavailable',
    message: 'Current Session native MCP execution is unavailable', retryable: false,
    details: { phase: 'native_execution_preparation' } });
  const bindExec = (next: ExecService) => {
    input.signal.throwIfAborted();
    service = next;
    return () => { if (service === next) service = undefined; };
  };
  const runtime: AdmittedMcpStdioRuntime = Object.freeze({
    target: input.target,
    environment: input.environment,
    async prepareTransport({ config, selectedMaterials, signal }) {
      const combined = signal ? AbortSignal.any([input.signal, signal]) : input.signal;
      combined.throwIfAborted();
      const current = service;
      if (!current) throw unavailable();
      const material: AgentLaunchMaterialization & Readonly<{
        nativeIdentity: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>;
      }> = Object.freeze({ ...input.target, nativeIdentity: input.nativeIdentity,
        environment: Object.freeze(buildScopedProcessEnv({ baseEnv: input.environment, explicitEnv: config.env })),
        selectedMaterials: Object.freeze(selectedMaterials.map(file => Object.freeze({ ...file }))),
      });
      const authority = captureAgentNativeLaunchAuthorityForHost(current, 'exec', combined, () => material);
      if (!authority) throw unavailable();
      const launch = await authority.authorize({ command: config.command,
        args: config.args ?? [], cwd: input.directory, env: {} }, combined);
      let release = launch.release;
      let supervised: ReturnType<typeof spawnAuthorizedHostExecLaunchForHost>;
      try {
        combined.throwIfAborted();
        supervised = spawnAuthorizedHostExecLaunchForHost({ ...launch,
          maxStdoutBytes: 0, maxStderrBytes: 0, waitForGracefulRootExitBeforeTreeStop: true },
        { signal: combined, retainLaunch: retained => { release = retained; } });
      } catch (error) { await release(); throw error; }
      const process = supervised;
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
  return Object.freeze({ runtime, bindExec });
}
