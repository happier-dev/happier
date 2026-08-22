import {
  isRuntimeTurnOperations,
  type RuntimeTurnOperations,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import type { ProviderBindingLaunchHandoffV1 } from '@/plugins/runtime/providerBindings/handoff';
import type { HostSessionTerminalRemoteModeLoop } from './terminalRemoteModeRuntime';

export type HostSessionRuntimeFactoryResult<TNativeRuntime extends RuntimeTurnOperations> = Readonly<{
  operations: RuntimeTurnOperations;
  nativeRuntime?: TNativeRuntime | null;
  terminalRemoteModeLoop?: HostSessionTerminalRemoteModeLoop | null;
  /** Exact non-secret facts admitted while the runtime was constructed. */
  admittedProviderBindingHandoff?: ProviderBindingLaunchHandoffV1 | null;
}>;

export function resolveHostSessionRuntimeFactoryResult<TNativeRuntime extends RuntimeTurnOperations>(
  createdRuntime: HostSessionRuntimeFactoryResult<TNativeRuntime>,
): Readonly<{
  runtime: RuntimeTurnOperations;
  nativeRuntime: TNativeRuntime | null;
  terminalRemoteModeLoop: HostSessionTerminalRemoteModeLoop | null;
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
    admittedProviderBindingHandoff:
      createdRuntime.admittedProviderBindingHandoff ?? null,
  };
}
