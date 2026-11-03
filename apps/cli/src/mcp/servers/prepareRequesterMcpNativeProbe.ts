import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { McpServerConfig } from '@/agent';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import type { AgentLaunchSelectedMaterial } from '@/daemon/agentIsolation/agentLaunchFrame';
import { authorizeResolvedProjectExecLaunchForHost, spawnAuthorizedHostExecLaunchForHost,
  type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { SupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { createSupervisedMcpStdioTransport } from '@/mcp/runtime/supervisedStdioTransport';
import { McpServerProbeError, probeMcpStdioServerTools } from './probeMcpStdioServerTools';
import { logger } from '@/ui/logger';

type NativeProbePhase = 'requester_mcp_native_admission' | 'requester_mcp_native_material'
  | 'requester_mcp_native_launch' | 'requester_mcp_native_settlement';
function diagnostic(code: 'agent_isolation_unavailable' | 'indeterminate' | 'requester_material_cleanup_failed', phase: NativeProbePhase): void {
  try { logger.warnLocalFile('[MCP] Native Test refused', { code, phase }); }
  catch { /* Diagnostics never replace the primary typed error. */ }
}
function unavailable(phase: NativeProbePhase) {
  diagnostic('agent_isolation_unavailable', phase);
  return Object.assign(new PluginError({ code: 'agent_isolation_unavailable', message: 'Requester native MCP Test is unavailable',
    retryable: false, details: { phase, reason: 'requester_authority_unavailable' } }), { rpcErrorCode: 'agent_isolation_unavailable' });
}

/** Private finite composition of the SAME admitted Machine/native invocation.
 * It owns no process registry, Session, credential issuer or new Stop authority. */
export function prepareRequesterMcpNativeProbe(input: Readonly<{
  ingress: RpcHandlerContext;
  requesterIdentity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
  assertCurrent(): Promise<void>;
  preparedNative: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>>;
  materializationKey: string;
  replaceMaterial(material: AgentLaunchOperationMaterialization | undefined): void;
}>) {
  const action = input.ingress.localActionContext;
  const operationOwner = action?.operationOwnerUpdate;
  const cancellation = action?.operationCancellation;
  // Native identity and destination were selected by the parent before any
  // catalog or secret read. This adapter consumes that exact admitted target.
  const target = input.preparedNative.materialTarget;
  const environment = Object.freeze({ ...(input.preparedNative.agentIsolation.read()?.launch?.environment ?? {}) });
  let invoked = false;
  const probe = async (params: Readonly<{
    config: McpServerConfig;
    selectedMaterials: readonly AgentLaunchSelectedMaterial[];
    directory: string;
    sanitizeDiagnosticText?: Parameters<typeof probeMcpStdioServerTools>[0]['sanitizeDiagnosticText'];
    createDiagnosticStreamingSanitizer?: Parameters<typeof probeMcpStdioServerTools>[0]['createDiagnosticStreamingSanitizer'];
  }>) => {
    await input.assertCurrent();
    if (invoked) throw unavailable('requester_mcp_native_admission');
    invoked = true;
    let live = true;
    let material: AgentLaunchOperationMaterialization | undefined = Object.freeze({
      materializationKey: input.materializationKey, environment: Object.freeze({ ...(params.config.env ?? {}) }),
      selectedMaterials: Object.freeze(params.selectedMaterials.map(file => Object.freeze({ ...file }))),
    });
    input.replaceMaterial(material);
    // Only producer-selected frame files can become the launcher's pointers.
    for (const key of ['HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE', 'HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE']) {
      const value = material.environment[key];
      if (value !== undefined && !material.selectedMaterials.some(file => join(target.runtimeHome, file.relativePath) === value))
        throw unavailable('requester_mcp_native_material');
    }
    const custody: {
      supervised?: SupervisedPluginProcess;
      releaseLaunch?: HostAuthorizedPluginExecLaunch['release'];
      detachStop?: () => void;
      detachUncertainty?: () => void;
      uncertain: boolean;
    } = { uncertain: false };
    let primaryFailure: unknown;
    const assertOpen = () => {
      input.ingress.signal.throwIfAborted();
      if (!live || !material) throw unavailable('requester_mcp_native_launch');
    };
    try {
      // Only retained local lifetime and cancellation are inspected; protocol
      // envelopes never repeat Home admission or material-owner selection.
      const assertCurrent = async () => { assertOpen(); await input.assertCurrent(); assertOpen(); };
      return await probeMcpStdioServerTools({ config: params.config, baseEnv: {}, signal: input.ingress.signal,
        assertCurrent, sanitizeDiagnosticText: params.sanitizeDiagnosticText,
        createDiagnosticStreamingSanitizer: params.createDiagnosticStreamingSanitizer,
        prepareTransport: async () => {
          await assertCurrent();
          // The parent already admitted this operation and retained its Account
          // material owner; protocol envelopes never repeat preparation.
          const launch = await authorizeResolvedProjectExecLaunchForHost({
            launch: { command: params.config.command, args: params.config.args ?? [], cwd: params.directory, env: {} },
            agentIsolation: input.preparedNative.agentIsolation, requesterIdentity: input.requesterIdentity, agentLaunchKind: 'exec',
            signal: input.ingress.signal, assertCurrent: assertOpen });
          custody.releaseLaunch = launch.release;
          await assertCurrent();
          custody.supervised = spawnAuthorizedHostExecLaunchForHost({ ...launch, maxStdoutBytes: 0, maxStderrBytes: 0,
            waitForGracefulRootExitBeforeTreeStop: true }, { signal: input.ingress.signal, retainLaunch: release => { custody.releaseLaunch = release; } });
          const process = custody.supervised;
          custody.detachUncertainty = process.onOutcomeUncertain(() => {
            custody.uncertain = true;
            diagnostic('indeterminate', 'requester_mcp_native_settlement');
            operationOwner?.update({ cancellation: 'supported', outcome: { ok: false, errorCode: 'indeterminate', error: 'Native MCP cleanup is unconfirmed' },
              observation: { kind: 'outcome_uncertain', code: 'indeterminate' } });
          });
          custody.detachStop = cancellation?.onRequest(() => { void process.dispose().catch(() => undefined); });
          operationOwner?.update({ cancellation: 'supported' });
          return { transport: createSupervisedMcpStdioTransport(process), stderr: process.child.stderr };
        },
      });
    } catch (error) {
      const primary = error instanceof McpServerProbeError && error.cause instanceof PluginError ? error.cause : error;
      primaryFailure = primary;
      diagnostic('agent_isolation_unavailable', 'requester_mcp_native_launch');
      input.ingress.signal.throwIfAborted();
      throw primary;
    } finally {
      if (custody.supervised) {
        // Do not release private input before this supervisor confirms physical
        // settlement, including when an existing caller supplies cancellation.
        try { await custody.supervised.dispose(); } catch { /* Same supervisor publishes uncertainty above. */ }
        const settlement = await custody.supervised.waitForSettlement();
        if (settlement.remainder) {
          diagnostic('indeterminate', 'requester_mcp_native_settlement');
          throw new PluginError({ code: 'indeterminate', message: 'Native MCP cleanup is unconfirmed', retryable: false,
            details: { phase: 'requester_mcp_native_settlement' } });
        }
      }
      live = false;
      material = undefined;
      input.replaceMaterial(undefined);
      let releaseFailed = false;
      try { await custody.releaseLaunch?.(); } catch { releaseFailed = true; }
      custody.detachStop?.(); custody.detachUncertainty?.();
      if (custody.uncertain && !releaseFailed) operationOwner?.update({ outcome: { ok: true, result: null }, observation: null });
      if (releaseFailed) {
        diagnostic('requester_material_cleanup_failed', 'requester_mcp_native_settlement');
        if (primaryFailure === undefined) throw new PluginError({ code: 'requester_material_cleanup_failed',
          message: 'Native MCP material cleanup failed', retryable: false, details: { phase: 'requester_mcp_native_settlement' } });
      }
      if (primaryFailure === undefined) await input.assertCurrent();
    }
  };
  return Object.freeze({ target, environment, probe });
}
