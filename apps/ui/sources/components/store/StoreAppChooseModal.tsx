import * as React from 'react';

import {
  CapabilityAddModalBody,
  openCapabilityAddModalHost,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { StoreMachineScopeContext } from '@/components/settings/plugins/model/useStoreMachineScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { CustomModalInjectedProps } from '@/modal/types';
import { registrySourceFailureLine } from '@/registries/describeRegistrySourceStatus';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { t } from '@/text';

import { useAppList } from './catalog/storeRegistryLists';
import {
  StoreAppListingBody,
  StoreAppListingController,
} from './StoreAppListing';
import {
  useRegistryRows,
  useSourceCatalog,
  type DirectoryRow,
} from './StoreKindPage';

const TEST_ID = 'newApp.chooseApp';

export type StoreAppChooseParams = Readonly<{
  /** The Machine the Store reads Machine-backed catalogs on, as the Store page would for this flow. */
  machine?: Readonly<{ serverId: string; machineId: string }> | null;
  /** The app the person chose; the dialog has already closed. */
  onChoose: (item: RegistryCatalogItemSummary) => void;
}>;

/**
 * Deploy an app → Browse all apps (owner 11-28): the shared Add dialog over the Store's App catalog, in choose mode.
 * Rows, groups and the listing body are the Store's own; the one action is "Use <app>", which closes the dialog and
 * hands the exact catalog item back to the flow that asked. Nothing is prepared or installed here.
 */
export function openStoreAppChooseModal(
  params: StoreAppChooseParams,
): Readonly<{ close: () => void }> {
  return openCapabilityAddModalHost(
    StoreAppChooseModal,
    { params },
    {
      title: t('newApp.chooseApp.title'),
      subtitle: t('newApp.chooseApp.subtitle'),
      testID: TEST_ID,
    },
  );
}

export function StoreAppChooseModal(
  props: CustomModalInjectedProps & Readonly<{ params: StoreAppChooseParams }>,
) {
  const machine = props.params.machine;
  const scope = React.useMemo(
    () =>
      machine
        ? { serverId: machine.serverId, machineId: machine.machineId }
        : undefined,
    [machine?.serverId, machine?.machineId],
  );
  return (
    <StoreMachineScopeContext.Provider value={scope}>
      <StoreAppChooseBody {...props} />
    </StoreMachineScopeContext.Provider>
  );
}

type Row = DirectoryRow & Readonly<{ item: RegistryCatalogItemSummary }>;
const keyOf = (row: Row) => row.key;
const NO_OPEN = () => undefined;

function StoreAppChooseBody(
  props: CustomModalInjectedProps & Readonly<{ params: StoreAppChooseParams }>,
) {
  const [query, setQuery] = React.useState('');
  const [catalogDemanded, setCatalogDemanded] = React.useState(true);
  const demand = React.useMemo(
    () => ({ presented: catalogDemanded }),
    [catalogDemanded],
  );
  const list = useAppList({ query }, demand);
  const { sources, sourceTitle } = useSourceCatalog();
  // The Store's own rows and sections (picks and curated categories lead while browsing); the dialog owns the press.
  const curated = React.useMemo(
    () => ({
      items: list.items,
      curation: list.curation,
      sources,
      ...(query.trim() ? {} : { curatedKind: 'app' as const }),
    }),
    [list.items, list.curation, sources, query],
  );
  const directory = useRegistryRows(curated, NO_OPEN, sourceTitle);
  const rows = React.useMemo(
    () => directory.rows.filter((row): row is Row => row.item !== undefined),
    [directory.rows],
  );
  const groups = React.useMemo(
    () =>
      directory.groups
        .map((group) => ({
          key: group.key,
          title: group.title,
          itemKeys: rows.filter((row) => row.group === group.key).map(keyOf),
        }))
        .filter((group) => group.itemKeys.length > 0),
    [directory.groups, rows],
  );
  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<Row>({
        title: (row) => row.title,
        description: (row) => row.description,
        mark: (row) => row.mark,
        facts: (row) => ({
          source: { kind: 'registry', label: sourceTitle(row.item.sourceId) },
        }),
        accessibilityLabel: (row) => row.title,
        testID: (row) =>
          `${TEST_ID}.row.${row.item.sourceId}.${row.item.itemId}`,
      }),
    [sourceTitle],
  );
  const { onClose, params } = props;
  const config: CapabilityAddModalConfig<Row> = {
    title: t('newApp.chooseApp.title'),
    subtitle: t('newApp.chooseApp.subtitle'),
    testID: TEST_ID,
    onCatalogDemandChange: setCatalogDemanded,
    modes: [
      {
        key: 'catalog',
        kind: 'catalog',
        label: t('newApp.chooseApp.title'),
        icon: 'cube',
      },
    ],
    catalog: {
      query,
      onQueryChange: setQuery,
      searchPlaceholder: t('newApp.chooseApp.search'),
      items: rows,
      groups,
      itemKey: keyOf,
      anatomy,
      loading: list.loading && rows.length === 0,
      ...(list.hasNextPage
        ? {
            loadMore: {
              label: t('common.more'),
              loading: list.loading,
              onPress: list.nextPage,
            },
          }
        : {}),
      sourceFailures: list.sourceFailures.map((failure) => ({
        sourceId: failure.sourceId,
        message: registrySourceFailureLine(
          failure,
          failure.sourceTitle ?? t('capabilities.store.unnamedCatalog'),
        ).message,
        onRetry: failure.onRetry,
      })),
      empty: (
        <SurfaceStateCard
          testID={`${TEST_ID}.empty`}
          kind={list.error ? 'error' : 'empty'}
          size="line"
          title={
            list.error
              ? registrySourceFailureLine({ status: list.status }, null).message
              : query.trim()
                ? t('capabilities.store.noMatch', { query: query.trim() })
                : t('capabilities.store.emptyTitle')
          }
          {...(list.error
            ? {
                action: {
                  label: t('common.retry'),
                  onPress: () => {
                    void list.refresh();
                  },
                },
              }
            : {})}
        />
      ),
    },
    renderDetail: (row) => (
      <StoreAppChooseDetail key={row.key} item={row.item} />
    ),
    detailFooter: (row) => ({
      primary: {
        label: t('newApp.chooseApp.use', { name: row.title }),
        onPress: async () => {
          onClose();
          params.onChoose(row.item);
          return null;
        },
      },
    }),
  };
  return <CapabilityAddModalBody {...props} config={config} />;
}

/** The Store's own listing for the open row, read only while it is open. */
function StoreAppChooseDetail(
  props: Readonly<{ item: RegistryCatalogItemSummary }>,
) {
  const { sourceId, itemId, version } = props.item;
  const selection = React.useMemo(
    () => ({ sourceId, itemId, ...(version ? { version } : {}) }),
    [sourceId, itemId, version],
  );
  return (
    <StoreAppListingController selection={selection}>
      {(state) => {
        const listing = state.listing;
        if (
          listing &&
          (listing.kind === 'ready' || listing.kind === 'needs_review')
        )
          return <StoreAppListingBody state={listing} />;
        if (!listing || listing.kind === 'loading') {
          return (
            <SurfaceStateCard
              testID={`${TEST_ID}.detail.loading`}
              kind="loading"
              size="line"
              title={t('common.loading')}
            />
          );
        }
        return (
          <SurfaceStateCard
            testID={`${TEST_ID}.detail.unavailable`}
            kind="unavailable"
            size="line"
            title={t('capabilities.store.listing.removed')}
            reason={t('capabilities.store.listing.removedBody')}
          />
        );
      }}
    </StoreAppListingController>
  );
}
