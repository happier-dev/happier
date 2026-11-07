import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection } from '@happier-dev/plugin-ui/components';
import {
  HappierCapabilityAddBody,
  HappierCapabilityAddDetailAction,
  HappierCapabilityAddFooter,
  HappierCapabilityListingDetail,
  HappierPressable,
  useHappierCapabilityAddEdge,
  type HappierCapabilityAddConfig,
  type HappierCapabilityAddDetailContext,
  type HappierCapabilityAddFound,
  type HappierCapabilityAddHost,
  type HappierCapabilityAddInputContext,
  type HappierCapabilityAddLabels,
  type HappierCapabilityAddLevel,
  type HappierCapabilityAddMode,
} from '@happier-dev/plugin-ui/presentation';

import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { Text } from '@/components/ui/text/Text';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Modal } from '@/modal';
import { CATALOG_SURFACE_CARD_DIMENSIONS } from '@/modal/components/card/commandSurfaceCard';
import { ModalCardHeader } from '@/modal/components/card/ModalCardHeader';
import type { CustomModalDismissGuard, CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

/**
 * Happier's Add dialogs (skills, MCP servers, agents) draw the shared Add body (`@happier-dev/plugin-ui`
 * `HappierCapabilityAddBody`: tabs, catalog list, details, footer, registry selector) inside the standard modal card
 * at the catalog size role. This module keeps the frame: the card, its header and the way back one level in.
 */
export type CapabilityAddInputContext = HappierCapabilityAddInputContext;
export type CapabilityAddFound<Found> = HappierCapabilityAddFound<Found>;
export type CapabilityAddMode = HappierCapabilityAddMode<IconName>;
export type CapabilityAddDetailContext = HappierCapabilityAddDetailContext;
export type CapabilityAddModalConfig<Item> = HappierCapabilityAddConfig<Item, IconName> & Readonly<{
  /** The native review's ephemeral listing position, shared by its pane and page. */
  detailScrollOffset?: { current: number };
}>;

export type CapabilityAddModalHandle<Item> = Readonly<{
    close: () => void;
    update: (config: CapabilityAddModalConfig<Item>) => void;
}>;

/**
 * The one add-from-a-catalog dialog for skills, MCP servers and agents: the public `Collection` (list, `detail:
 * 'auto'`) inside the standard modal card at the catalog size role. Full-width list at rest; selecting a row narrows
 * the list and opens the details beside it with the Collection's own move; the details' close returns to the list;
 * the card never changes size. On a phone the card fills the screen and the details push.
 */
export function openCapabilityAddModal<Item>(
  config: CapabilityAddModalConfig<Item>,
): CapabilityAddModalHandle<Item> {
  const id = Modal.show({
    component: CapabilityAddModalBody as unknown as React.ComponentType<
      CustomModalInjectedProps & { config: CapabilityAddModalConfig<unknown> }
    >,
    props: { config: config as unknown as CapabilityAddModalConfig<unknown> },
    closeOnBackdrop: true,
    chrome: capabilityAddChrome(config),
  });
  return {
        close: () => Modal.hide(id),
        // The catalog is live (search, loading, results): the opener hands the next config to the open dialog.
        update: (next) => Modal.update(id, { config: next as unknown as CapabilityAddModalConfig<unknown> }),
    };
}

/**
 * The same dialog with its live state owned inside it: `Host` runs the kind's hooks (catalog, search, selection)
 * and renders `CapabilityAddModalBody` with the injected props, so any page entry can open it without holding
 * the catalog state itself. Same frame, size and phone presentation as `openCapabilityAddModal`.
 */
export function openCapabilityAddModalHost<P extends Readonly<Record<string, unknown>>>(
  Host: React.ComponentType<CustomModalInjectedProps & P>,
  props: P,
  frame: Readonly<{ title: string; subtitle?: string; testID: string; onRequestClose?: () => void; onDismissRequest?: CustomModalDismissGuard }>,
): Readonly<{ close: () => void }> {
  const id = Modal.show({
    component: Host as unknown as React.ComponentType<CustomModalInjectedProps & Readonly<Record<string, unknown>>>,
    props,
    closeOnBackdrop: true,
    chrome: capabilityAddChrome(frame),
    ...(frame.onRequestClose ? { onRequestClose: frame.onRequestClose } : {}),
    ...(frame.onDismissRequest ? { onDismissRequest: frame.onDismissRequest } : {}),
  });
  return { close: () => Modal.hide(id) };
}

export function capabilityAddChrome(frame: Readonly<{ title: string; subtitle?: string; testID: string }>) {
  return {
    kind: 'card' as const,
    header: 'none' as const,
    // The tools band and the rows stand on 24: the title and the close control share that edge.
    headerInset: 'wide' as const,
    title: frame.title,
    // Explicit nulls: the chrome owner merges patches, so leaving Registries must clear its back link and subtitle.
    leading: null,
    leadingPlacement: null,
    subtitle: frame.subtitle ?? null,
    testID: frame.testID,
    closeButtonTestID: `${frame.testID}:close`,
    scrollHost: 'body' as const,
    bodyScroll: 'none' as const,
    dimensions: CATALOG_SURFACE_CARD_DIMENSIONS,
    phonePresentation: 'fullscreen' as const,
  };
}

type BodyProps<Item> = CustomModalInjectedProps &
  Readonly<{ config: CapabilityAddModalConfig<Item> }>;

/** Esc closes the open details before the dialog, wherever focus is (the dialog's layer encloses this one). */
function useDismissDetail(enabled: boolean, onDismiss: () => void): void {
  useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.pane,
    enabled,
    allowEditableTarget: true,
    onEscape: onDismiss,
  });
}

/** Happier's primitives for the shared Add body; stable components, so tabs, lists and details keep their state. */
const HOST_SLOTS: HappierCapabilityAddHost<IconName> = {
  Collection,
  ModeTabs: ({ modes, activeKey, onSelect, accessibilityLabel, testID }) => (
    <SegmentedTabBar
      tabs={modes.map((mode) => ({
        id: mode.key,
        label: mode.label,
        testID: `${testID}:mode:${mode.key}`,
      }))}
      activeTabId={activeKey}
      onSelectTab={onSelect}
      segmentSizing="content"
      // The modes sit on the dialog's title line (lab `m:mcp`): the compact segmented step, beside the title.
      compact
      iconPlacement="leading"
      role="tablist"
      accessibilityLabel={accessibilityLabel}
    />
  ),
  Button: ({ title, display, loading, disabled, accessibilityHint, onPress, testID }) => (
    <RoundButton
      title={title}
      {...(display === 'secondary' ? { display: 'secondary' as const } : { size: 'normal' as const })}
      {...(loading === undefined ? {} : { loading })}
      {...(disabled === undefined ? {} : { disabled })}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      action={async () => { await onPress(); }}
      testID={testID}
    />
  ),
  ButtonRow: ({ children }) => (
    <RoundButtonSizeScope size="normal" presentation="uniform">
      {children}
    </RoundButtonSizeScope>
  ),
  SourceFailure: ({ title, retryLabel, onRetry, retryTestID, testID }) => (
    <SurfaceStateCard
      kind="warning"
      size="line"
      title={title}
      action={{ label: retryLabel, onPress: onRetry, testID: retryTestID }}
      testID={testID}
    />
  ),
  ErrorText: ({ children, testID }) => <AddErrorText testID={testID}>{children}</AddErrorText>,
  CollectionScope: CoreCollectionScope,
  ContainedPage: ({ children }) => (
    // A contained column: sections read their description above the rows, in the body's own inset. On a wide
    // listing page the column is the page's reading column, so the identity's action lines up with the header and
    // sections instead of the pane's edge (STORE-UI-R2 N3); in a dialog or pane the column is the body.
    <ListPresentationProvider value="page" pageInsets="contained">
      <PageFrame content="column">{children}</PageFrame>
    </ListPresentationProvider>
  ),
  useDismissDetail,
};

function AddErrorText(props: Readonly<{ children: string; testID: string }>): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <Text variant="meta" style={{ color: theme.colors.status.error }} testID={props.testID}>
      {props.children}
    </Text>
  );
}

function addLabels(): HappierCapabilityAddLabels {
  return {
    modesLabel: t('capabilities.add.modesLabel'),
    searchLabel: t('capabilities.add.searchLabel'),
    retry: t('common.retry'),
    closeDetails: t('capabilities.add.closeDetails'),
    added: t('capabilities.add.added'),
    done: t('capabilities.add.done'),
    addFailed: t('capabilities.add.addFailed'),
  };
}

export function CapabilityAddModalBody<Item>(
  props: BodyProps<Item>,
): React.ReactElement {
  const { config, onClose } = props;
  const { theme } = useUnistyles();
  const onPhone = useDeviceType() === 'phone';
  const labels = React.useMemo(addLabels, []);
  const { title, subtitle, testID } = config;
  return (
    <HappierCapabilityAddBody<Item, IconName>
      config={config}
      onClose={onClose}
      renderLayout={({ modes, level, body }) => <>
        <ModalCardHeader
          inset="wide"
          testID="modal-card-header"
          title={level.kind === 'registries' ? level.header.title : level.kind === 'detail' ? null : title}
          subtitle={level.kind === 'registries' ? level.header.subtitle : level.kind === 'detail' ? null : subtitle}
          leading={level.kind === 'root' ? null : <CapabilityAddBackLink label={title} onPress={level.back} testID={`${testID}:back`} />}
          {...(level.kind === 'registries' ? { leadingPlacement: 'above' as const } : {})}
          actions={level.kind === 'root' && !onPhone ? modes : null}
          onClose={onClose}
          closeButtonTestID={`${testID}:close`}
        />
        {/* A phone's modes take their own band on the body's edge, above the search (lab `mp:mcpList`). */}
        {level.kind === 'root' && onPhone ? <View style={styles.phoneModes}>{modes}</View> : null}
        {body}
      </>}
      phone={onPhone}
      labels={labels}
      host={HOST_SLOTS}
      space={theme.space}
      hairlineColor={theme.colors.border.subtle}
    />
  );
}

/**
 * One item's listing outside the dialog (the Store's pane and page): the dialog's own details for that item, drawn
 * with the same primitives and words, its action under the identity. Key it by item.
 */
/** What a listing body reads from its kind's Add config; a kind without an Add dialog (Software) supplies only this. */
export type CapabilityListingConfig<Item> = Pick<CapabilityAddModalConfig<Item>, 'renderDetail' | 'detailFooter' | 'onAdded' | 'testID' | 'detailScrollOffset'>
  & Readonly<{ catalog: Pick<CapabilityAddModalConfig<Item>['catalog'], 'itemKey'> }>;

export function CapabilityListingDetail<Item>(props: Readonly<{
  config: CapabilityListingConfig<Item>;
  item: Item;
  onClose: () => void;
  /** The listing is a phone page. */
  pushed: boolean;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const onPhone = useDeviceType() === 'phone';
  const labels = React.useMemo(addLabels, []);
  const { config, item } = props;
  return (
    <HappierCapabilityListingDetail<Item>
      item={item}
      itemKey={config.catalog.itemKey(item)}
      renderDetail={config.renderDetail}
      detailFooter={config.detailFooter}
      detailScrollOffset={config.detailScrollOffset}
      {...(config.onAdded === undefined ? {} : { onAdded: config.onAdded })}
      onClose={props.onClose}
      pushed={props.pushed}
      phone={onPhone}
      labels={labels}
      host={HOST_SLOTS}
      space={theme.space}
      hairlineColor={theme.colors.border.subtle}
      testID={config.testID}
    />
  );
}

/** The one content edge of the dialog (the shared body's): for an input mode's own parts. */
export const useAddDialogEdge = useHappierCapabilityAddEdge;

/** The open item's action under its identity (the shared body's): every kind's details place it. */
export const CapabilityAddDetailAction = HappierCapabilityAddDetailAction;

/** The pinned footer of the Add dialog (the shared body's). */
export const CapabilityAddFooter = HappierCapabilityAddFooter;

/** One level in, the way back names where it leads ("‹ Add a skill"), on the header's title line. */
function CapabilityAddBackLink(props: Readonly<{ label: string; onPress: () => void; testID: string }>): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <HappierPressable
      testID={props.testID}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={t('capabilities.add.backTo', { title: props.label })}
      style={styles.backLink}
    >
      <Icon name="caret-left" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
      <Text variant="body" style={{ color: theme.colors.text.secondary }} numberOfLines={1}>{props.label}</Text>
    </HappierPressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  phoneModes: {
    flexDirection: 'row',
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s12,
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    paddingRight: theme.space.s16,
  },
}));

/**
 * Page-level deep link (P5 §4.5): `?add=<modeKey>&source=<sourceId>&q=<query>` opens the Add modal once on the page
 * route, then the page replaces its own URL without the params (no mount write to synced state). `?install=<payload>`
 * is the install-link form (MCP servers): it opens the dialog with that payload for its paste mode.
 */
export function useCapabilityAddRouteParams(
  open: (params: Readonly<{ modeKey?: string; sourceId?: string; query?: string; install?: string }>) => void,
  clearHref: string,
): void {
  const params = useLocalSearchParams<{ add?: string | string[]; source?: string | string[]; q?: string | string[]; install?: string | string[] }>();
  const router = useRouter();
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;
  const add = first(params.add);
  const sourceId = first(params.source);
  const query = first(params.q);
  const install = first(params.install);
  const openRef = React.useRef(open);
  openRef.current = open;
  const handled = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (add === undefined && install === undefined) return;
    const key = JSON.stringify([add, sourceId, query, install]);
    if (handled.current === key) return;
    // On a cold deep link the page mounts before the modal host registers: open on the next turn.
    const timer = setTimeout(() => {
      handled.current = key;
      openRef.current({
        ...(add ? { modeKey: add } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(query ? { query } : {}),
        ...(install ? { install } : {}),
      });
      router.replace(clearHref as never);
    }, 0);
    return () => clearTimeout(timer);
  }, [add, clearHref, install, query, router, sourceId]);
}
