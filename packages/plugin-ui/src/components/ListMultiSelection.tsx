import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import {
  HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT,
  HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT,
  createHappierListMultiSelectionStore,
  parseHappierListMultiSelectionRowSnapshot,
  readHappierPointerModifiers,
  resolveHappierListMultiSelectionPointerAction,
  resolveHappierPointerPlatform,
  type CreateHappierListMultiSelectionStateInput,
  type HappierListMultiSelectionActions,
  type HappierListMultiSelectionKey,
  type HappierListMultiSelectionSnapshot,
  type HappierListMultiSelectionStore,
} from '../presentation/collection/multiSelection.js';
import type { HappierGestureResponderEvent, HappierPortableStyle, HappierStyleProp } from '../presentation/portableTypes.js';
import type { HappierTone } from '../presentation/semantics.js';
import {
  HappierSelectionActionBar,
  type HappierSelectionActionBarHost,
  type HappierSelectionActionBarOverflowItem,
} from '../presentation/interaction/SelectionActionBar.js';
import { HappierText } from '../presentation/text/Text.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Menu } from './Overlay.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

const SELECTION_COUNT_TRANSLATION_KEY = 'happier.plugin-ui.list.selectionCount';
const SELECTION_CLEAR_TRANSLATION_KEY = 'happier.plugin-ui.list.clearSelection';
const SELECTION_ACTION_BAR_TRANSLATION_KEY = 'happier.plugin-ui.list.selectionActions';
const SELECTION_MORE_TRANSLATION_KEY = 'happier.plugin-ui.list.moreSelectionActions';

export type ListMultiSelectionKey = HappierListMultiSelectionKey;
export type ListMultiSelectionSnapshot = HappierListMultiSelectionSnapshot;

export type ListMultiSelectionActions = HappierListMultiSelectionActions;

/**
 * The subscribable selection owner, re-exported under the author-facing name.
 *
 * The store itself lives beside its reducer in the presentation layer, so a
 * consumer with its own list implementation — `apps/ui`'s sessions list — binds
 * the same object without importing this component module at all.
 */
export type ListMultiSelectionStore = HappierListMultiSelectionStore;

/** Package-private activation shared by virtualized rows and Collection cards. The store owns eligibility. */
export function activateListItem(input: Readonly<{
  key: string;
  event?: HappierGestureResponderEvent;
  store: ListMultiSelectionStore | null;
  focus(key: string): void;
  open(key: string): void;
}>): 'handled' | 'open' {
  const action = input.store === null ? 'open' : resolveHappierListMultiSelectionPointerAction({
      isSelectionMode: input.store.getSnapshot().isSelectionMode,
      platform: resolveHappierPointerPlatform(Platform.OS), ...readHappierPointerModifiers(input.event),
  });
  input.focus(input.key);
  if (input.store !== null && action !== 'open') {
    if (action === 'toggle') input.store.toggle(input.key);
    else input.store.selectRange(input.key);
    return 'handled';
  }
  input.open(input.key);
  return 'open';
}

export const createListMultiSelectionStore: (
  input: CreateHappierListMultiSelectionStateInput,
) => ListMultiSelectionStore = createHappierListMultiSelectionStore;

const ListMultiSelectionContext = createContext<ListMultiSelectionStore | null>(null);

const INERT_SNAPSHOT: ListMultiSelectionSnapshot = HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT;

function subscribeInert(): () => void {
  return () => undefined;
}

function getInertSnapshot(): ListMultiSelectionSnapshot {
  return INERT_SNAPSHOT;
}

function getInertRowSnapshot(): string {
  return HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT;
}

function noop(): void {
  // Optional hooks are intentionally inert outside a provider.
}

/**
 * Who supplies the collection's rows.
 *
 * `rows: 'collection'` hands them to the mounted `List`, which is the only
 * owner that can see unmounted rows. The other arm is for a consumer with its
 * own list implementation — `apps/ui`'s sessions list is the one in tree — and
 * the union is what stops both from writing rows at once.
 */
export type UseListMultiSelectionControllerInput =
  | Readonly<{
      scopeKey: string;
      rows: 'collection';
      visibleOrderedKeys?: never;
      eligibleKeys?: never;
      enabled?: boolean;
    }>
  | Readonly<{
      scopeKey: string;
      rows?: never;
      visibleOrderedKeys: readonly ListMultiSelectionKey[];
      eligibleKeys?: readonly ListMultiSelectionKey[] | ReadonlySet<ListMultiSelectionKey> | null;
      enabled?: boolean;
    }>;

export function useListMultiSelectionController(
  input: UseListMultiSelectionControllerInput,
): ListMultiSelectionStore {
  const collectionOwnsRows = input.rows === 'collection';
  const disabled = input.enabled === false;
  const storeRef = useRef<ListMultiSelectionStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createListMultiSelectionStore({
      scopeKey: input.scopeKey,
      visibleOrderedKeys: collectionOwnsRows || disabled ? [] : input.visibleOrderedKeys,
      eligibleKeys: collectionOwnsRows || disabled ? [] : input.eligibleKeys,
    });
  }

  const scopeKey = input.scopeKey;
  const visibleOrderedKeys = input.visibleOrderedKeys;
  const eligibleKeys = input.eligibleKeys;
  useEffect(() => {
    const store = storeRef.current;
    if (store === null) return;
    if (collectionOwnsRows) {
      // The scope still resets the selection; the rows arrive from the
      // collection's own sync, so replaying an empty order here would wipe them
      // between the two effects.
      const snapshot = store.getSnapshot();
      store.updateScope({
        scopeKey,
        visibleOrderedKeys: disabled ? [] : snapshot.visibleOrderedKeys,
        eligibleKeys: disabled ? [] : snapshot.eligibleKeys,
      });
    } else {
      store.updateScope({
        scopeKey,
        visibleOrderedKeys: disabled ? [] : visibleOrderedKeys ?? [],
        eligibleKeys: disabled ? [] : eligibleKeys,
      });
    }
    if (disabled) store.exit();
  }, [collectionOwnsRows, disabled, eligibleKeys, scopeKey, visibleOrderedKeys]);

  return storeRef.current;
}

export type ListMultiSelectionProviderProps = Readonly<{
  /**
   * `null` mounts the provider with no capability, which is deliberate: the
   * provider's presence must not depend on whether a list opted in, or gaining
   * the capability would change the React tree shape around the virtualizer and
   * remount it.
   */
  store: ListMultiSelectionStore | null;
  children?: ReactNode;
}>;

export function ListMultiSelectionProvider(props: ListMultiSelectionProviderProps): ReactElement {
  return (
    <ListMultiSelectionContext.Provider value={props.store}>
      {props.children}
    </ListMultiSelectionContext.Provider>
  );
}

export function useOptionalListMultiSelectionStore(): ListMultiSelectionStore | null {
  return useContext(ListMultiSelectionContext);
}

/**
 * Subscribe to one store that may not exist.
 *
 * The mounted `List` reads its capability's store this way rather than through
 * the context it publishes itself, so the collection owner and every row read
 * exactly the same snapshot with one subscription rule.
 */
export function useListMultiSelectionStoreSnapshot(
  store: ListMultiSelectionStore | null,
): ListMultiSelectionSnapshot {
  return useSyncExternalStore(
    store?.subscribe ?? subscribeInert,
    store?.getSnapshot ?? getInertSnapshot,
    store?.getSnapshot ?? getInertSnapshot,
  );
}

export function useListMultiSelectionSnapshot(): ListMultiSelectionSnapshot {
  return useListMultiSelectionStoreSnapshot(useContext(ListMultiSelectionContext));
}

export type ListMultiSelectionRow = Readonly<{
  isSelectionMode: boolean;
  isSelected: boolean;
  isFocused: boolean;
  replace: () => void;
  toggle: () => void;
  selectRange: () => void;
  addRange: () => void;
  setFocused: () => void;
}>;

/**
 * One row's three selection facts, subscribed per row.
 *
 * The subscription reads a three-character primitive rather than the snapshot
 * so toggling one row commits that row and the row that lost the anchor, not
 * every mounted cell.
 */
export function useListMultiSelectionRow(key: ListMultiSelectionKey): ListMultiSelectionRow {
  const store = useContext(ListMultiSelectionContext);
  const rowSnapshot = useSyncExternalStore(
    store?.subscribe ?? subscribeInert,
    () => store?.getRowSnapshot(key) ?? getInertRowSnapshot(),
    () => store?.getRowSnapshot(key) ?? getInertRowSnapshot(),
  );
  const { isSelectionMode, isSelected, isFocused } = parseHappierListMultiSelectionRowSnapshot(rowSnapshot);
  return useMemo(() => ({
    isSelectionMode,
    isSelected,
    isFocused,
    replace: store ? () => store.replaceWith(key) : noop,
    toggle: store ? () => store.toggle(key) : noop,
    selectRange: store ? () => store.selectRange(key) : noop,
    addRange: store ? () => store.addRange(key) : noop,
    setFocused: store ? () => store.setFocusedKey(key) : noop,
  }), [isFocused, isSelected, isSelectionMode, key, store]);
}

/** One bulk destination offered while a selection is live. */
export type ListBulkAction = Readonly<{
  id: string;
  label?: string;
  labelKey?: string;
  /** Author-supplied fallback for `labelKey`, so a missing key never reaches a reader. */
  labelFallback?: string;
  icon?: ReactNode;
  tone?: HappierTone;
  disabled?: boolean;
  testID?: string;
}>;

export type ListSelectionActionBarProps = Readonly<{
  actions: readonly ListBulkAction[];
  /** The selected keys are handed to the action; the bar never resolves targets itself. */
  onAction: (actionId: string, keys: readonly ListMultiSelectionKey[]) => void;
  /** Replaces the default "Clear selection" behavior; the control is never removed. */
  onDismiss?: () => void;
  /** Names that one dismiss control when it stops live work instead of clearing. */
  dismissLabel?: string;
  accessibilityLabel?: string;
  testID?: string;
  style?: HappierStyleProp;
}>;

/** The plugin runtime's typography, glyphs and menu, handed to the one selection bar owner. */
function PluginSelectionBarText(props: Readonly<{
  children: string;
  style: HappierPortableStyle;
  numberOfLines?: number;
  testID?: string;
  accessibilityLabel?: string;
  tabularNumbers?: boolean;
}>): ReactElement {
  return (
    <HappierText
      style={props.style}
      tabularNumbers={props.tabularNumbers}
      numberOfLines={props.numberOfLines}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
    >
      {props.children}
    </HappierText>
  );
}

function PluginSelectionBarOverflowMenu(props: Readonly<{
  items: readonly HappierSelectionActionBarOverflowItem[];
  onSelect: (id: string) => void;
  accessibilityLabel: string;
  renderTrigger: (open: () => void) => ReactNode;
}>): ReactElement {
  const [open, setOpen] = useState(false);
  // The plugin Menu owns its trigger (activation, focus return, expanded state), so it draws ⋯ itself.
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      trigger="⋯"
      triggerAccessibilityLabel={props.accessibilityLabel}
      items={props.items.map((item) => ({ id: item.id, label: item.label, disabled: item.disabled }))}
      onSelect={(id) => {
        setOpen(false);
        props.onSelect(id);
      }}
    />
  );
}

function usePluginSelectionBarHost(): HappierSelectionActionBarHost {
  const presentationHost = useOptionalPluginUiPresentationHost();
  return useMemo(() => ({
    Text: PluginSelectionBarText,
    OverflowMenu: PluginSelectionBarOverflowMenu,
    renderGlyph: (glyph: 'dismiss' | 'more', color: string, size: number) => presentationHost
      ? presentationHost.renderIcon({ name: glyph === 'dismiss' ? 'close' : 'more', size, color })
      : <HappierText style={{ color, fontSize: size, lineHeight: size + 4 }}>{glyph === 'dismiss' ? '✕' : '⋯'}</HappierText>,
  }), [presentationHost]);
}

/**
 * A plugin's bulk action bar: the ONE selection bar (`HappierSelectionActionBar`, ui-primitives-audit
 * §4) bound to this list's selection store.
 *
 * It renders only while a selection is live, states how many rows the actions will act on, and hands
 * each press the selected keys. It deliberately owns no confirmation, no progress and no result
 * reporting: those are the acting owner's. Happier core's own selection surfaces (the session list,
 * message selection) draw the same presentation owner, so there is one bar, not one per runtime.
 */
export function ListSelectionActionBar(props: ListSelectionActionBarProps): ReactElement | null {
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const host = usePluginSelectionBarHost();
  const store = useContext(ListMultiSelectionContext);
  const snapshot = useListMultiSelectionSnapshot();
  if (store === null) return null;
  const visible = snapshot.isSelectionMode && snapshot.count > 0;
  const selectedKeys = Array.from(snapshot.selectedKeys);
  return (
    <HappierSelectionActionBar
      visible={visible}
      label={translate(SELECTION_COUNT_TRANSLATION_KEY, '{count} selected', { count: String(snapshot.count) })}
      accessibilityLabel={props.accessibilityLabel ?? translate(SELECTION_ACTION_BAR_TRANSLATION_KEY, 'Selection actions')}
      testID={props.testID}
      style={props.style}
      colors={{ background: theme.colors.text, foreground: theme.colors.canvas, destructive: theme.colors.danger }}
      host={host}
      moreLabel={translate(SELECTION_MORE_TRANSLATION_KEY, 'More actions')}
      actions={props.actions.map((action) => ({
        id: action.id,
        label: action.label ?? translate(action.labelKey ?? action.id, action.labelFallback ?? action.id),
        disabled: action.disabled,
        testID: action.testID,
        emphasis: action.tone === 'danger' ? 'destructive' : 'secondary',
        ...(action.icon ? { renderIcon: () => action.icon } : {}),
        onPress: () => props.onAction(action.id, selectedKeys),
      }))}
      dismiss={props.dismissLabel
        ? { label: props.dismissLabel, presentation: 'label', onPress: () => (props.onDismiss ? props.onDismiss() : store.exit()) }
        : {
          label: translate(SELECTION_CLEAR_TRANSLATION_KEY, 'Clear selection'),
          onPress: () => (props.onDismiss ? props.onDismiss() : store.exit()),
        }}
    />
  );
}
