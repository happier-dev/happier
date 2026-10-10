import type { ManagedDependencyDescriptor } from '@happier-dev/plugin-sdk/managed-services';
import { ManagedDependencyDescriptorSchema } from '@happier-dev/plugin-sdk/managed-services';
import { selectManagedDependencyReleaseAsset } from '@happier-dev/plugin-sdk/managed-services/native';
import { CODEX_ACP_MANAGED_DEPENDENCY } from './definition.js';
const { kind: _sourceKind, installId: _installId, ...codexAcpReleaseSource } = CODEX_ACP_MANAGED_DEPENDENCY.sources[0];

export type CodexAcpReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string | null;
  version: string | null;
}>;

export const CODEX_ACP_GITHUB_REPO = CODEX_ACP_MANAGED_DEPENDENCY.sources[0].repo;

export function resolveCodexAcpReleaseAsset(release: unknown): CodexAcpReleaseAsset {
  return selectManagedDependencyReleaseAsset(release, CODEX_ACP_MANAGED_DEPENDENCY.sources[0]);
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
    ...codexAcpReleaseSource,
    kind: 'github_release_binary',
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
    iconName: 'arrows-left-right',
  },
  stability: {
    experimental: true,
    supported: true,
  },
});

export const CODEX_ACP_INSTALLABLE_DESCRIPTOR: ManagedDependencyDescriptor =
  codexAcpInstallableDescriptorBase;
