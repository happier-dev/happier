import type { ManagedDependencyDescriptor } from '@happier-dev/plugin-sdk/managed-services';
import { ManagedDependencyDescriptorSchema } from '@happier-dev/plugin-sdk/managed-services';

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

const codexAcpInstallableDescriptorBase = ManagedDependencyDescriptorSchema.parse({
  id: 'codex-acp',
  key: 'codex-acp',
  kind: 'dep',
  version: '1',
  capabilityId: 'dep.codex-acp',
  display: {
    name: 'Codex ACP',
  },
  description: 'Codex ACP dependency used by the Codex ACP backend',
  source: {
    kind: 'github_release_binary',
    repo: 'zed-industries/codex-acp',
    distTag: 'latest',
  },
  binary: {
    commands: ['codex-acp'],
    systemFirst: true,
    managedFallback: true,
  },
  defaultPolicy: {
    autoInstallWhenNeeded: true,
    autoUpdateMode: 'auto',
  },
  consent: {
    install: 'not_required',
    update: 'not_required',
  },
  ui: {
    iconName: 'swap-horizontal-outline',
  },
  stability: {
    experimental: true,
    supported: true,
  },
});

export const CODEX_ACP_INSTALLABLE_DESCRIPTOR: CodexAcpRuntimeInstallableDescriptor = Object.freeze({
  ...codexAcpInstallableDescriptorBase,
  runtimeInstallableAdapterPolicy: CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY,
});
