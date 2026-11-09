import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import { renderScreen } from '@/dev/testkit';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import { ConnectedServicesIndexView } from './ConnectedServicesIndexView';

const CODEX = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;

function entry(
  title: string,
  projectionStatus?: 'loading',
): ConnectedServiceRegistryEntry {
  return {
    serviceId: CODEX.localId,
    service: CODEX,
    connectCommand: 'x',
    supportsOauth: true,
    executable: true,
    projectedTitle: title,
    ...(projectionStatus ? { projectionStatus } : {}),
  } as ConnectedServiceRegistryEntry;
}

function model(projectionStatus?: 'loading') {
  return buildConnectedServicesIndexModel({
    transport: 'advertised-v4',
    entries: [entry('ChatGPT', projectionStatus)],
    qualifiedAccounts: [
      {
        ref: { service: CODEX, accountId: 'work' },
        status: 'connected',
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'r',
        configurationReady: true,
        configurationRevision: null,
        scopes: [],
        providerIdentity: { email: 'codex@company.com' },
      } as unknown as QualifiedConnectedAccountProfileV4,
    ],
    qualifiedGroups: [],
    legacyServices: [],
    defaultAccountByServiceKey: {},
    resolveLabel: (candidate) => String(candidate?.projectedTitle ?? ''),
    resolveFallbackEntry: () => null,
    presentDiagnostics: () => ({ primary: null, supportDetails: null }),
    loadingLabel: 'Loading…',
    agentUses: [
      { agentId: 'codex', title: 'Codex', services: [CODEX], defaults: [] },
    ],
  });
}

const NO_FACTS = {
  usage: { kind: 'none' },
  planLabel: null,
  subscription: null,
  recoveryCredits: null,
  fetchedAt: null,
  staleSince: null,
  refreshing: false,
  refresh: null,
} as const;

function render(projectionStatus?: 'loading', options?: Readonly<{
  model: ReturnType<typeof model>;
  presentation: 'list' | 'grid';
}>) {
  return renderScreen(
    <ConnectedServicesIndexView
      model={options?.model ?? model(projectionStatus)}
      labelsByKey={{}}
      present={(input) =>
        presentConnectedAccountIdentity({
          ...input,
          hidden: false,
          label: input.label ?? null,
          email: input.email ?? null,
          accountId: input.accountId ?? null,
        })
      }
      now={0}
      presentation={options?.presentation ?? 'grid'}
      onPresentationChange={vi.fn()}
      compact={false}
      summary={{ needsYouCount: 0, asOf: null }}
      connectMore={null}
      fixProminence="primary"
      settled={null}
      renderAccount={({ render: draw }) => draw(NO_FACTS)}
      renderPool={() => <></>}
      renderStar={() => null}
      onAddAccount={vi.fn()}
      onSignInAgain={vi.fn()}
      onOpenAccount={vi.fn()}
      onOpenPool={vi.fn()}
    />,
  );
}

describe('ConnectedServicesIndexView grid', () => {
  it.each(['list', 'grid'] as const)('keeps an unknown held status neutral in %s while explicit sign-out remains actionable', async (presentation) => {
    const held = buildConnectedServicesIndexModel({
      transport: 'legacy', entries: [{ ...entry('ChatGPT'), legacyServiceId: CODEX.localId }],
      qualifiedAccounts: [], qualifiedGroups: [],
      legacyServices: [{ serviceId: CODEX.localId, profiles: [
        { profileId: 'unknown', status: 'future-peer-state' },
        { profileId: 'signed-out', status: 'needs_reauth' },
      ] }],
      defaultAccountByServiceKey: {}, resolveLabel: () => 'ChatGPT', resolveFallbackEntry: () => null,
      presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading…',
    });
    const screen = await render(undefined, { model: held, presentation });
    expect(screen.findHostByTestId(`connected-services-account:${CODEX.pluginId}/${CODEX.localId}:unknown:sign-in-again`)).toBeNull();
    expect(screen.findHostByTestId(`connected-services-account:${CODEX.pluginId}/${CODEX.localId}:signed-out:sign-in-again`)).not.toBeNull();
    await screen.unmount();
  });
  it('keeps a service group\'s "Used by" line while its description is still read, never "Loading…" (owner 11-01)', async () => {
    const settled = await render();
    expect(settled.getTextContent()).toContain('Codex');
    const reading = await render('loading');
    expect(reading.getTextContent()).not.toContain('Loading…');
    expect(reading.getTextContent()).toContain('Codex');
  });
});
