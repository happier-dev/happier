import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  type CollectionAnatomy,
  type CollectionField,
  type CollectionRowActions,
} from '@happier-dev/plugin-ui';
import {
  formatHappierDataBytes,
  happierPageTextMetrics,
  Treemap,
  useHappierCollection,
  type CompositionSegment,
  type HappierChartPart,
} from '@happier-dev/plugin-ui/presentation';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StorageInventoryKindV1Schema, type StorageInventoryKindV1, type StorageInventoryV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol/pets/constants';
import { STORAGE_TREEMAP_MIN_NODE_PX } from '@happier-dev/protocol/storage/storageV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ArtifactQuotaNotice } from '@/components/artifacts/ArtifactQuotaNotice';
import { createArtifactActionsClient, createMountedArtifactActionExecute, useStorageInventoryRead } from '@/components/artifacts/artifactActionsClient';
import { presentArtifactActionFailure } from '@/components/artifacts/artifactActionFailure';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { confirmTrimOldVersions } from '@/components/storage/storageConfirmations';
import { useRemoveDiscussionFile } from '@/components/storage/useRemoveDiscussionFile';
import {
  artifactViewRoute,
  opensInArtifactView,
  readArtifactCodeLanguage,
  resolveArtifactOpenRoute,
} from '@/components/artifacts/artifactBrowserModel';
import { artifactKindFact } from '@/components/artifacts/artifactKindPresentation';
import { sync } from '@/sync/sync';
import { useArtifactOperations } from '@/components/artifacts/useArtifactOperations';
import { useMotionPreferences } from '@/components/instrument/motion/useMotionPreferences';
import { formatStorageDay } from '@/components/machines/storage/storageCategoryText';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';
import {
  StorageBreakdownRow,
  StorageBreakdownTrailingText,
  StorageSizePending,
} from '@/components/storage/StorageBreakdownRow';
import {
  StorageCapacityNote,
  StorageCapacityRow,
} from '@/components/storage/StorageCapacityRow';
import { StorageSaySection } from '@/components/storage/StorageSayLine';
import { StorageSizeCell } from '@/components/storage/StorageSizeBar';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useArtifactRows } from '@/sync/store/hooks';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  describeAccountStorage,
  isAccountStorageEmpty,
  listAccountStorageItemKinds,
  parseAccountStorageItemFilter,
  projectAccountStorageItems,
  projectAccountStorageKinds,
  projectArtifactLimit,
  readAccountStorageItemArtifactIds,
  type AccountStorageItem,
  type AccountStorageItemFilter,
  type AccountStorageKind,
  type AccountStorageKindId,
  type ArtifactLimitStanding,
} from './accountStorageModel';
import { useAskAgentAboutStorage } from './useAskAgentAboutStorage';

/** The view's controls as current-context commands (the same path the Review view's Hide viewed uses). */
const STORAGE_SHAPE_COMMAND = 'storage.view.shape';
const STORAGE_FILTER_COMMAND = 'storage.view.filter';
/** Rows the items list reserves while the Account's Artifacts are first read (lab scene 2 "Loading"). */
const LOADING_ROWS = 6;
const MAP_HEIGHT = 280;
const LIST_MIN_WIDTH_PX = 560;

const KIND_ICONS: Readonly<Record<AccountStorageKindId, IconName>> = {
  artifacts: 'file-text',
  artifactOldVersions: 'clock-counter-clockwise',
  pluginArtifacts: 'puzzle-piece',
  discussionAttachments: 'paperclip',
  accountPets: 'paw-print',
  pluginCollections: 'database',
  profilePictures: 'user-circle',
  avatars: 'image',
  teamLogos: 'users',
};

/** Image kinds sit outside the owner's total, so they name their size in the legend but take no part of the bar. */
const IMAGE_KIND_IDS: ReadonlySet<string> = new Set(['profilePictures', 'avatars', 'teamLogos']);

const formatBytes = (bytes: number) =>
  formatHappierDataBytes(bytes, { kind: 'storage' });

/**
 * The Account's Storage view (owner 11-19/11-20, lab `storage-view-1119` scenes 1–3): one view, built once, opened
 * from Settings with no filter and from the Artifacts page and the quota notices filtered to Artifacts. It binds the
 * storage read owner (`storage.inventory.read`) and the Artifacts read owner; the body draws only what they report.
 */
export function AccountStorageView(props: Readonly<{ initialFilter: AccountStorageItemFilter }>): React.ReactElement {
  const [filter, setFilter] = React.useState<AccountStorageItemFilter>(props.initialFilter);
  // The kind filter is the read's own selection: the owner pages that kind, largest first.
  // It refreshes after its own deletions (`onChanged`), not on the header reads its page triggers.
  const selection = React.useMemo(() => ({ followStorageRevision: false, ...(filter === 'all' ? {} : { kinds: [filter] }) }), [filter]);
  const read = useStorageInventoryRead(selection);
  const { value: folders } = usePromptLibraryCatalogValue('folders');
  // Titles live in each Artifact's header: read exactly the page's Artifacts, never the whole library.
  const artifactIds = React.useMemo(() => readAccountStorageItemArtifactIds(read.items), [read.items]);
  const rows = useArtifactRows(artifactIds);
  // One exact-id header batch for the page's Artifacts this device has not read yet (the Artifacts read owner's
  // `refreshArtifactsByIds`); rows already in the store are not read again.
  const missing = artifactIds.filter((_, index) => rows[index] === null).join('\u0000');
  React.useEffect(() => {
    if (missing) void sync.refreshArtifactsByIds(missing.split('\u0000')).catch(() => {});
  }, [missing]);
  const items = React.useMemo(() => {
    const opened = new Map(artifactIds.flatMap((id, index) => rows[index] ? [[id, rows[index]!] as const] : []));
    return projectAccountStorageItems(read.items, opened, folders);
  }, [artifactIds, folders, read.items, rows]);
  return (
    <AccountStorageBody inventory={read.inventory} status={read.status} onRetry={read.retry} items={items}
      itemsLoaded={read.inventory !== null} filter={filter} onFilter={setFilter} onMore={read.more} loadingMore={read.loadingMore}
      onChanged={read.retry} />
  );
}

/** The view over the numbers and items it is given (the route binds the owners; `/dev/storage` binds fixtures). */
export function AccountStorageBody(
  props: Readonly<{
    inventory: StorageInventoryV1 | null;
    status: 'loading' | 'ready' | 'failed';
    onRetry: () => void;
    /** The owner's page(s), in its order, joined with the Artifact headers this device read. */
    items: readonly AccountStorageItem[];
    itemsLoaded: boolean;
    filter: AccountStorageItemFilter;
    onFilter: (filter: AccountStorageItemFilter) => void;
    /** Reads the owner's next page; `null` when it has none. */
    onMore: (() => void) | null;
    loadingMore?: boolean;
    /** A deletion from a row settled: the owner's numbers are read again. */
    onChanged?: () => void;
    /** The specimen's Map state; the person picks List or Map on a wide page. */
    initialShape?: 'list' | 'map';
  }>,
): React.ReactElement {
  usePreferredLanguage();
  const router = useRouter();
  const phone = useDeviceType() === 'phone';
  const { inventory, status, filter, onFilter } = props;
  const [shape, setShape] = React.useState<'list' | 'map'>(props.initialShape ?? 'list');
  // The view's own controls are current-context commands, so an agent drives them the way a press does.
  const commands = useCurrentUiContextLocalCommands(React.useMemo(() => [
    ...(phone ? [] : [{
      key: STORAGE_SHAPE_COMMAND,
      title: t('artifacts.browser.storageView.items.shapeLabel'),
      description: 'Show the biggest stored items as {value: "list" | "map"}.',
      invoke(input: unknown) {
        const value = isJsonObject(input) ? input.value : undefined;
        if (value !== 'list' && value !== 'map') return false;
        setShape(value);
      },
    }]),
    {
      key: STORAGE_FILTER_COMMAND,
      title: t('artifacts.browser.storageView.items.filterLabel'),
      description: `Narrow the biggest stored items to one kind with {value: "all" | ${StorageInventoryKindV1Schema.options.map((kind) => `"${kind}"`).join(' | ')}}.`,
      invoke(input: unknown) {
        const value = isJsonObject(input) ? input.value : undefined;
        if (value !== 'all' && parseAccountStorageItemFilter(value) === 'all') return false;
        onFilter(value === 'all' ? 'all' : parseAccountStorageItemFilter(value));
      },
    },
  ], [onFilter, phone]), { unbound: 'local' });
  const chooseShape = React.useCallback((value: 'list' | 'map') => { void commands.invoke(STORAGE_SHAPE_COMMAND, { value }); }, [commands]);
  const chooseFilter = React.useCallback((value: AccountStorageItemFilter) => { void commands.invoke(STORAGE_FILTER_COMMAND, { value }); }, [commands]);
  const limit = projectArtifactLimit(inventory);
  const empty = inventory !== null && isAccountStorageEmpty(inventory) && props.items.length === 0;
  const showBiggest = React.useCallback(() => chooseFilter('artifacts'), [chooseFilter]);
  // A kind's row narrows the list to it (lab: "A row filters the collection below").
  const openKind = chooseFilter;
  return (
    <ItemList pageColumn="wide" style={stylesheet.list} testID="storage:view">
      <SettingsPageHeader
        title={t('artifacts.browser.storageView.title')}
        description={t('artifacts.browser.storageView.description')}
      />
      {/* Over the limit: the shipped notice says the cause once; its action lists the biggest Artifacts here. */}
      {limit?.state === 'over' ? (
        <ArtifactQuotaNotice
          testID="storage:quota"
          placement="page-section"
          quota={{
            budget: 'account',
            usedBytes: limit.usedBytes,
            limitBytes: limit.limitBytes,
          }}
          usageAction={{
            label: t('artifacts.browser.storageView.showBiggest'),
            onPress: showBiggest,
          }}
        />
      ) : null}
      <AccountStorageSay
        inventory={inventory}
        status={status}
        onRetry={props.onRetry}
      />
      <ItemGroup testID="storage:capacity">
        <AccountCapacityRow
          inventory={inventory}
          unread={status === 'failed'}
          showDivider={limit !== null}
        />
        {limit ? <ArtifactLimitRow limit={limit} /> : null}
      </ItemGroup>
      {empty ? (
        <ItemGroup>
          <EmptyState
            testID="storage:empty"
            layout="inline"
            iconName="hard-drives"
            title={t('artifacts.browser.storageView.empty.title')}
            subtitle={t('artifacts.browser.storageView.empty.body')}
            primaryAction={{
              label: t('artifacts.browser.storageView.empty.action'),
              onPress: () => router.push('/artifacts' as never),
              testID: 'storage:empty:artifacts',
            }}
          />
        </ItemGroup>
      ) : (
        <>
          <AccountStorageKinds
            inventory={inventory}
            unread={status === 'failed'}
            compact={phone}
            filter={filter}
            onOpen={openKind}
          />
          <AccountStorageItems
            items={props.items}
            loaded={props.itemsLoaded}
            kinds={listAccountStorageItemKinds(inventory)}
            filter={filter}
            onFilter={chooseFilter}
            shape={phone ? 'list' : shape}
            onShape={phone ? undefined : chooseShape}
            onMore={props.onMore}
            loadingMore={props.loadingMore === true}
            onChanged={props.onChanged}
            compact={phone}
          />
          <AccountStorageAsk />
        </>
      )}
    </ItemList>
  );
}

/** The opening sentence: near the limit leads with it; over it or empty says nothing; a failed read offers Try again. */
function AccountStorageSay(
  props: Readonly<{
    inventory: StorageInventoryV1 | null;
    status: 'loading' | 'ready' | 'failed';
    onRetry: () => void;
  }>,
) {
  if (props.inventory === null) {
    if (props.status === 'failed') {
      return (
        <StorageSaySection
          testID="storage:say"
          lead={t('artifacts.browser.storageView.say.failed')}
          text={t('artifacts.browser.storageView.say.failedBody')}
          trailing={
            <TextLinkButton
              testID="storage:retry"
              tone="strong"
              label={t('common.retry')}
              onPress={props.onRetry}
            />
          }
        />
      );
    }
    // The sentence's line is reserved while the read is out, so nothing under it moves when it lands.
    return (
      <ItemGroup surface="none" header="none">
        <View
          style={stylesheet.sayPending}
          accessible
          accessibilityLabel={t('artifacts.browser.storageView.say.loading')}
          testID="storage:sayPending"
        >
          <StorageSizePending width={320} />
        </View>
      </ItemGroup>
    );
  }
  const say = describeAccountStorage(props.inventory);
  if (say.kind === 'none') return null;
  if (say.kind === 'near') {
    return (
      <StorageSaySection
        testID="storage:say"
        tone="warning"
        lead={t('artifacts.browser.storageView.say.nearlyFull')}
        text={t('artifacts.browser.storageView.say.nearBody', {
          used: formatBytes(say.limit.usedBytes),
          limit: formatBytes(say.limit.limitBytes),
        })}
      />
    );
  }
  const size = formatBytes(say.totalBytes);
  const kind =
    say.largest === null
      ? null
      : t(`artifacts.browser.storageView.kinds.names.${say.largest}`);
  return (
    <StorageSaySection
      testID="storage:say"
      lead={
        say.atLeast
          ? t('artifacts.browser.storageView.say.storedAtLeast', { size })
          : t('artifacts.browser.storageView.say.stored', { size })
      }
      text={
        kind === null
          ? ''
          : say.mostly
            ? t('artifacts.browser.storageView.say.mostly', { kind })
            : t('artifacts.browser.storageView.say.largest', { kind })
      }
    />
  );
}

/** Ink steps for the kinds the Artifact limit does not count; the usage accent marks the one it counts (lab). */
function useKindColors(): Readonly<Record<AccountStorageKindId, string>> {
  const { theme } = useUnistyles();
  return React.useMemo(
    () => ({
      artifacts: usageSignatureAccent(theme),
      artifactOldVersions: usageSignatureAccent(theme),
      discussionAttachments: theme.colors.text.secondary,
      accountPets: theme.colors.text.tertiary,
      pluginCollections: theme.colors.border.strong,
      pluginArtifacts: theme.colors.text.placeholder,
      profilePictures: theme.colors.border.default,
      avatars: theme.colors.border.default,
      teamLogos: theme.colors.border.default,
    }),
    [theme],
  );
}

/** Row 1 of the capacity sheet: the whole Account, always (owner Q1 = A). */
function AccountCapacityRow(
  props: Readonly<{
    inventory: StorageInventoryV1 | null;
    /** The read failed with nothing retained: the figure says it is not known, it does not shimmer on. */
    unread: boolean;
    showDivider: boolean;
  }>,
) {
  const colors = useKindColors();
  const kinds = projectAccountStorageKinds(props.inventory);
  const inventory = props.inventory;
  const legend = React.useMemo(
    (): CompositionSegment[] =>
      kinds
        .filter((kind) => kind.bytes === null || kind.bytes > 0)
        .map((kind) => ({
          ...(kind.id === 'artifactOldVersions' ? { pattern: 'hatched' as const } : {}),
          id: kind.id,
          // A kind the Home does not measure says so in its legend entry ("Picture size not recorded").
          label: kind.bytes === null
            ? `${t(`artifacts.browser.storageView.kinds.shortNames.${kind.id}`)} ${t('artifacts.browser.storageView.account.unmeasured')}`
            : t(`artifacts.browser.storageView.kinds.shortNames.${kind.id}`),
          value: kind.bytes,
          color: colors[kind.id],
        })),
    [colors, kinds],
  );
  const bar = React.useMemo(
    () => legend.filter((segment) => segment.value !== null && !IMAGE_KIND_IDS.has(segment.id)),
    [legend],
  );
  if (inventory === null) {
    return (
      <View style={stylesheet.capacityPending} testID="storage:account">
        <View style={stylesheet.capacityPendingHead}>
          <Text style={stylesheet.capacityTitle}>
            {t('artifacts.browser.storageView.account.title')}
          </Text>
          {props.unread ? <Text style={stylesheet.capacityTitle}>—</Text> : <StorageSizePending width={96} />}
        </View>
        <View style={stylesheet.capacityPendingBar} />
      </View>
    );
  }
  const size = formatBytes(inventory.totalBytes);
  const atLeast = inventory.unmeasuredKinds.length > 0;
  return (
    <StorageCapacityRow
      testID="storage:account"
      showDivider={props.showDivider}
      title={t('artifacts.browser.storageView.account.title')}
      figure={{
        strong: size,
        rest: atLeast
          ? t('artifacts.browser.storageView.account.storedAtLeast')
          : t('artifacts.browser.storageView.account.stored'),
      }}
      label={t('artifacts.browser.storageView.account.barLabel', { size })}
      total={Math.max(1, inventory.totalBytes)}
      barSegments={bar}
      legendSegments={legend}
      formatValue={formatBytes}
    >
      {inventory.artifactLimitBytes === null ? (
        <StorageCapacityNote
          testID="storage:noLimit"
          text={t('artifacts.browser.storageView.account.noLimit')}
        />
      ) : null}
    </StorageCapacityRow>
  );
}

/** Row 2: the Artifact limit, only when the server reports one (owner Q1 = A); amber near and over it. */
function ArtifactLimitRow(props: Readonly<{ limit: ArtifactLimitStanding }>) {
  const { theme } = useUnistyles();
  const { limit } = props;
  const speaks = limit.state !== 'room';
  const fill = speaks
    ? theme.colors.state.warning.foreground
    : usageSignatureAccent(theme);
  const counted = Math.min(limit.usedBytes, limit.limitBytes);
  const bar = React.useMemo(
    (): CompositionSegment[] => [
      {
        id: 'artifacts',
        label: t('artifacts.browser.storageView.kinds.shortNames.artifacts'),
        value: counted,
        color: fill,
      },
      {
        id: 'free',
        label: t('artifacts.browser.storageView.limit.nothingLeft'),
        value: limit.leftBytes,
        color: theme.colors.border.default,
      },
    ],
    [counted, fill, limit.leftBytes, theme.colors.border.default],
  );
  const legend = React.useMemo(
    (): CompositionSegment[] => [
      {
        id: 'artifacts',
        label: t('artifacts.browser.storageView.kinds.shortNames.artifacts'),
        value: limit.usedBytes,
        color: fill,
      },
      {
        id: 'free',
        label:
          limit.leftBytes > 0
            ? t('artifacts.browser.storageView.limit.left', {
                size: formatBytes(limit.leftBytes),
              })
            : t('artifacts.browser.storageView.limit.nothingLeft'),
        value: null,
        color: theme.colors.border.default,
      },
    ],
    [fill, limit.leftBytes, limit.usedBytes, theme.colors.border.default],
  );
  const used = formatBytes(limit.usedBytes);
  const whole = formatBytes(limit.limitBytes);
  return (
    <StorageCapacityRow
      testID="storage:limit"
      title={t('artifacts.browser.storageView.limit.title')}
      figure={
        limit.state === 'over'
          ? {
              strong: used,
              rest: t('artifacts.browser.storageView.limit.fullOf', {
                limit: whole,
              }),
              tone: 'warning',
            }
          : {
              strong: formatBytes(limit.leftBytes),
              rest: t('artifacts.browser.storageView.limit.leftOf', {
                limit: whole,
              }),
              ...(speaks ? { tone: 'warning' as const } : {}),
            }
      }
      label={t('artifacts.browser.storageView.limit.barLabel', {
        used,
        limit: whole,
      })}
      total={Math.max(1, limit.limitBytes)}
      barSegments={bar}
      legendSegments={legend}
      formatValue={formatBytes}
    >
      <StorageCapacityNote
        text={t('artifacts.browser.storageView.limit.note')}
      />
    </StorageCapacityRow>
  );
}

/** What's stored: one breakdown row per kind (the shared Machines › Storage row), each a bar against the largest. */
function AccountStorageKinds(
  props: Readonly<{
    inventory: StorageInventoryV1 | null;
    unread: boolean;
    compact: boolean;
    filter: AccountStorageItemFilter;
    onOpen: (id: AccountStorageKindId) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const colors = useKindColors();
  const kinds = projectAccountStorageKinds(props.inventory);
  const largest = kinds.reduce(
    (max, kind) => Math.max(max, kind.bytes ?? 0),
    0,
  );
  return (
    <ItemGroup
      testID="storage:kinds"
      title={t('artifacts.browser.storageView.kinds.title')}
      titleAccessory={
        props.compact ? undefined : (
          <Text style={stylesheet.sectionNote}>
            {t('artifacts.browser.storageView.kinds.note')}
          </Text>
        )
      }
    >
      {kinds.map((kind, index) => (
        <AccountStorageKindRow
          key={kind.id}
          kind={kind}
          pending={props.inventory === null && !props.unread}
          unread={props.inventory === null && props.unread}
          largest={largest}
          color={kind.id === 'artifacts' ? colors.artifacts : undefined}
          compact={props.compact}
          selected={props.filter === kind.id}
          showDivider={index < kinds.length - 1}
          icon={
            <Icon
              name={KIND_ICONS[kind.id]}
              size={18}
              color={theme.colors.text.secondary}
            />
          }
          onOpen={kind.bytes !== null && kind.bytes > 0 ? props.onOpen : undefined}
        />
      ))}
    </ItemGroup>
  );
}

function AccountStorageKindRow(
  props: Readonly<{
    kind: AccountStorageKind;
    pending: boolean;
    /** The read failed: no size, and no claim that the Home does not record it. */
    unread: boolean;
    largest: number;
    color?: string;
    compact: boolean;
    selected: boolean;
    showDivider: boolean;
    icon: React.ReactNode;
    onOpen?: (id: AccountStorageKindId) => void;
  }>,
) {
  const { kind, onOpen } = props;
  const unmeasured = !props.pending && !props.unread && kind.bytes === null;
  const trailing = unmeasured ? (
    <StorageBreakdownTrailingText
      text={t('artifacts.browser.storageView.kinds.sizeNotRecorded')}
    />
  ) : kind.id === 'accountPets' && !props.pending && !props.unread ? (
    <StorageBreakdownTrailingText
      text={t('artifacts.browser.storageView.kinds.petsLimit', {
        limit: formatBytes(PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount),
      })}
    />
  ) : null;
  const open = React.useCallback(() => onOpen?.(kind.id), [kind.id, onOpen]);
  return (
    <StorageBreakdownRow
      testID={`storage:kind:${kind.id}`}
      icon={props.icon}
      title={t(`artifacts.browser.storageView.kinds.names.${kind.id}`)}
      facts={t(`artifacts.browser.storageView.kinds.facts.${kind.id}`)}
      bytes={props.pending ? null : kind.bytes}
      largest={props.largest}
      barColor={props.color}
      size={
        props.pending
          ? null
          : kind.bytes === null
            ? '—'
            : formatBytes(kind.bytes)
      }
      trailing={trailing}
      compact={props.compact}
      selected={props.selected}
      showDivider={props.showDivider}
      onPress={onOpen ? open : undefined}
    />
  );
}

const ItemCommandsContext = React.createContext<Readonly<{
  open: (item: AccountStorageItem) => void;
  changed?: () => void;
}> | null>(null);

/** Biggest items: the shared Collection table in its rounded sheet; rows on a phone; the treemap as a desktop option. */
function AccountStorageItems(
  props: Readonly<{
    items: readonly AccountStorageItem[];
    loaded: boolean;
    /** The kinds the owner reports holding anything: the filter's choices. */
    kinds: readonly StorageInventoryKindV1[];
    filter: AccountStorageItemFilter;
    onFilter: (filter: AccountStorageItemFilter) => void;
    shape: 'list' | 'map';
    onShape?: (shape: 'list' | 'map') => void;
    onMore: (() => void) | null;
    loadingMore: boolean;
    onChanged?: () => void;
    compact: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const colors = useKindColors();
  // The owner's pages as they are: already narrowed to the chosen kind and in its order.
  const page = props.items;
  const largest = page.reduce((max, item) => Math.max(max, item.bytes ?? 0), 0);
  const open = React.useCallback(
    (item: AccountStorageItem) => {
      const route = itemRoute(item);
      if (route) router.push(route as never);
    },
    [router],
  );
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const model = useHappierCollection<AccountStorageItem>({
    items: page,
    keyOf: readItemKey,
    openKey: null,
    onOpenChange: React.useCallback(
      (key: string | null) => {
        const item = key
          ? pageRef.current.find((entry) => entry.key === key)
          : undefined;
        if (item) open(item);
      },
      [open],
    ),
  });
  const fields = React.useMemo(
    (): CollectionField<AccountStorageItem>[] => [
      {
        key: 'kind',
        title: t('artifacts.browser.storageView.items.kind'),
        minWidth: 110,
        priority: 1,
        render: (item) => (
          <Text style={stylesheet.cell} numberOfLines={1}>
            {itemKindLabel(item)}
          </Text>
        ),
      },
      {
        key: 'changed',
        title: t('artifacts.browser.storageView.items.changed'),
        minWidth: 90,
        priority: 2,
        render: (item) => (
          <Text style={stylesheet.cell} numberOfLines={1}>
            {item.createdAt ? formatStorageDay(item.createdAt) : ''}
          </Text>
        ),
      },
      {
        key: 'size',
        title: t('artifacts.browser.storageView.items.size'),
        minWidth: 170,
        priority: 3,
        align: 'end',
        render: (item) => (
          <ItemSize item={item} bar largest={largest} color={item.kind === 'artifacts' || item.kind === 'artifactOldVersions' ? colors.artifacts : undefined} />
        ),
      },
    ],
    [colors.artifacts, largest],
  );
  const anatomy = React.useMemo(
    (): CollectionAnatomy<AccountStorageItem> => ({
      glyph: (item) => (
        <Icon name={itemIcon(item)} size={16} color={theme.colors.text.secondary} />
      ),
      title: (item) => itemTitle(item),
      // An Artifact's header is still being read for this page: its name shimmers in place.
      titlePending: (item) => item.pending,
      // An item's name stays on one line, cut at its end, on a phone row as in the table (lab scene 1, 390).
      titleTruncates: true,
      // Where it lives reads quiet after the name in the table (Machines' rows do the same); a phone row's line 2 says it.
      // Only a filed item says more than "Artifacts", which every row would repeat.
      titleSuffix: (item) => (item.folderName ? itemWhere(item) : null),
      byline: (item) => (
        <Text style={stylesheet.where} numberOfLines={1}>
          {props.compact
            ? `${itemKindLabel(item)} · ${itemWhere(item)}`
            : itemWhere(item)}
        </Text>
      ),
      fields,
      ...(props.compact
        ? { reason: (item: AccountStorageItem) => <ItemSize item={item} /> }
        : {}),
      accessibilityLabel: (item) =>
        t('artifacts.browser.storageView.items.rowLabel', {
          name: itemTitle(item),
          kind: itemKindLabel(item),
          size:
            item.bytes === undefined
              ? t('artifacts.browser.storage.sizeUnknown')
              : formatBytes(item.bytes),
        }),
      testID: (item) => `storage:item:${item.key}`,
      columnTitles: { title: t('artifacts.browser.storageView.items.name') },
    }),
    [fields, props.compact, theme.colors.text.secondary],
  );
  const kinds = props.kinds;
  const commands = React.useMemo(() => ({ open, changed: props.onChanged }), [open, props.onChanged]);
  return (
    <>
      <ItemGroup
        testID="storage:items"
        surface="none"
        title={t('artifacts.browser.storageView.items.title')}
        titleAccessory={
          props.compact ? undefined : (
            <Text style={stylesheet.sectionNote}>
              {t('artifacts.browser.storageView.items.note')}
            </Text>
          )
        }
      >
        {kinds.length > 1 || props.onShape ? (
          <View style={stylesheet.tools}>
            {kinds.length > 1 ? (
              <SegmentedTabBar<AccountStorageItemFilter>
                role="tablist"
                presentation="pills"
                segmentSizing="content"
                accessibilityLabel={t(
                  'artifacts.browser.storageView.items.filterLabel',
                )}
                testIDPrefix="storage:filter"
                tabs={[
                  {
                    id: 'all',
                    label: t('artifacts.browser.storageView.items.all'),
                  },
                  ...kinds.map((id) => ({
                    id,
                    label: t(
                      `artifacts.browser.storageView.kinds.shortNames.${id}`,
                    ),
                  })),
                ]}
                activeTabId={props.filter}
                onSelectTab={props.onFilter}
              />
            ) : null}
            <View style={stylesheet.grow} />
            {props.onShape ? (
              <SegmentedTabBar<'list' | 'map'>
                role="radiogroup"
                segmentSizing="content"
                iconPlacement="leading"
                accessibilityLabel={t(
                  'artifacts.browser.storageView.items.shapeLabel',
                )}
                testIDPrefix="storage:shape"
                tabs={(
                  [
                    ['list', 'list-bullets'],
                    ['map', 'squares-four'],
                  ] as const
                ).map(([id, icon]) => ({
                  id,
                  label: t(`artifacts.browser.storageView.items.${id}`),
                  icon: (
                    <Icon
                      name={icon}
                      size={14}
                      color={theme.colors.text.secondary}
                    />
                  ),
                }))}
                activeTabId={props.shape}
                onSelectTab={props.onShape}
              />
            ) : null}
          </View>
        ) : null}
      </ItemGroup>
      {props.shape === 'map' && page.length > 0 ? (
        <ItemGroup header="none">
          <StorageItemsMap items={page} onOpen={open} />
        </ItemGroup>
      ) : null}
      <ItemGroup header="none">
        <ItemCommandsContext.Provider value={commands}>
          <CoreCollectionScope>
            <Collection<AccountStorageItem>
              testID="storage:collection"
              model={model}
              anatomy={anatomy}
              useRowActions={useStorageItemRowActions}
              accessibilityLabel={t(
                'artifacts.browser.storageView.items.listLabel',
              )}
              presentation={props.compact ? 'list' : 'table'}
              detail="none"
              scroll="page"
              minListWidth={LIST_MIN_WIDTH_PX}
              minDetailWidth={LIST_MIN_WIDTH_PX}
              preferredListRatio={1}
              loading={!props.loaded && props.items.length === 0}
              loadingRows={LOADING_ROWS}
              empty={
                <EmptyState
                  testID="storage:items:none"
                  layout="line"
                  title={t('artifacts.browser.storageView.items.none')}
                />
              }
            />
          </CoreCollectionScope>
        </ItemCommandsContext.Provider>
        {props.onMore ? (
          <View style={stylesheet.foot} testID="storage:items:foot">
            <TextLinkButton testID="storage:items:more" tone="strong" label={t('artifacts.browser.storageView.items.showMore')}
              onPress={props.onMore} disabled={props.loadingMore} />
          </View>
        ) : null}
      </ItemGroup>
    </>
  );
}

/** The same page of items as a treemap (Machines' Map): area is stored size; a tile opens its item. */
function StorageItemsMap(
  props: Readonly<{
    items: readonly AccountStorageItem[];
    onOpen: (item: AccountStorageItem) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const motion = useMotionPreferences();
  const [width, setWidth] = React.useState(0);
  const [pointed, setPointed] = React.useState<string | null>(null);
  const parts = React.useMemo(
    (): HappierChartPart[] =>
      props.items.flatMap((item) =>
        item.bytes === undefined || item.bytes <= 0
          ? []
          : [
              {
                key: item.key,
                label: itemTitle(item),
                value: item.bytes,
                valueLabel: formatBytes(item.bytes),
                tone: 'accent' as const,
              },
            ],
      ),
    [props.items],
  );
  const itemsRef = React.useRef(props.items);
  itemsRef.current = props.items;
  const onOpen = props.onOpen;
  const open = React.useCallback(
    (key: string) => {
      const item = itemsRef.current.find((entry) => entry.key === key);
      if (item) onOpen(item);
    },
    [onOpen],
  );
  return (
    <View testID="storage:map" style={stylesheet.map}>
      {/* Measured inside the padding, so the tiles stop at the sheet's inner edge. */}
      <View onLayout={(event) => {
        const visible = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (visible !== null) setWidth(Math.round(visible));
      }}>
      {width > 0 ? (
        <Treemap
          theme={pluginTheme}
          accentColor={usageSignatureAccent(theme)}
          items={parts}
          width={width}
          height={MAP_HEIGHT}
          minNodePx={STORAGE_TREEMAP_MIN_NODE_PX}
          accessibilityLabel={t('artifacts.browser.storageView.items.mapLabel')}
          smallerLabel={(count) =>
            t('artifacts.browser.storageView.items.smaller', {
              count: String(count),
            })
          }
          pointedKey={pointed}
          onPointAt={setPointed}
          onOpen={open}
          reducedMotion={motion.reduceMotion}
        />
      ) : (
        <View style={{ height: MAP_HEIGHT }} />
      )}
      </View>
      <Text style={stylesheet.mapHint}>
        {t('artifacts.browser.storageView.items.mapHint')}
      </Text>
    </View>
  );
}

/**
 * A row's "…" (lab scenes 1 and 3), each through its Action and offered only where its owner admits it:
 * - an Artifact: Open, Show old versions, Delete (the Artifact operations owner's access decides; shipped confirmation);
 * - its old versions: Delete old versions (`artifact.revisions.trim`) only where the item's `viewerMayTrim` admits it;
 * - a Discussion file: Remove file (`discussion.attachment.remove`) only where the item's `viewerMayRemove` admits it
 *   (owner ruling Q2: the message's author or the Discussion's owner). The storage read owner decides both; the view
 *   never re-decides them.
 */
function useStorageItemRowActions(item: AccountStorageItem): CollectionRowActions {
  const commands = React.useContext(ItemCommandsContext);
  const artifact = item.row?.artifact ?? null;
  const operations = useArtifactOperations(artifact, commands?.changed);
  const scope = useActiveServerAccountScope();
  const removeFile = useRemoveDiscussionFile(scope, commands?.changed);
  const trim = useTrimOldVersions(item, commands?.changed);
  const location = item.location;
  if (location.kind === 'discussion') {
    if (!item.viewerMayRemove) return {};
    return {
      busy: removeFile.busy,
      secondaryActions: [{ id: 'remove', label: t('artifacts.browser.storageView.discussion.removeFile'), destructive: true, disabled: removeFile.busy }],
      onSecondaryAction: (id) => {
        if (id === 'remove') return removeFile.run({ discussionId: location.discussionId, messageId: location.messageId,
          blobId: location.attachmentId ?? item.id, name: itemTitle(item), bytes: item.bytes ?? 0, discussionTitle: null, own: false });
      },
    };
  }
  if (item.kind === 'artifactOldVersions') {
    const history = artifact && operations.canRead;
    if (!history && !item.viewerMayTrim) return {};
    return {
      busy: trim.busy,
      secondaryActions: [
        ...(history ? [{ id: 'history', label: t('artifacts.browser.storageView.items.showOldVersions') }] : []),
        ...(item.viewerMayTrim ? [{ id: 'trim', label: t('artifacts.browser.storageView.items.deleteOldVersions'), destructive: true, disabled: trim.busy }] : []),
      ],
      onSecondaryAction: (id) => {
        if (id === 'history') operations.history();
        else if (id === 'trim') return trim.run();
      },
    };
  }
  if (!artifact || !operations.canRead) return {};
  return {
    busy: operations.deleting,
    secondaryActions: [
      { id: 'open', label: t('common.open') },
      { id: 'history', label: t('artifacts.browser.storageView.items.showOldVersions') },
      ...(operations.canManage ? [{ id: 'delete', label: t('artifacts.browser.storageView.items.deleteEllipsis'), destructive: true, disabled: operations.deleting }] : []),
    ],
    onSecondaryAction: (id) => {
      if (id === 'open') commands?.open(item);
      else if (id === 'history') operations.history();
      else if (id === 'delete') return operations.remove();
    },
  };
}

/** Clear an Artifact's retained versions through the mounted `artifact.revisions.trim`, after its confirmation. */
function useTrimOldVersions(item: AccountStorageItem, onChanged?: () => void) {
  const scope = useActiveServerAccountScope();
  const mounted = useMountedActionExecution(scope, { retainInvocation: true });
  const client = React.useMemo(() => scope ? createArtifactActionsClient(scope, createMountedArtifactActionExecute(mounted.execute)) : null,
    [scope, mounted.execute]);
  const [busy, setBusy] = React.useState(false);
  const location = item.location;
  const run = React.useCallback(async () => {
    if (!client || location.kind !== 'artifact' || item.kind !== 'artifactOldVersions' || busy) return;
    const confirmed = await confirmTrimOldVersions({ title: itemTitle(item), freesBytes: item.bytes ?? 0, limitAfter: null });
    if (!confirmed) return;
    setBusy(true);
    try {
      const outcome = await client.trimRevisions({ artifactId: location.artifactId }, { confirmed: true });
      if ('approvalId' in outcome) return;
      if (!outcome.ok) { alertActionFailure(presentArtifactActionFailure(outcome.failure, t('artifacts.deleteError'))); return; }
      onChanged?.();
    } finally { setBusy(false); }
  }, [busy, client, item, location, onChanged]);
  return { busy, run };
}

/** The item's stored size through the shared storage size cell (the Artifacts table draws the same cell). */
function ItemSize(props: Readonly<{ item: AccountStorageItem; bar?: boolean; largest?: number; color?: string }>) {
  return (
    <StorageSizeCell label={itemTitle(props.item)} bytes={props.item.bytes} largest={props.largest ?? 0} bar={props.bar === true}
      color={props.color} testID={`storage:item:${props.item.key}:size`} unknownLabel={t('artifacts.browser.storage.sizeUnknown')} />
  );
}

function readItemKey(item: AccountStorageItem): string {
  return item.key;
}

/** A name this device cannot decrypt says so; size, kind and date still come from the server (lab scene 2). */
function itemTitle(item: AccountStorageItem): string {
  const artifact = item.row?.artifact;
  if (artifact) return artifact.isDecrypted === false ? t('artifacts.browser.storageView.items.nameNotReadable') : artifact.title || t('artifacts.untitled');
  // The owner reports no name for these kinds: the row says what it is.
  switch (item.kind) {
    case 'discussionAttachments': case 'accountPets': case 'pluginCollections': case 'profilePictures': case 'avatars': case 'teamLogos':
      return t(`artifacts.browser.storageView.items.titles.${item.kind}`);
    default:
      return t('artifacts.untitled');
  }
}

function itemKindLabel(item: AccountStorageItem): string {
  const row = item.row;
  if (item.kind === 'artifacts' && row && row.artifact.isDecrypted !== false) return artifactKindFact(row.kind, readArtifactCodeLanguage(row.artifact)).label;
  return t(`artifacts.browser.storageView.kinds.shortNames.${item.kind}`);
}

function itemIcon(item: AccountStorageItem): IconName {
  const row = item.row;
  if (item.kind === 'artifacts' && row) return artifactKindFact(row.kind, readArtifactCodeLanguage(row.artifact)).icon;
  return KIND_ICONS[item.kind];
}

function itemWhere(item: AccountStorageItem): string {
  const where = item.folderName
    ? `${t('artifacts.browser.storageView.items.where')} › ${item.folderName}`
    : t('artifacts.browser.storageView.items.where');
  if (item.kind === 'artifactOldVersions') return t('artifacts.browser.storageView.items.oldVersionsWhere', { where });
  return item.location.kind === 'artifact' ? where : t(`artifacts.browser.storageView.kinds.names.${item.kind}`);
}

/** Where an item lives: its Artifact's own page, or its Discussion at its message. */
function itemRoute(item: AccountStorageItem): string | null {
  const artifact = item.row?.artifact;
  if (artifact) return opensInArtifactView(artifact) ? artifactViewRoute(artifact.id) : resolveArtifactOpenRoute(artifact);
  return null;
}

const ASK_CARDS = ['free', 'artifacts', 'attachments'] as const;
const ASK_ICONS: Readonly<Record<(typeof ASK_CARDS)[number], IconName>> = {
  free: 'sparkle',
  artifacts: 'file-text',
  attachments: 'paperclip',
};

/** Ask an agent: three prompts that open an ordinary Session; the agent works through the same storage Actions. */
function AccountStorageAsk() {
  const ask = useAskAgentAboutStorage();
  return (
    <ItemGroup
      testID="storage:ask"
      surface="none"
      title={t('artifacts.browser.storageView.ask.title')}
      description={t('artifacts.browser.storageView.ask.note')}
    >
      <SelectionTiles
        variant="action"
        testIdPrefix="storage:ask"
        accessibilityLabel={t('artifacts.browser.storageView.ask.title')}
        options={ASK_CARDS.map((id) => ({
          id,
          icon: ASK_ICONS[id],
          title: t(`artifacts.browser.storageView.ask.${id}.title`),
          subtitle: t(`artifacts.browser.storageView.ask.${id}.body`),
        }))}
        onPress={(id) =>
          fireAndForget(
            ask(t(`artifacts.browser.storageView.ask.${id}.prompt`)),
          )
        }
      />
    </ItemGroup>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  list: {
    paddingTop: 0,
  },
  sayPending: {
    marginTop: theme.space.s6,
    paddingVertical: theme.space.s4,
  },
  capacityPending: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s16,
    gap: theme.space.s10,
  },
  capacityPendingHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  capacityTitle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
  },
  capacityPendingBar: {
    height: theme.space.s10,
    borderRadius: theme.space.s4,
    backgroundColor: theme.colors.border.default,
  },
  sectionNote: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
    color: theme.colors.text.secondary,
  },
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    flexWrap: 'wrap',
  },
  grow: {
    flex: 1,
  },
  cell: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  where: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingTop: theme.space.s10,
  },
  footText: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  map: {
    gap: theme.space.s8,
    padding: theme.space.s12,
  },
  mapHint: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    textAlign: 'right',
  },
}));
