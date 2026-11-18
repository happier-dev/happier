import * as React from 'react';
import { act } from 'react-test-renderer';
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

function model(projectionStatus?: 'loading', accountIds: readonly string[] = ['work']) {
  return buildConnectedServicesIndexModel({
    transport: 'advertised-v4',
    entries: [entry('ChatGPT', projectionStatus)],
    qualifiedAccounts: accountIds.map((accountId) => ({
        ref: { service: CODEX, accountId },
        status: 'connected',
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'r',
        configurationReady: true,
        configurationRevision: null,
        scopes: [],
        providerIdentity: { email: accountId === 'work' ? 'codex@company.com' : `${accountId}@company.com` },
      } as unknown as QualifiedConnectedAccountProfileV4)),
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
  model?: ReturnType<typeof model>;
  presentation: 'list' | 'grid';
  summary?: Readonly<{ needsYouCount: number; asOf: number | null; staleAt?: number | null }>;
  facts?: typeof NO_FACTS | Readonly<Record<string, unknown>>;
  now?: number;
  compact?: boolean;
  renderAddAccount?: (section: 'agents' | 'tools') => React.ReactNode;
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
      now={options?.now ?? 0}
      presentation={options?.presentation ?? 'grid'}
      onPresentationChange={vi.fn()}
      compact={options?.compact ?? false}
      summary={options?.summary ?? { needsYouCount: 0, asOf: null }}
      connectMore={null}
      fixProminence="primary"
      settled={null}
      renderAccount={({ render: draw }) => draw((options?.facts ?? NO_FACTS) as typeof NO_FACTS)}
      renderPool={() => <></>}
      renderStar={() => null}
      onAddAccount={vi.fn()}
      onSignInAgain={vi.fn()}
      onOpenAccount={vi.fn()}
      onOpenPool={vi.fn()}
      {...(options?.renderAddAccount ? { renderAddAccount: options.renderAddAccount } : {})}
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
  it.each(['list', 'grid'] as const)('says stale usage once for the page in %s, and a row only when it differs from the page', async (presentation) => {
    const HOUR = 60 * 60 * 1000;
    const now = 3 * HOUR;
    const staleRow = { ...NO_FACTS, fetchedAt: HOUR, staleSince: HOUR };
    const rowStale = `connected-services-account:${CODEX.pluginId}/${CODEX.localId}:work:stale`;
    const covered = await render(undefined, { presentation, now, facts: staleRow,
      summary: { needsYouCount: 0, asOf: HOUR, staleAt: HOUR + 60_000 } });
    expect(covered.findHostByTestId('connected-services-summary-stale')).not.toBeNull();
    expect(covered.findHostByTestId(rowStale)).toBeNull();
    await covered.unmount();
    // The page's reads are current: the one old row keeps its own line.
    const differs = await render(undefined, { presentation, now, facts: staleRow,
      summary: { needsYouCount: 0, asOf: HOUR, staleAt: null } });
    expect(differs.findHostByTestId('connected-services-summary-stale')).toBeNull();
    expect(differs.findHostByTestId(rowStale)).not.toBeNull();
    await differs.unmount();
  });
  it('offers search on the phone Overview once the accounts no longer fit at a glance, saying when nothing matches', async () => {
    const ids = ['ana', 'ben', 'cleo', 'dev', 'eli', 'fay', 'gus'];
    const row = (id: string) => `connected-services-account:${CODEX.pluginId}/${CODEX.localId}:${id}`;
    const screen = await render(undefined, { model: model(undefined, ids), presentation: 'list', compact: true });
    const field = () => screen.findByTestId('connected-services-index:search');
    expect(field()).not.toBeNull();
    await act(async () => { (field()!.props.onChangeText as (text: string) => void)('cleo'); });
    expect(screen.findHostByTestId(row('cleo'))).not.toBeNull();
    expect(screen.findHostByTestId(row('ana'))).toBeNull();
    await act(async () => { (field()!.props.onChangeText as (text: string) => void)('nobody'); });
    expect(screen.findHostByTestId('connected-services-index:no-match')).not.toBeNull();
    await screen.pressByTestIdAsync('connected-services-index:no-match-clear');
    expect(screen.findHostByTestId(row('ana'))).not.toBeNull();
    await screen.unmount();
    // A short list reads at a glance: no field.
    const short = await render(undefined, { model: model(undefined, ids.slice(0, 3)), presentation: 'list', compact: true });
    expect(short.findByTestId('connected-services-index:search')).toBeNull();
    await short.unmount();
  });
  it('keeps a section\'s add action on the phone Overview, as Gateways and Secrets do', async () => {
    const screen = await render(undefined, {
      presentation: 'list',
      compact: true,
      renderAddAccount: (section) => <React.Fragment key={section}>{`add:${section}`}</React.Fragment>,
    });
    expect(screen.getTextContent()).toContain('add:agents');
    await screen.unmount();
  });
  it('groups a phone\'s cards by kind, two per row, with the purpose line in place of the count (R7 p4-creds)', async () => {
    const kinds = model(undefined, ['work', 'key', 'expired']);
    const keyed = { ...kinds, sheets: kinds.sheets.map((sheet) => ({ ...sheet, canAdd: true, accounts: sheet.accounts.map((account) =>
      account.kind !== 'qualified' ? account
        : account.accountId === 'key' ? { ...account, profile: { ...account.profile, accessMode: 'apiKey' } }
          : account.accountId === 'expired' ? { ...account, status: 'needs_reauth' } : account) })) };
    const screen = await render(undefined, { model: keyed as typeof kinds, presentation: 'grid', compact: true,
      summary: { needsYouCount: 1, asOf: null } });
    const ids = (group: string) => {
      const node = screen.findHostByTestId(`connected-services-index:${group}`);
      return ['work', 'key', 'expired'].filter((id) => node?.findAll((child) => child.props?.testID === `connected-services-account:${CODEX.pluginId}/${CODEX.localId}:${id}`).length);
    };
    expect(ids('needs-you')).toEqual(['expired']);
    expect(ids('agent-accounts')).toEqual(['work']);
    expect(ids('api-keys')).toEqual(['key']);
    // The page's "+" adds; no group or service carries its own Add.
    expect(screen.findHostByTestId(`connected-services-service:${CODEX.pluginId}/${CODEX.localId}:add-account`)).toBeNull();
    expect(screen.getTextContent()).toContain('Sign-ins and keys your agents use.');
    expect(screen.findHostByTestId('connected-services-summary')).toBeNull();
    expect(screen.getTextContent()).toContain('Codex');
    await screen.unmount();
  });
});
