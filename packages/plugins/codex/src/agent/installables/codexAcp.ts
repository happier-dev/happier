import type { ManagedDependencyDescriptor } from '@happier-dev/plugin-sdk/managed-services';
import { ManagedDependencyDescriptorSchema } from '@happier-dev/plugin-sdk/managed-services';

import {
  CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY,
  type CodexAcpRuntimeInstallableDescriptor,
} from './runtimeAdapter.js';

export {
  CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY,
  CODEX_ACP_RUNTIME_INSTALLABLE_LAUNCH_HELPERS,
  hasCodexAcpRuntimeInstallableAdapterPolicy,
} from './runtimeAdapter.js';
export type {
  CodexAcpRuntimeInstallableAdapterPolicy,
  CodexAcpRuntimeInstallableDescriptor,
} from './runtimeAdapter.js';

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
