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

/**
 * The Git host a clone's account belongs to (lab F4): the managing Machine's SCM hosting providers that declare an
 * authentication service. A stored account keeps its own host; otherwise the first such host is offered.
 */
export function selectPresetGitHostingProvider(
  providers: readonly ScmProjectedHostingProvider[],
  gitAccount: QualifiedConnectedAccountRef | undefined,
): PresetGitHostingProvider | null {
  const withAuth = providers.filter(
    (provider): provider is PresetGitHostingProvider =>
      provider.authService !== null,
  );
  if (gitAccount) {
    const own = withAuth.find((provider) =>
      sameService(provider.authService, gitAccount.service),
    );
    if (own) return own;
  }
  return withAuth[0] ?? null;
}

/** The clone with the chosen account (or none): Happier keeps the credential and uses it to clone and push. */
export function withPresetGitAccount(
  value: GitCloneChoice,
  account: QualifiedConnectedAccountRef | null,
): GitCloneChoice {
  const { gitAccount: _previous, ...rest } = value;
  return account ? { ...rest, gitAccount: account } : rest;
}
