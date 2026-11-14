// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
  TriageSourceAdministrationActionInputV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { planTriageConfigureSourceOffersV1 } from './configureSources.js';
import {
  activate as externalActivate,
  manifest as externalManifest,
  LEDGER_ACTION_IDS,
  LEDGER_ACCOUNT_PURPOSE,
  LEDGER_CONNECTED_ACCOUNT_ID,
} from '../../../../../tests/fixtures/plugin-platform/out-of-tree-triage-source/src/index.mjs';
import { renderSurface as externalSettingsSurface } from '../../../../../tests/fixtures/plugin-platform/out-of-tree-triage-source/src/settings.mjs';

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
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function contribution(input: Readonly<{
  pluginId: string;
  contributionId: string;
  descriptor?: unknown;
}>) {
  return {
    contributor: {
      pluginId: input.pluginId,
      contributionId: input.contributionId,
      occurrenceId: GENERATION,
      sourceCustody: { kind: 'development', registeredRootId: 'source-root' },
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
    target: { pluginId: 'happier.triage', occurrenceId: 'target-generation-a', sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
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
  it('offers and mounts the external fixture’s page, then submits its discovered candidate through public administration', async () => {
    const source = externalManifest.contributes.targetedPluginContributions.find(
      (candidate) => candidate.target.pluginId === 'happier.triage',
    );
    expect(source).toBeDefined();
    const offers = planTriageConfigureSourceOffersV1(snapshot([contribution({
      pluginId: externalManifest.id,
      contributionId: source.id,
      descriptor: source.descriptor,
    })]));
    expect(offers).toEqual([{
      destination: { pluginId: externalManifest.id, localId: 'ledger-sources' },
      displayName: 'Acme Ledger',
      kindNames: ['Changes', 'Tickets'],
    }]);
    const page = externalManifest.contributes.ui.settingsPages.find((candidate) => candidate.id === offers[0]?.destination.localId);
    const renderer = externalManifest.contributes.ui.renderers.find((candidate) => candidate.id === page?.renderer);
    expect(renderer).toMatchObject({ kind: 'reactNative', artifact: 'ledger-sources-native' });

    const account = {
      service: { pluginId: externalManifest.id, localId: LEDGER_CONNECTED_ACCOUNT_ID },
      accountId: 'fixture-account',
    };
    const sourceKit = await createPluginTestkit({
      manifest: externalManifest,
      module: { activate: externalActivate },
      services: {
        connectedAccounts: {
          listAccounts: async ({ purpose }) => {
            expect(purpose).toBe(LEDGER_ACCOUNT_PURPOSE);
            return { status: 'complete', accounts: [{
              account, displayName: 'Ledger connection', state: 'connected',
              connectedAccountOrigins: [], connectedAccountBases: [],
            }] };
          },
        },
      },
    });
    const administered: unknown[] = [];
    let uiKit: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
      await act(async () => {
        uiKit = await createPluginUiTestkit({
          identity: { instanceId: 'external-settings', mountNonce: 'external-settings-1' },
          authorPlugin: { id: externalManifest.id, version: externalManifest.version },
          surface: externalSettingsSurface,
          surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter(),
          handlers: {
            executeAction: async ({ action, input }) => {
              if (action.pluginId === externalManifest.id && action.localId === LEDGER_ACTION_IDS.listInstances) {
                return await sourceKit.invokeAction(action.localId, input);
              }
              if (action.pluginId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.pluginId
                && action.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId) {
                return { kind: 'read', status: 'complete', instances: [] };
              }
              expect(action).toEqual(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1);
              administered.push(TriageSourceAdministrationActionInputV1Schema.parse(input));
              return { kind: 'active', sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' };
            },
          },
        });
      });
      await act(async () => {
        await uiKit!.press(await uiKit!.getByRole('button', { name: 'Add acme/ledger to PRs & Issues' }));
      });
      expect(administered).toEqual([{
        v: 1, kind: 'create', source: { pluginId: externalManifest.id, localId: source.id }, draft: {
          v: 1,
          binding: { purpose: LEDGER_ACCOUNT_PURPOSE, account },
          localInstanceKey: 'acme/ledger', keyStability: 'stable',
          configuration: { v: 1, token: 'space=acme/ledger' },
          locator: { v: 1, displayLabel: 'acme/ledger' },
        },
      }]);
    } finally {
      await uiKit?.dispose();
      await sourceKit.dispose();
    }
  });
  it('offers no source destination before an Account mount has an admitted contribution snapshot', () => {
    expect(planTriageConfigureSourceOffersV1(undefined)).toEqual([]);
  });

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
      kindNames: ['Pull request'],
    }]);
  });

  it('says what a source brings in its own plural words, falling back to the singular it declared', () => {
    const github = descriptor({ displayName: 'GitHub', settingsPageId: 'triage-sources' });
    const [offer] = planTriageConfigureSourceOffersV1(snapshot([
      contribution({
        pluginId: 'happier.scm-github',
        contributionId: 'github',
        descriptor: {
          ...github,
          kinds: [
            { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request', pluralDisplayName: 'Pull requests' },
            { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
          ],
        },
      }),
    ]));
    expect(offer?.kindNames).toEqual(['Pull requests', 'Issue']);
  });

  it('offers nothing for a source that named no page', () => {
    // A source may omit the optional page. A control must never invent a route.
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
