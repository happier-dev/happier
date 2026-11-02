import {
  PluginError,
  selectCurrentTargetedContribution,
  type TargetedContributionSnapshot,
  type TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';

import type { ChannelsProviderContributionV1 } from './manifest.js';
import type { PersistedConversationProviderContributionSelection } from './collections.js';

type ProviderContributionReadContext = Readonly<{
  targetedContributions: TargetedContributionsService;
  signal: AbortSignal;
}>;

/**
 * Daemon provider discovery reads the live point from the one `definePlugin`
 * composition. Invocation-time loading keeps the manifest ↔ handler import
 * cycle initialization-safe. Browser surfaces consume portable declarations
 * and delivery projections without reaching this daemon selection owner.
 */
type ChannelsManifestModule = typeof import('./manifest.js');

let channelsManifestModulePromise: Promise<ChannelsManifestModule> | undefined;

async function readChannelsProviderPointRef(): Promise<ChannelsManifestModule['CHANNELS_PROVIDER_POINT_REF']> {
  channelsManifestModulePromise ??= import('./manifest.js');
  return (await channelsManifestModulePromise).CHANNELS_PROVIDER_POINT_REF;
}


type ProviderContributionUnavailableReason =
  | 'selectionInvalid'
  | 'targetSourceChanged'
  | 'selectedContributorMissing'
  | 'persistedProviderMissing'
  | 'persistedProviderAmbiguous';

/** A successful selection/snapshot proves non-current authority, unlike a failed read. */
export class ConversationProviderContributionNotCurrentError extends PluginError {}

function unavailableProviderContribution(
  reason: ProviderContributionUnavailableReason,
  message: string,
): ConversationProviderContributionNotCurrentError {
  return new ConversationProviderContributionNotCurrentError({
    code: reason === 'persistedProviderAmbiguous'
      ? 'channels_provider_contribution_ambiguous'
      : 'channels_provider_contribution_unavailable',
    message,
    retryable: true,
    details: { reason },
  });
}

function unavailableSelectedProviderContribution(
  reason: 'selection_invalid' | 'target_source_stale' | 'contributor_unavailable',
): PluginError {
  switch (reason) {
    case 'selection_invalid':
      return unavailableProviderContribution(
        'selectionInvalid',
        'Conversation provider selection does not address the Channels provider contribution point.',
      );
    case 'target_source_stale':
      return unavailableProviderContribution(
        'targetSourceChanged',
        'Conversation provider selection was made for a retired Channels target source.',
      );
    case 'contributor_unavailable':
      return unavailableProviderContribution(
        'selectedContributorMissing',
        'The selected conversation provider contribution is no longer admitted from its selected source.',
      );
  }
}

function hasCurrentPointProtocol(
  contribution: ChannelsProviderContributionV1,
  point: ChannelsManifestModule['CHANNELS_PROVIDER_POINT_REF'],
): boolean {
  return contribution.protocol.id === point.protocol.id
    && contribution.protocol.version === point.protocol.version;
}

async function readCurrentProviderSnapshot(
  context: ProviderContributionReadContext,
): Promise<TargetedContributionSnapshot<ChannelsProviderContributionV1>> {
  const observation = context.targetedContributions.observeForSelf(
    await readChannelsProviderPointRef(),
    { onInvalidated: () => {} },
  );
  try {
    return await observation.readCurrent({ signal: context.signal });
  } finally {
    observation.dispose();
  }
}

/**
 * Resolves exactly the contributor chosen by a current caller selection. The
 * host admission snapshot owns contributor currentness; this owner never
 * broadens a missing selection into a plugin-wide fallback.
 */
export async function readSelectedCurrentProviderContribution(input: Readonly<{
  context: ProviderContributionReadContext;
  selection: PluginTargetedContributionSelectionV1;
}>): Promise<ChannelsProviderContributionV1> {
  const result = await selectCurrentTargetedContribution({
    service: input.context.targetedContributions,
    point: await readChannelsProviderPointRef(),
    selection: input.selection,
    signal: input.context.signal,
  });
  if (result.kind === 'selected') return result.contribution;

  throw unavailableSelectedProviderContribution(result.reason);
}

/** The PR-link feature selects the single admitted GitHub Channels contributor. */
export async function readSessionPullRequestProviderSelection(context: ProviderContributionReadContext): Promise<PluginTargetedContributionSelectionV1> {
  const point = await readChannelsProviderPointRef();
  const snapshot = await readCurrentProviderSnapshot(context);
  const matches = snapshot.contributions.filter((entry) => hasCurrentPointProtocol(entry, point)
    && entry.contributor.pluginId === 'happier.scm.forge.github');
  if (matches.length !== 1) throw unavailableProviderContribution('persistedProviderMissing', 'The GitHub Channel provider is unavailable.');
  return {
    target: { pluginId: 'happier.channels', sourceCustody: snapshot.sourceCustody },
    point: { pointId: 'providers', protocol: point.protocol },
    contributor: { pluginId: matches[0]!.contributor.pluginId, contributionId: matches[0]!.contributor.contributionId, sourceCustody: matches[0]!.contributor.sourceCustody },
  };
}

/**
 * Resolves the exact contribution retained by a durable connection against the
 * current target-owned admission snapshot. Durable state never retains an
 * Action or materialization identity, and this owner intentionally provides no
 * plugin-wide fallback when the selected contribution has retired.
 */
export async function readCurrentProviderContributionForPersistedSelection(input: Readonly<{
  context: ProviderContributionReadContext;
  providerPluginId: string;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
}>): Promise<ChannelsProviderContributionV1> {
  const point = await readChannelsProviderPointRef();
  const snapshot = await readCurrentProviderSnapshot(input.context);
  const matches = snapshot.contributions.filter((contribution) => (
    hasCurrentPointProtocol(contribution, point)
    && contribution.contributor.pluginId === input.providerPluginId
    && contribution.contributor.contributionId
      === input.providerContributionSelection.contributionId
  ));
  if (matches.length === 0) {
    throw unavailableProviderContribution(
      'persistedProviderMissing',
      'The persisted conversation provider contribution is no longer admitted.',
    );
  }
  if (matches.length !== 1) {
    throw unavailableProviderContribution(
      'persistedProviderAmbiguous',
      'The persisted conversation provider selection resolved to multiple admitted Channels contributions.',
    );
  }
  return matches[0]!;
}
