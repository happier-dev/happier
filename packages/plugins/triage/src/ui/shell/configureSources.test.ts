import { describe, expect, it } from 'vitest';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '@happier-dev/triage-protocol/v1';

import { planTriageConfigureSourceOffersV1 } from './configureSources.js';

/**
 * Where a reader with nothing configured is sent.
 *
 * The shell could always SAY "connect a source in Settings" and could never
 * take anyone there, because the descriptor named no page. Now that it can,
 * this is the decision that turns the admitted contributors into destinations —
 * and, just as importantly, refuses to invent one for a source that named no
 * page, because a control that cannot work is worse than no control.
 */

const GENERATION = 'contributor-generation-a';

function contribution(input: Readonly<{
  pluginId: string;
  contributionId: string;
  descriptor?: unknown;
}>) {
  return {
    contributor: {
      pluginId: input.pluginId,
      contributionId: input.contributionId,
      immutableGenerationId: GENERATION,
    },
    protocol: {
      id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
      version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    },
    ...(input.descriptor === undefined ? {} : { descriptor: input.descriptor }),
    operations: [],
    surfaces: [],
  };
}

function descriptor(input: Readonly<{ displayName: string; settingsPageId?: string }>) {
  return {
    v: 1,
    purpose: 'example-forge',
    displayName: input.displayName,
    kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
    ...(input.settingsPageId === undefined ? {} : { settingsPageId: input.settingsPageId }),
  };
}

function snapshot(contributions: readonly unknown[]): PluginUiTargetedContributionsV1 {
  return {
    target: { pluginId: 'happier.triage', immutableGenerationId: 'target-generation-a' },
    points: [{
      pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
      protocols: [{
        protocol: {
          id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
          version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
        contributions,
      }],
    }],
  } as unknown as PluginUiTargetedContributionsV1;
}

describe('the way out of an unconfigured PRs & Issues', () => {
  it('qualifies the page with the contributor the host admitted, never with one a descriptor named', () => {
    const offers = planTriageConfigureSourceOffersV1(snapshot([
      contribution({
        pluginId: 'happier.scm-github',
        contributionId: 'github',
        descriptor: descriptor({ displayName: 'GitHub', settingsPageId: 'triage-sources' }),
      }),
    ]));

    expect(offers).toEqual([{
      destination: { pluginId: 'happier.scm-github', localId: 'triage-sources' },
      displayName: 'GitHub',
    }]);
  });

  it('offers nothing for a source that named no page', () => {
    // Six source plugins ship a descriptor without one. Rendering a control for
    // them would be a press that cannot go anywhere.
    expect(planTriageConfigureSourceOffersV1(snapshot([
      contribution({
        pluginId: 'happier.sentry',
        contributionId: 'sentry',
        descriptor: descriptor({ displayName: 'Sentry' }),
      }),
      contribution({ pluginId: 'happier.posthog', contributionId: 'posthog' }),
      contribution({
        pluginId: 'happier.broken',
        contributionId: 'broken',
        descriptor: { v: 1, displayName: 'Broken' },
      }),
    ]))).toEqual([]);
  });

  it('offers nothing for a descriptor whose kind ids are ambiguous', () => {
    const github = descriptor({ displayName: 'GitHub', settingsPageId: 'triage-sources' });

    expect(planTriageConfigureSourceOffersV1(snapshot([
      contribution({
        pluginId: 'happier.scm-github',
        contributionId: 'github',
        descriptor: {
          ...github,
          kinds: [github.kinds[0], { ...github.kinds[0], displayName: 'Duplicate' }],
        },
      }),
    ]))).toEqual([]);
  });

  it('keeps every admitted source that named one, in the order the host published them', () => {
    const offers = planTriageConfigureSourceOffersV1(snapshot([
      contribution({
        pluginId: 'happier.scm-github',
        contributionId: 'github',
        descriptor: descriptor({ displayName: 'GitHub', settingsPageId: 'triage-sources' }),
      }),
      contribution({
        pluginId: 'happier.sentry',
        contributionId: 'sentry',
        descriptor: descriptor({ displayName: 'Sentry' }),
      }),
      contribution({
        pluginId: 'happier.scm-gitlab',
        contributionId: 'gitlab',
        descriptor: descriptor({ displayName: 'GitLab', settingsPageId: 'gitlab-triage-sources' }),
      }),
    ]));

    // A reader with three sources installed needs all of the ones that can be
    // reached, not the first — and the one that cannot is simply absent.
    expect(offers.map((offer) => offer.displayName)).toEqual(['GitHub', 'GitLab']);
    expect(offers[1]?.destination).toEqual({
      pluginId: 'happier.scm-gitlab',
      localId: 'gitlab-triage-sources',
    });
  });

  it('reads only the exact V1 sources point, never a neighbouring contribution', () => {
    const foreign = snapshot([
      contribution({
        pluginId: 'happier.scm-github',
        contributionId: 'github',
        descriptor: descriptor({ displayName: 'GitHub', settingsPageId: 'triage-sources' }),
      }),
    ]) as unknown as { points: { pointId: string; protocols: { protocol: { id: string; version: number } }[] }[] };
    foreign.points[0]!.pointId = 'some-other-point';
    expect(planTriageConfigureSourceOffersV1(
      foreign as unknown as PluginUiTargetedContributionsV1,
    )).toEqual([]);

    const wrongProtocol = snapshot([
      contribution({
        pluginId: 'happier.scm-github',
        contributionId: 'github',
        descriptor: descriptor({ displayName: 'GitHub', settingsPageId: 'triage-sources' }),
      }),
    ]) as unknown as { points: { protocols: { protocol: { id: string; version: number } }[] }[] };
    wrongProtocol.points[0]!.protocols[0]!.protocol.version += 1;
    expect(planTriageConfigureSourceOffersV1(
      wrongProtocol as unknown as PluginUiTargetedContributionsV1,
    )).toEqual([]);
  });
});
