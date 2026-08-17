import {
  PluginError,
  selectCurrentTargetedContribution,
  type TargetedContributionSnapshot,
  type TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';

import {
  CHANNELS_PROVIDER_POINT_REF,
  type ChannelsProviderContributionV1,
} from './manifest.js';
import type { PersistedConversationProviderContributionSelection } from './collections.js';

type ProviderContributionReadContext = Readonly<{
  targetedContributions: TargetedContributionsService;
  signal: AbortSignal;
}>;

/**
 * One ephemeral observation of the admitted provider selection. Callers may
 * carry this only across one in-flight effect chain; durable rows retain the
 * contributor identity but never a target-generation or Action authority.
 */
export type CurrentProviderContributionWitness = Readonly<{
  targetGeneration: string;
  contribution: ChannelsProviderContributionV1;
}>;

type ProviderContributionUnavailableReason =
  | 'selectionInvalid'
  | 'targetGenerationChanged'
  | 'selectedContributorMissing'
  | 'persistedProviderMissing'
  | 'persistedProviderAmbiguous';

function unavailableProviderContribution(
  reason: ProviderContributionUnavailableReason,
  message: string,
): PluginError {
  return new PluginError({
    code: reason === 'persistedProviderAmbiguous'
      ? 'channels_provider_contribution_ambiguous'
      : 'channels_provider_contribution_unavailable',
    message,
    retryable: true,
    details: { reason },
  });
}

function unavailableSelectedProviderContribution(
  reason: 'selection_invalid' | 'target_generation_stale' | 'contributor_unavailable',
): PluginError {
  switch (reason) {
    case 'selection_invalid':
      return unavailableProviderContribution(
        'selectionInvalid',
        'Conversation provider selection does not address the Channels provider contribution point.',
      );
    case 'target_generation_stale':
      return unavailableProviderContribution(
        'targetGenerationChanged',
        'Conversation provider selection was made for a retired Channels target generation.',
      );
    case 'contributor_unavailable':
      return unavailableProviderContribution(
        'selectedContributorMissing',
        'The selected conversation provider contribution is no longer admitted at its selected generation.',
      );
  }
}

function hasCurrentPointProtocol(contribution: ChannelsProviderContributionV1): boolean {
  return contribution.protocol.id === CHANNELS_PROVIDER_POINT_REF.protocol.id
    && contribution.protocol.version === CHANNELS_PROVIDER_POINT_REF.protocol.version;
}

async function readCurrentProviderSnapshot(
  context: ProviderContributionReadContext,
): Promise<TargetedContributionSnapshot<ChannelsProviderContributionV1>> {
  const observation = context.targetedContributions.observeForSelf(
    CHANNELS_PROVIDER_POINT_REF,
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
    point: CHANNELS_PROVIDER_POINT_REF,
    selection: input.selection,
    signal: input.context.signal,
  });
  if (result.kind === 'selected') return result.contribution;

  throw unavailableSelectedProviderContribution(result.reason);
}

/**
 * Resolves the exact contribution retained by a durable connection against the
 * current target-owned admission snapshot. Durable state never retains an
 * Action or materialization identity, and this owner intentionally provides no
 * plugin-wide fallback when the selected contribution has retired.
 */
export async function readCurrentProviderContributionWitnessForPersistedSelection(input: Readonly<{
  context: ProviderContributionReadContext;
  providerPluginId: string;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
}>): Promise<CurrentProviderContributionWitness> {
  const snapshot = await readCurrentProviderSnapshot(input.context);
  const matches = snapshot.contributions.filter((contribution) => (
    hasCurrentPointProtocol(contribution)
    && contribution.contributor.pluginId === input.providerPluginId
    && contribution.contributor.contributionId
      === input.providerContributionSelection.contributionId
    && contribution.contributor.immutableGenerationId
      === input.providerContributionSelection.immutableGenerationId
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
  return {
    targetGeneration: snapshot.generation,
    contribution: matches[0]!,
  };
}

/**
 * Resolves a durable connection's exact current provider contribution for
 * ordinary one-effect consumers. Multi-effect consumers retain the ephemeral
 * witness above and revalidate it before using derived facts.
 */
export async function readCurrentProviderContributionForPersistedSelection(input: Readonly<{
  context: ProviderContributionReadContext;
  providerPluginId: string;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
}>): Promise<ChannelsProviderContributionV1> {
  return (await readCurrentProviderContributionWitnessForPersistedSelection(input)).contribution;
}
