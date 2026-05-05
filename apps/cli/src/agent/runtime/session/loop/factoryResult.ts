import {
  isRuntimeTurnOperations,
  type RuntimeTurnOperations,
} from '@/agent/runtime/turns/runtimeTurnOperations';

export type HostSessionRuntimeFactoryResult<TNativeRuntime extends RuntimeTurnOperations> = Readonly<{
  operations: RuntimeTurnOperations;
  nativeRuntime?: TNativeRuntime | null;
}>;

export function resolveHostSessionRuntimeFactoryResult<TNativeRuntime extends RuntimeTurnOperations>(
  createdRuntime: HostSessionRuntimeFactoryResult<TNativeRuntime>,
): Readonly<{ runtime: RuntimeTurnOperations; nativeRuntime: TNativeRuntime | null }> {
  if (!createdRuntime || typeof createdRuntime !== 'object' || !('operations' in createdRuntime)) {
    throw new Error('Shared host session runtime requires explicit operations/nativeRuntime binding');
  }
  if (!isRuntimeTurnOperations(createdRuntime.operations)) {
    throw new Error('Shared host session runtime requires RuntimeTurnOperations');
  }
  return {
    runtime: createdRuntime.operations,
    nativeRuntime: createdRuntime.nativeRuntime ?? null,
  };
}
