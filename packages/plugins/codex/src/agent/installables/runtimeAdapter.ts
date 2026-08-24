import type { ManagedDependencyDescriptor } from '@happier-dev/plugin-sdk/managed-services';

import {
  resolveCodexAcpSpawnWithOptions,
  type ResolveCodexAcpSpawnDeps,
  type ResolveCodexAcpSpawnOptions,
} from '../acp/command.js';
import {
  validateCodexAcpSpawnAvailability,
  type CodexAcpAvailabilityResult,
  type CodexAcpSpawnSpec,
} from '../acp/availability.js';

export const CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY = Object.freeze({
  kind: 'runtime_installable_adapter_v1',
  adapterId: 'codex-acp',
});

export type CodexAcpRuntimeInstallableAdapterPolicy =
  typeof CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY;

export type CodexAcpRuntimeInstallableDescriptor = ManagedDependencyDescriptor & Readonly<{
  runtimeInstallableAdapterPolicy: CodexAcpRuntimeInstallableAdapterPolicy;
}>;

export const CODEX_ACP_RUNTIME_INSTALLABLE_LAUNCH_HELPERS = Object.freeze({
  resolveSpawnSpec: (
    opts: ResolveCodexAcpSpawnOptions = {},
    deps: ResolveCodexAcpSpawnDeps = {},
  ): CodexAcpSpawnSpec => resolveCodexAcpSpawnWithOptions(opts, deps),
  validateAvailability: (
    spec: CodexAcpSpawnSpec,
    opts?: Readonly<{
      env?: NodeJS.ProcessEnv;
      existsSyncFn?: typeof import('node:fs').existsSync;
      accessSyncFn?: typeof import('node:fs').accessSync;
    }>,
  ): CodexAcpAvailabilityResult => validateCodexAcpSpawnAvailability(spec, opts),
});

export function hasCodexAcpRuntimeInstallableAdapterPolicy(
  descriptor: ManagedDependencyDescriptor,
): descriptor is CodexAcpRuntimeInstallableDescriptor {
  const policy = (descriptor as Readonly<{ runtimeInstallableAdapterPolicy?: unknown }>).runtimeInstallableAdapterPolicy;
  return Boolean(policy)
    && typeof policy === 'object'
    && !Array.isArray(policy)
    && (policy as Readonly<{ kind?: unknown }>).kind === CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY.kind
    && (policy as Readonly<{ adapterId?: unknown }>).adapterId === CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY.adapterId;
}
