import {
  PluginError,
  type TargetedContributionSnapshot,
  type TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import { describe, expect, it } from 'vitest';

import {
  CHANNELS_PROVIDER_POINT_REF,
  type ChannelsProviderContributionV1,
} from './manifest.js';
import {
  readCurrentProviderContributionForPersistedSelection,
  readSelectedCurrentProviderContribution,
} from './providerContributions.js';

const selection = {
  target: {
    pluginId: CHANNELS_PROVIDER_POINT_REF.targetPluginId,
    sourceCustody: {
      kind: 'bundled_first_party',
      packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-version-a' },
    },
  },
  point: {
    pointId: CHANNELS_PROVIDER_POINT_REF.id,
    protocol: CHANNELS_PROVIDER_POINT_REF.protocol,
  },
  contributor: {
    pluginId: 'example.channels.provider',
    contributionId: 'example-provider',
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: 'provider-generation-a',
      installSource: 'npm',
    },
  },
} as const satisfies PluginTargetedContributionSelectionV1;

function contribution(
  occurrenceId = 'provider-occurrence-a',
): ChannelsProviderContributionV1 {
  // The host admission boundary vends typed opaque operation handles. Their
  // concrete values are irrelevant to provider selection and remain opaque here.
  return Object.freeze({
    contributor: {
      pluginId: selection.contributor.pluginId,
      contributionId: selection.contributor.contributionId,
      occurrenceId,
      sourceCustody: selection.contributor.sourceCustody,
    },
    protocol: CHANNELS_PROVIDER_POINT_REF.protocol,
    operations: {},
  }) as unknown as ChannelsProviderContributionV1;
}

function targetedContributionsFixture(input: Readonly<{
  occurrenceId: string;
  sourceCustody?: TargetedContributionSnapshot<ChannelsProviderContributionV1>['sourceCustody'];
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
            occurrenceId: input.occurrenceId,
            sourceCustody: input.sourceCustody ?? selection.target.sourceCustody,
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
        occurrenceId: 'channels-occurrence-a',
        contributions: [current],
      }),
      selection,
    })).resolves.toBe(current);
  });

  it.each([
    [
      'target custody',
      'channels-occurrence-b',
      {
        kind: 'bundled_first_party' as const,
        packagedRuntime: { kind: 'cli_version_root' as const, versionRootId: 'cli-version-b' },
      },
      contribution(),
      'targetSourceChanged',
    ],
    [
      'contributor custody',
      'channels-occurrence-a',
      selection.target.sourceCustody,
      Object.freeze({
        ...contribution('provider-occurrence-b'),
        contributor: Object.freeze({
          ...contribution('provider-occurrence-b').contributor,
          sourceCustody: {
            kind: 'managed' as const,
            immutableGenerationId: 'provider-generation-b',
            installSource: 'npm' as const,
          },
        }),
      }),
      'selectedContributorMissing',
    ],
  ] as const)('rejects a stale %s before an admitted provider handle can be used', async (
    _case,
    occurrenceId,
    sourceCustody,
    current,
    reason,
  ) => {
    await expect(readSelectedCurrentProviderContribution({
      context: context({ occurrenceId, sourceCustody, contributions: [current] }),
      selection,
    })).rejects.toMatchObject({
      code: 'channels_provider_contribution_unavailable',
      details: { reason },
    } satisfies Partial<PluginError>);
  });

  it('rejects ambiguous persisted contributor rows without treating them as a current caller selection', async () => {
    await expect(readCurrentProviderContributionForPersistedSelection({
      context: context({
        occurrenceId: 'channels-occurrence-a',
        contributions: [contribution(), contribution()],
      }),
      providerPluginId: selection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: selection.contributor.contributionId,
      },
    })).rejects.toMatchObject({
      code: 'channels_provider_contribution_ambiguous',
      details: { reason: 'persistedProviderAmbiguous' },
    } satisfies Partial<PluginError>);
  });

  it('re-admits a persisted stable contribution identity through the current provider generation', async () => {
    const current = contribution('provider-generation-b');

    await expect(readCurrentProviderContributionForPersistedSelection({
      context: context({
        occurrenceId: 'channels-occurrence-b',
        contributions: [current],
      }),
      providerPluginId: selection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: selection.contributor.contributionId,
      },
    })).resolves.toEqual(current);
  });
});
