import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
} from '@happier-dev/protocol/connect/account-usage-primitives';
import { ProviderUsageSourceV1Schema } from '@happier-dev/protocol/providers/contributions';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { DaemonProviderUsageRefreshResponseV1Schema } from '@happier-dev/protocol/rpc/providers';

import { ProviderConnectionUsageSectionView } from '@/components/settings/providers/ProviderConnectionUsageSection';
import { ProviderSavedSecretControl } from '@/components/settings/providers/ProviderPageParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { presentProviderConnectionUsage } from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';
import type { ProviderConnectionUsageRefreshView } from '@/sync/domains/connectedServices/accountUsage/providerConnectionUsageRefreshResource';
import { t } from '@/text';

/**
 * Dev-only `/dev/connected-services` frames of a Provider connection's Usage section (PU1 amounts with a
 * billing key, PU2 never checked without one, PU3 a failed refresh beside last figures, PU4 a refresh in
 * flight, PU5 a refresh that needs the connection's API key). The figures go through the real presentation owner and section view from the canonical
 * snapshot schema, because a dev Home has no keyed Provider tenant to report real amounts.
 * Null for a frame this slice does not own.
 */
export function renderProviderUsageFrame(
  frame: string,
): React.ReactNode | null {
  switch (frame) {
    case 'PU1':
      return <ProviderUsageFrame state="loaded" />;
    case 'PU2':
      return <ProviderUsageFrame state="unbound" />;
    case 'PU3':
      return <ProviderUsageFrame state="failed" />;
    case 'PU4':
      return <ProviderUsageFrame state="refreshing" />;
    case 'PU5':
      return <ProviderUsageFrame state="keyNeeded" />;
    default:
      return null;
  }
}

type FrameState = 'loaded' | 'unbound' | 'failed' | 'refreshing' | 'keyNeeded';

const OPENROUTER = 'happier.provider.openrouter/openrouter';
const SOURCES = [
  ProviderUsageSourceV1Schema.parse({
    id: 'key-usage',
    endpointTemplateId: 'openrouter-openai-chat',
    path: '/api/v1/key',
    parser: 'openrouter-key-usage',
  }),
  ProviderUsageSourceV1Schema.parse({
    id: 'account-credits',
    endpointTemplateId: 'openrouter-openai-chat',
    path: '/api/v1/credits',
    parser: 'openrouter-account-credits',
    billingCredential: {
      slotId: 'managementKey',
      title: 'Management key',
      keyUrl: 'https://openrouter.ai/settings/management-keys',
      destination: {
        kind: 'httpHeader',
        name: 'authorization',
        format: 'bearer',
      },
    },
  }),
];
const USD = {
  unit: 'usd',
  utilizationPct: null,
  resetsAt: null,
  status: 'ok',
  source: 'provider_api',
  confidence: 'exact',
  details: {},
} as const;

function snapshot(
  meters: readonly Record<string, unknown>[],
  fetchedAtMs: number,
) {
  const recordKey = {
    providerId: 'openrouter',
    accountSubjectId: 'fixture',
    subjectKind: 'unknown',
    quotaScope: 'provider',
  } as const;
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'openrouter',
    accountSubject: { kind: 'provisionalLocalSubject', id: 'fixture' },
    observedAtMs: fetchedAtMs,
    fetchedAtMs,
    staleAfterMs: 60_000,
    source: 'providerHttp',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters,
  });
}

// Meters shaped exactly as the OpenRouter usage parsers produce them.
function view(
  state: FrameState,
  now: number,
): ProviderConnectionUsageRefreshView | null {
  if (state === 'unbound' || state === 'refreshing') return null;
  if (state === 'keyNeeded') {
    return {
      result: DaemonProviderUsageRefreshResponseV1Schema.parse({
        status: 'success',
        sources: [
          { sourceId: 'key-usage', status: 'error', error: createProviderErrorV1('provider_secret_missing', {}) },
          { sourceId: 'account-credits', status: 'not_configured' },
        ],
      }),
      snapshotsBySourceId: {},
      stateBySourceId: {},
    };
  }
  const key = snapshot(
    [
      {
        ...USD,
        meterId: 'key-spend-daily',
        label: 'Today',
        used: 1.84,
        limit: null,
        scope: 'daily',
      },
      {
        ...USD,
        meterId: 'key-spend-weekly',
        label: 'This week',
        used: 12.37,
        limit: null,
        scope: 'weekly',
      },
      {
        ...USD,
        meterId: 'key-spend-monthly',
        label: 'This month',
        used: 41.02,
        limit: null,
        scope: 'monthly',
      },
      {
        ...USD,
        meterId: 'key-spend-lifetime',
        label: 'Lifetime spend',
        used: 186.5,
        limit: null,
      },
      {
        ...USD,
        meterId: 'key-allowance',
        label: 'Allowance',
        used: 41.02,
        limit: 50,
        remaining: 8.98,
      },
    ],
    now - 4 * 60_000,
  );
  const credits = snapshot(
    [
      {
        ...USD,
        meterId: 'account-credits',
        label: 'Credits',
        used: 202.4,
        limit: null,
        remaining: -2.4,
        limitScope: 'account',
      },
    ],
    now - 4 * 60_000,
  );
  const result = DaemonProviderUsageRefreshResponseV1Schema.parse(
    state === 'loaded'
      ? {
          status: 'success',
          sources: [
            { sourceId: 'key-usage', status: 'ok', snapshot: key },
            { sourceId: 'account-credits', status: 'ok', snapshot: credits },
          ],
        }
      : {
          status: 'success',
          sources: [
            {
              sourceId: 'key-usage',
              status: 'error',
              error: createProviderErrorV1(
                'provider_endpoint_rate_limited',
                {},
              ),
            },
            {
              sourceId: 'account-credits',
              status: 'error',
              error: createProviderErrorV1(
                'provider_endpoint_unauthorized',
                {},
              ),
            },
          ],
        },
  );
  return {
    result,
    snapshotsBySourceId:
      state === 'loaded'
        ? { 'key-usage': key, 'account-credits': credits }
        : { 'key-usage': key },
    stateBySourceId: {},
  };
}

const noop = () => {};

function ProviderUsageFrame(props: Readonly<{ state: FrameState }>) {
  const { theme } = useUnistyles();
  const now = React.useMemo(() => Date.now(), []);
  const bound = props.state !== 'unbound' && props.state !== 'keyNeeded';
  const presentation = React.useMemo(
    () =>
      presentProviderConnectionUsage({
        sources: SOURCES,
        isBillingSlotBound: () => bound,
        view: view(props.state, now),
      }),
    [bound, now, props.state],
  );
  return (
    <ItemList testID="provider-usage-specimen">
      <PageHeader
        alwaysShowTitle
        title="OpenRouter"
        meta={[
          { key: 'provider', text: t('settingsProviders.kind.aggregator') },
          { key: 'models', text: '312 models' },
        ]}
        leading={
          <PageHeaderMarkSlot>
            <ProviderIcon contributionKey={OPENROUTER} icon={null} size={24} color={theme.colors.text.secondary} />
          </PageHeaderMarkSlot>
        }
      />
      <ItemGroup
        title={t('settingsProvidersCollection.connectionTitle')}
        description={t('settingsProvidersCollection.connectionDescription')}
      >
        <Item
          title={t('settingsProviders.authoring.apiKey')}
          subtitle={props.state === 'keyNeeded'
            ? t('settingsProviders.detail.apiKeyMissing')
            : t('settingsProvidersCollection.apiKeySavedDescription')}
          subtitleLines={0}
          showChevron={false}
          rightElementOutsidePressable
          rightElement={
            <ProviderSavedSecretControl
              testID="specimen-api-key"
              saved={props.state !== 'keyNeeded'}
              disabled={false}
              onChoose={noop}
            />
          }
        />
        <Item
          title={t('settingsProviders.detail.modelsTitle')}
          detail="24 shown"
          onPress={noop}
        />
      </ItemGroup>
      <ProviderConnectionUsageSectionView
        providerName="OpenRouter"
        presentation={presentation}
        refreshing={props.state === 'refreshing'}
        failed={false}
        refresh={noop}
        onOpenApproval={null}
        isBillingKeySaved={() => bound}
        onChooseBillingKey={noop}
        onChooseApiKey={noop}
      />
    </ItemList>
  );
}
