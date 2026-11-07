import {
  PluginError,
  selectCurrentTargetedContribution,
  type TargetedContributionSnapshot,
  type TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import { CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_REF_V1 } from '@happier-dev/channels-protocol/v1';

import type { ChannelsProviderContributionV1 } from './manifest.js';
import type { PersistedConversationProviderContributionSelection } from './collections.js';

type ProviderContributionReadContext = Readonly<{
  targetedContributions: TargetedContributionsService;
  signal: AbortSignal;
}>;

type ProviderContributionUnavailableReason =
  | 'selectionInvalid'
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

function hasCurrentPointProtocol(
  contribution: ChannelsProviderContributionV1,
  point: typeof CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_REF_V1,
): boolean {
  return contribution.protocol.id === point.protocol.id
    && contribution.protocol.version === point.protocol.version;
}

async function readCurrentProviderSnapshot(
  context: ProviderContributionReadContext,
): Promise<TargetedContributionSnapshot<ChannelsProviderContributionV1>> {
  const observation = context.targetedContributions.observeForSelf(
    CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_REF_V1,
    { onInvalidated: () => {} },
  );
  try {
    return await observation.readCurrent({ signal: context.signal });
  } finally {
    observation.dispose();
  }
}

/**
 * Resolves the exact stable contributor chosen by the caller through current
 * admission, including same-ID reload/source replacement. No plugin-wide
 * fallback can substitute a missing contributor.
 */
export async function readSelectedCurrentProviderContribution(input: Readonly<{
  context: ProviderContributionReadContext;
  selection: PluginTargetedContributionSelectionV1;
}>): Promise<ChannelsProviderContributionV1> {
  const result = await selectCurrentTargetedContribution({
    service: input.context.targetedContributions,
    point: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_REF_V1,
    selection: input.selection,
    signal: input.context.signal,
  });
  if (result.kind === 'selected') return result.contribution;
  if (result.reason === 'selection_invalid') throw unavailableProviderContribution(
    'selectionInvalid',
    'Conversation provider selection does not address the Channels provider contribution point.',
  );
  // A same-ID reload replaces selection provenance, not the selected provider.
  // Resolve that exact stable contributor through the existing admission owner.
  return readCurrentProviderContributionForPersistedSelection({
    context: input.context,
    providerPluginId: input.selection.contributor.pluginId,
    providerContributionSelection: { contributionId: input.selection.contributor.contributionId },
  });
}

/** PR links consume the single admitted contributor declaring native PR support. */
export async function readSessionPullRequestProvider(context: ProviderContributionReadContext) {
  const point = CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_REF_V1;
  const snapshot = await readCurrentProviderSnapshot(context);
  const matches = snapshot.contributions.filter((entry) => hasCurrentPointProtocol(entry, point)
    && entry.descriptor?.pullRequests !== undefined);
  if (matches.length !== 1) throw unavailableProviderContribution('persistedProviderMissing', 'A unique pull request Channel provider is unavailable.');
  const selection: PluginTargetedContributionSelectionV1 = {
    target: { pluginId: 'happier.channels', sourceCustody: snapshot.sourceCustody },
    point: { pointId: 'providers', protocol: point.protocol },
    contributor: { pluginId: matches[0]!.contributor.pluginId, contributionId: matches[0]!.contributor.contributionId, sourceCustody: matches[0]!.contributor.sourceCustody },
  };
  return { selection, contribution: matches[0]! };
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
  const point = CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_REF_V1;
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
