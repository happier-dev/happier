import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/runtime/isolation/types';

export type ExecutionRunBackendStartContext = Readonly<{
  intentInput?: unknown;
  retentionPolicy?: string;
  intent?: string;
}>;

export type ExecutionRunBackendIsolation = Readonly<{
  env?: Record<string, string>;
  settingsPath?: string;
}>;

export type ExecutionRunBackendFactoryOptions = Readonly<{
  cwd: string;
  backendId: string;
  modelId?: string;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  permissionHandler: AcpPermissionHandler;
  start?: ExecutionRunBackendStartContext | null;
  isolation?: ExecutionRunBackendIsolation;
}>;

export type ExecutionRunBackendFactory = (opts: ExecutionRunBackendFactoryOptions) => ExecutionRunHostRuntime;

export type ExecutionRunBackendDescriptor = Readonly<{
  factory: ExecutionRunBackendFactory;
  resolveIsolation?: (request: BackendIsolationRequest, baseBundle: BackendIsolationBundle) => BackendIsolationBundle;
}>;
