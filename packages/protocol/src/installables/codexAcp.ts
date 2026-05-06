import type { CapabilityId } from '../capabilities.js';
import { InstallableDependencyDescriptorSchema } from './descriptor.js';

export const INSTALLABLE_KEYS = {
  CODEX_ACP: 'codex-acp',
  GH: 'gh',
  AZ: 'az',
} as const;

export type InstallableKey = string;

export const CODEX_ACP_DEP_ID = 'dep.codex-acp' as const satisfies CapabilityId;
export const CODEX_ACP_DIST_TAG = 'latest' as const;

export const CODEX_ACP_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: INSTALLABLE_KEYS.CODEX_ACP,
  key: INSTALLABLE_KEYS.CODEX_ACP,
  kind: 'dep',
  version: '1',
  capabilityId: CODEX_ACP_DEP_ID,
  display: {
    name: 'Codex ACP',
  },
  description: 'Codex ACP dependency used by the Codex ACP backend',
  source: {
    kind: 'github_release_binary',
    repo: 'zed-industries/codex-acp',
    distTag: CODEX_ACP_DIST_TAG,
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
