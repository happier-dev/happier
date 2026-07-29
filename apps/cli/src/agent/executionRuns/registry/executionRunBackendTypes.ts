import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/packagedRuntime/isolation/types';
import type {
  ExecutionRunIntentStartPreflightParams,
  ExecutionRunStartIntentPolicyResult,
} from '@/agent/executionRuns/policy/executionRunStartPreflight';

export type ExecutionRunBackendStartContext = Readonly<{
  intentInput?: unknown;
  retentionPolicy?: string;
  intent?: string;
  profileId?: string;
}>;

export type ExecutionRunBackendIsolation = Readonly<{
  env?: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  settingsPath?: string;
}>;

export type ExecutionRunBackendFactoryOptions = Readonly<{
  cwd: string;
  backendId: string;
  modelId?: string;
  /**
   * Canonical agent config-option overrides (e.g. reasoning effort) for the run backend, mirroring
   * session spawn. Provider-specific application is plugin-owned; a plugin that does not read this
   * simply falls back to today's defaults (fail-safe on omission).
   */
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  permissionHandler: AcpPermissionHandler;
  start?: ExecutionRunBackendStartContext | null;
  isolation?: ExecutionRunBackendIsolation;
}>;

export type ExecutionRunBackendFactory = (opts: ExecutionRunBackendFactoryOptions) => ExecutionRunHostRuntime;
export type ExecutionRunBackendStartPreflight = (
  params: ExecutionRunIntentStartPreflightParams,
) => Promise<ExecutionRunStartIntentPolicyResult>;

export type ExecutionRunBackendDescriptor = Readonly<{
  factory: ExecutionRunBackendFactory;
  startPreflight?: ExecutionRunBackendStartPreflight;
  resolveIsolation?: (request: BackendIsolationRequest, baseBundle: BackendIsolationBundle) => BackendIsolationBundle;
}>;
