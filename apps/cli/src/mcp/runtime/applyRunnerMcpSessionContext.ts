import type { Metadata, PermissionMode } from '@/api/types';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

export type RunnerMcpSessionContextAccessors = Readonly<{
  getPermissionMode?: (() => PermissionMode | null | undefined) | null;
  getBackendTarget?: (() => BackendTargetRefV2 | null | undefined) | null;
  getCurrentSessionLocation?: (() => Readonly<{
    path?: string | null;
    host?: string | null;
    machineId?: string | null;
  }> | null | undefined) | null;
}>;

export type RunnerMcpSessionWithContext<TSession> = TSession & {
  getMetadataSnapshot?: () => Metadata | null;
  getPermissionMode?: () => PermissionMode | null | undefined;
  getBackendTarget?: () => BackendTargetRefV2 | null | undefined;
  getCurrentSessionLocation?: () => Readonly<{
    path?: string | null;
    host?: string | null;
    machineId?: string | null;
  }> | null | undefined;
};

export function applyRunnerMcpSessionContext<TSession extends object>(
  session: TSession,
  accessors: RunnerMcpSessionContextAccessors,
): RunnerMcpSessionWithContext<TSession> {
  const target = session as RunnerMcpSessionWithContext<TSession>;
  if (accessors.getPermissionMode) {
    target.getPermissionMode = accessors.getPermissionMode;
  }
  if (accessors.getBackendTarget) {
    target.getBackendTarget = accessors.getBackendTarget;
  }
  if (accessors.getCurrentSessionLocation) {
    target.getCurrentSessionLocation = accessors.getCurrentSessionLocation;
  }
  return target;
}
