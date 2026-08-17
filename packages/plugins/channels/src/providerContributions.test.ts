import {
  PluginError,
  type TargetedContributionPointRef,
  type TargetedContributionSnapshot,
  type TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import { describe, expect, it } from 'vitest';

import {
  CHANNELS_PROVIDER_POINT_REF,
  type ChannelsProviderContributionV1,
} from './manifest.js';
import {
  readCurrentProviderContributionWitnessForPersistedSelection,
  readSelectedCurrentProviderContribution,
} from './providerContributions.js';

const selection = {
  target: {
    pluginId: CHANNELS_PROVIDER_POINT_REF.targetPluginId,
    immutableGenerationId: 'channels-generation-a',
  },
  point: {
    pointId: CHANNELS_PROVIDER_POINT_REF.id,
    protocol: CHANNELS_PROVIDER_POINT_REF.protocol,
  },
  contributor: {
    pluginId: 'example.channels.provider',
    contributionId: 'example-provider',
    immutableGenerationId: 'provider-generation-a',
  },
} as const satisfies PluginTargetedContributionSelectionV1;

function contribution(
  immutableGenerationId = selection.contributor.immutableGenerationId,
): ChannelsProviderContributionV1 {
  // The host admission boundary vends typed opaque operation handles. Their
  // concrete values are irrelevant to provider selection and remain opaque here.
  return Object.freeze({
    contributor: {
      pluginId: selection.contributor.pluginId,
      contributionId: selection.contributor.contributionId,
      immutableGenerationId,
    },
    protocol: CHANNELS_PROVIDER_POINT_REF.protocol,
    operations: {},
  }) as unknown as ChannelsProviderContributionV1;
}

function targetedContributionsFixture(input: Readonly<{
  generation: string;
  contributions: readonly ChannelsProviderContributionV1[];
}>): TargetedContributionsService {
  return {
    observeForSelf<TContribution>(
      _point: TargetedContributionPointRef<TContribution>,
      _options: Readonly<{ onInvalidated: () => void }>,
    ) {
      return {
        dispose() {},
        async readCurrent(): Promise<TargetedContributionSnapshot<TContribution>> {
          return {
            generation: input.generation,
            contributions: input.contributions as readonly TContribution[],
          };
        },
      };
    },
  };
}

function context(input: Parameters<typeof targetedContributionsFixture>[0]) {
  return {
    targetedContributions: targetedContributionsFixture(input),
    signal: new AbortController().signal,
  };
}

describe('Channels provider contribution resolution', () => {
  it('returns the exact currently admitted caller selection', async () => {
    const current = contribution();

    await expect(readSelectedCurrentProviderContribution({
      context: context({
        generation: selection.target.immutableGenerationId,
        contributions: [current],
      }),
      selection,
    })).resolves.toBe(current);
  });

  it.each([
    ['target generation', 'channels-generation-b', contribution(), 'targetGenerationChanged'],
    [
      'contributor generation',
      selection.target.immutableGenerationId,
      contribution('provider-generation-b'),
      'selectedContributorMissing',
    ],
  ] as const)('rejects a stale %s before an admitted provider handle can be used', async (
    _case,
    generation,
    current,
    reason,
  ) => {
    await expect(readSelectedCurrentProviderContribution({
      context: context({ generation, contributions: [current] }),
      selection,
    })).rejects.toMatchObject({
      code: 'channels_provider_contribution_unavailable',
      details: { reason },
    } satisfies Partial<PluginError>);
  });

  it('rejects ambiguous persisted contributor rows without treating them as a current caller selection', async () => {
    await expect(readCurrentProviderContributionWitnessForPersistedSelection({
      context: context({
        generation: selection.target.immutableGenerationId,
        contributions: [contribution(), contribution()],
      }),
      providerPluginId: selection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: selection.contributor.contributionId,
        immutableGenerationId: selection.contributor.immutableGenerationId,
      },
    })).rejects.toMatchObject({
      code: 'channels_provider_contribution_ambiguous',
      details: { reason: 'persistedProviderAmbiguous' },
    } satisfies Partial<PluginError>);
  });
});
