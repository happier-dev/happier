import {
  isRuntimeTurnOperations,
  type RuntimeTurnOperations,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import type {
  AgentSessionConfigurationSnapshot,
  AgentAuthoredSessionRuntimeCapabilities,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { ProviderBindingLaunchHandoffV1 } from '@/plugins/runtime/providerBindings/handoff';
import type { HostSessionTerminalRemoteModeLoop } from './terminalRemoteModeRuntime';

export type HostSessionRuntimeFactoryResult<TNativeRuntime extends RuntimeTurnOperations> = Readonly<{
  operations: RuntimeTurnOperations;
  nativeRuntime?: TNativeRuntime | null;
  terminalRemoteModeLoop?: HostSessionTerminalRemoteModeLoop | null;
  /** Exact startup configuration admitted while the runtime was constructed. */
  configuration?: AgentSessionConfigurationSnapshot | null;
  /** Bounded Agent-owned identity resolved during Session open. */
  runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
  /** Live capability facts supplied by the concrete Agent Session runtime. */
  runtimeCapabilities?: AgentAuthoredSessionRuntimeCapabilities | null;
  /** Exact non-secret facts admitted while the runtime was constructed. */
  admittedProviderBindingHandoff?: ProviderBindingLaunchHandoffV1 | null;
}>;

export function resolveHostSessionRuntimeFactoryResult<TNativeRuntime extends RuntimeTurnOperations>(
  createdRuntime: HostSessionRuntimeFactoryResult<TNativeRuntime>,
): Readonly<{
  runtime: RuntimeTurnOperations;
  nativeRuntime: TNativeRuntime | null;
  terminalRemoteModeLoop: HostSessionTerminalRemoteModeLoop | null;
  configuration: AgentSessionConfigurationSnapshot | null;
  runtimeDescriptorV1: RuntimeDescriptorV1 | null;
  runtimeCapabilities: AgentAuthoredSessionRuntimeCapabilities | null;
  admittedProviderBindingHandoff: ProviderBindingLaunchHandoffV1 | null;
}> {
  if (!createdRuntime || typeof createdRuntime !== 'object' || !('operations' in createdRuntime)) {
    throw new Error('Shared host session runtime requires explicit operations/nativeRuntime binding');
  }
  if (!isRuntimeTurnOperations(createdRuntime.operations)) {
    throw new Error('Shared host session runtime requires RuntimeTurnOperations');
  }
  return {
    runtime: createdRuntime.operations,
    nativeRuntime: createdRuntime.nativeRuntime ?? null,
    terminalRemoteModeLoop: createdRuntime.terminalRemoteModeLoop ?? null,
    configuration: createdRuntime.configuration ?? null,
    runtimeDescriptorV1: createdRuntime.runtimeDescriptorV1 ?? null,
    runtimeCapabilities: createdRuntime.runtimeCapabilities ?? null,
    admittedProviderBindingHandoff:
      createdRuntime.admittedProviderBindingHandoff ?? null,
  };
}
