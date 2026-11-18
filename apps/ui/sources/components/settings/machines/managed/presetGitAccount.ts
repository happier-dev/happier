import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';

import type { ScmProjectedHostingProvider } from '@/scm/registry/scmContributionCatalog';

export type PresetGitHostingProvider = ScmProjectedHostingProvider &
  Readonly<{ authService: PluginContributionIdentityV1 }>;

type GitCloneChoice = Extract<SessionProjectFilesV1, { kind: 'git_clone' }>;

const sameService = (
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
) => left.pluginId === right.pluginId && left.localId === right.localId;

/** The hosts a clone can take an account from: the managing Machine's SCM hosting providers with an account service. */
export function presetGitHostingProviders(
  providers: readonly ScmProjectedHostingProvider[],
): PresetGitHostingProvider[] {
  return providers.filter(
    (provider): provider is PresetGitHostingProvider => provider.authService !== null,
  );
}

/**
 * The Git host a clone's account belongs to (lab F4). A stored account keeps its own host; otherwise the host the
 * row chose, else one the person already has an account for, else the canonical GitHub host, else the first offered.
 */
export function selectPresetGitHostingProvider(
  providers: readonly ScmProjectedHostingProvider[],
  gitAccount: QualifiedConnectedAccountRef | undefined,
  chosenHostId: string | null,
  hasAccount: (service: PluginContributionIdentityV1) => boolean,
): PresetGitHostingProvider | null {
  const hosts = presetGitHostingProviders(providers);
  const stored = gitAccount ? hosts.find((host) => sameService(host.authService, gitAccount.service)) : undefined;
  return stored
    ?? hosts.find((host) => host.id === chosenHostId)
    ?? hosts.find((host) => hasAccount(host.authService))
    // Provider kind is the canonical contribution fact; catalog order is not a product default.
    ?? hosts.find((host) => host.kind === 'github')
    ?? hosts[0]
    ?? null;
}

/** The clone with the chosen account (or none): Happier keeps the credential and uses it to clone and push. */
export function withPresetGitAccount(
  value: GitCloneChoice,
  account: QualifiedConnectedAccountRef | null,
): GitCloneChoice {
  const { gitAccount: _previous, ...rest } = value;
  return account ? { ...rest, gitAccount: account } : rest;
}
