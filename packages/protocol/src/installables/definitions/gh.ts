import type { CapabilityId } from '../../capabilities/index.js';
import { InstallableDependencyDescriptorSchema } from '../descriptor.js';

export const GH_INSTALLABLE_KEY = 'gh' as const;
export const GH_DEP_ID = 'dep.gh' as const satisfies CapabilityId;
export const GH_GITHUB_REPO = 'cli/cli' as const;
export const GH_DIST_TAG = 'latest' as const;
export const GH_BINARY_NAME = 'gh' as const;

export const GH_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: GH_INSTALLABLE_KEY,
  key: GH_INSTALLABLE_KEY,
  kind: 'dep',
  version: '1',
  capabilityId: GH_DEP_ID,
  display: {
    name: 'GitHub CLI',
    subtitle: 'Optional dependency for GitHub repository and pull request workflows',
  },
  description: 'GitHub CLI dependency used by source-control provider adapters when explicitly enabled.',
  source: {
    kind: 'github_release_binary',
    repo: GH_GITHUB_REPO,
    distTag: GH_DIST_TAG,
  },
  binary: {
    commands: [GH_BINARY_NAME],
    systemFirst: true,
    managedFallback: true,
    platforms: ['darwin', 'linux', 'win32'],
    arches: ['arm64', 'x64'],
  },
  defaultPolicy: {
    autoInstallWhenNeeded: false,
    autoUpdateMode: 'notify',
  },
  consent: {
    install: 'required',
    update: 'required',
  },
  ui: {
    setupUrl: 'https://cli.github.com/',
    iconName: 'logo-github',
  },
  stability: {
    experimental: false,
    supported: true,
  },
});
