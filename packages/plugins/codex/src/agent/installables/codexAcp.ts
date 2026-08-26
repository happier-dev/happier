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

/**
 * Codex owns the Agent-specific launch semantics. The host-owned Codex ACP
 * installable adapter calls these helpers for the one `codex-acp` installable.
 */
export const CODEX_ACP_RUNTIME_LAUNCH_HELPERS = Object.freeze({
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

export const CODEX_ACP_INSTALLABLE_DESCRIPTOR: ManagedDependencyDescriptor =
  codexAcpInstallableDescriptorBase;
