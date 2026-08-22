import type { AcpConfigOptionOverridesV1, ConnectedServiceBindingsV1, ProviderBoundModelRef } from '@happier-dev/protocol';

import type { ExecutionRunState } from './executionRunTypes';

/**
 * ONE backend rehydration owner for execution-run resume (LC-F2).
 *
 * Start owns a rich launch specification; every backend recreation on resume must rebuild from that
 * SAME specification instead of a lossy, defaulted reconstruction. This owner reads the run's
 * immutable launch record and returns exactly what a recreated backend needs re-applied: model,
 * canonical config overrides (e.g. reasoning effort), and the persisted connected-service SELECTION.
 *
 * In dev's architecture connected services are materialized DAEMON-side from the selection at backend
 * spawn (fail-closed there): so this owner threads the persisted selection through as `connectedServices`
 * — the daemon re-materializes the exact same account/profile and refuses to start on the wrong
 * (inherited) account. A resumable run bound to a connected account therefore never silently recreates
 * on ambient/native auth. Passing `null` preserves an explicit native (opt-out) selection.
 */
export type ExecutionRunResumeBackendOptions = Readonly<{
  modelId?: string;
  modelSelection?: ProviderBoundModelRef;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  connectedServices?: ConnectedServiceBindingsV1 | null;
}>;

export function resolveExecutionRunResumeBackendOptions(args: Readonly<{
  run: ExecutionRunState | null;
}>): ExecutionRunResumeBackendOptions {
  const launch = args.run?.launch ?? null;
  if (!launch) return {};
  return {
    ...(launch.modelId ? { modelId: launch.modelId } : {}),
    ...(launch.modelSelection ? { modelSelection: launch.modelSelection } : {}),
    ...(launch.sessionConfigOptionOverrides
      ? { sessionConfigOptionOverrides: launch.sessionConfigOptionOverrides }
      : {}),
    ...(launch.connectedServicesSelection !== undefined
      ? { connectedServices: launch.connectedServicesSelection }
      : {}),
  };
}
