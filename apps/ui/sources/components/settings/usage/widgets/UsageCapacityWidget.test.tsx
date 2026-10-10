import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServiceQuotaGetResultV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

it('renders every overlapping pool membership without duplicating standalone Account facts', async () => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const quota = ['work', 'personal', 'standalone'].map(accountId => {
    const recordKey = { providerId: 'anthropic', accountSubjectId: accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    return ConnectedServiceQuotaGetResultV1Schema.parse({
      source: { ref: { service, accountId }, bindingKind: 'account' },
      current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: accountId },
        observedAtMs: Date.now(), fetchedAtMs: Date.now(), staleAfterMs: 60_000,
        source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [], planLabel: null },
      pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
    });
  });
  const slice = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: quota },
    pools: [{ query, value: [
      { group: { service, groupId: 'first' }, memberAccountIds: ['work', 'personal'], activeAccountId: 'work', selection: { status: 'pending' } },
      { group: { service, groupId: 'second' }, memberAccountIds: ['work', 'personal'], activeAccountId: null, selection: { status: 'pending' } },
    ] }],
  }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('./UsageCapacityWidget');
  const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
    <UsageCapacityWidget id="usage_capacity" model={model} slice={slice} query={query} serverId="home" testID="capacity" />
  </InjectedAuthProvider>);
  expect(screen.findAllHostsByTestId('capacity.cell.work')).toHaveLength(2);
  expect(screen.findAllHostsByTestId('capacity.cell.personal')).toHaveLength(2);
  expect(screen.findAllHostsByTestId('capacity.cell.standalone')).toHaveLength(1);
});

it('keeps each reset and renewal as an exact point when the shared plot cannot fit', async () => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const now = Date.now();
  const recordKey = { providerId: 'anthropic', accountSubjectId: 'work', subjectKind: 'account', quotaScope: 'account' } as const;
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    source: { ref: { service, accountId: 'work' }, bindingKind: 'account' },
    current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: 'work' },
      observedAtMs: now, fetchedAtMs: now, staleAfterMs: 60_000,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', planLabel: 'Max',
      subscription: { status: 'subscribed', observedAtMs: now, staleAfterMs: 60_000, renewal: 'on', currentPeriodEndAtMs: now + 86_400_000 },
      meters: ['Weekly', 'Monthly'].map((label, index) => ({ meterId: label, label, used: null, limit: null,
        usedPct: 40, utilizationPct: 40, unit: 'count', status: 'ok', resetAtMs: now + (index + 1) * 3_600_000,
        resetsAt: now + (index + 1) * 3_600_000 })) },
    pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
  });
  const slice = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: [read] } }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageResetPlannerWidget } = await import('./UsageResetPlannerWidget');
  const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
    <WidgetPresentationProvider value={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact' }, geometry: { width: 320, height: 96 } }}>
      <UsageResetPlannerWidget id="usage_resets" model={model} slice={slice} query={query} serverId="home" testID="reset" />
    </WidgetPresentationProvider>
  </InjectedAuthProvider>);
  expect(screen.findByTestId('reset.timeline-plot')).toBeNull();
  const rows = [0, 1, 2].map(index => screen.findHostByTestId(`reset.timeline-values-row-${index}`));
  expect(rows.every(Boolean)).toBe(true);
  expect(rows.every(row => !row!.props.accessibilityLabel.includes('End:'))).toBe(true);
  expect(screen.getTextContent()).toContain('Weekly');
  expect(screen.getTextContent()).toContain('Monthly');
});
