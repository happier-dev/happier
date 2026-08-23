import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import {
  HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT,
  HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT,
  createHappierListMultiSelectionStore,
  type CreateHappierListMultiSelectionStateInput,
  type HappierListMultiSelectionActions,
  type HappierListMultiSelectionKey,
  type HappierListMultiSelectionSnapshot,
  type HappierListMultiSelectionStore,
} from '../presentation/collection/multiSelection.js';
import type { HappierPortableStyle, HappierStyleProp } from '../presentation/portableTypes.js';
import type { HappierTone } from '../presentation/semantics.js';
import { Button } from './Button.js';
import { Row } from './Layout.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { Text } from './Text.js';

const SELECTION_COUNT_TRANSLATION_KEY = 'happier.plugin-ui.list.selectionCount';
const SELECTION_CLEAR_TRANSLATION_KEY = 'happier.plugin-ui.list.clearSelection';
const SELECTION_ACTION_BAR_TRANSLATION_KEY = 'happier.plugin-ui.list.selectionActions';

/**
 * The context is keyed on `globalThis` for one physical reason: a host bundle
 * can end up with more than one copy of this module — the app graph and a
 * mounted plugin's graph each resolve their own — and two `createContext` calls
 * make a provider and its consumer invisible to one another. One key, one
 * context, whatever the module graph looks like.
 */
const LIST_MULTI_SELECTION_CONTEXT_GLOBAL_KEY = '__HAPPIER_LIST_MULTI_SELECTION_CONTEXT__';

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

export const createListMultiSelectionStore: (
  input: CreateHappierListMultiSelectionStateInput,
) => ListMultiSelectionStore = createHappierListMultiSelectionStore;

type ListMultiSelectionContextGlobal = typeof globalThis & {
  [LIST_MULTI_SELECTION_CONTEXT_GLOBAL_KEY]?: React.Context<ListMultiSelectionStore | null>;
};

function resolveListMultiSelectionContext(): React.Context<ListMultiSelectionStore | null> {
  const globalWithContext = globalThis as ListMultiSelectionContextGlobal;
  const existingContext = globalWithContext[LIST_MULTI_SELECTION_CONTEXT_GLOBAL_KEY];
  if (existingContext) return existingContext;
  const context = createContext<ListMultiSelectionStore | null>(null);
  globalWithContext[LIST_MULTI_SELECTION_CONTEXT_GLOBAL_KEY] = context;
  return context;
}

const ListMultiSelectionContext = resolveListMultiSelectionContext();

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
  const [modeFlag, selectedFlag, focusedFlag] = rowSnapshot.split(':');
  return useMemo(() => ({
    isSelectionMode: modeFlag === '1',
    isSelected: selectedFlag === '1',
    isFocused: focusedFlag === '1',
    replace: store ? () => store.replaceWith(key) : noop,
    toggle: store ? () => store.toggle(key) : noop,
    selectRange: store ? () => store.selectRange(key) : noop,
    addRange: store ? () => store.addRange(key) : noop,
    setFocused: store ? () => store.setFocusedKey(key) : noop,
  }), [focusedFlag, key, modeFlag, selectedFlag, store]);
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
  accessibilityLabel?: string;
  testID?: string;
  style?: HappierStyleProp;
}>;

const actionBarBoxStyle: HappierPortableStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
};

/**
 * The bulk action bar's CONTRACT, not a product's chrome.
 *
 * It renders only while a selection is live, states how many rows the actions
 * will act on, and hands each press the selected keys. It deliberately owns no
 * confirmation, no progress and no result reporting: those are the acting
 * owner's, and building them here would make this a second bulk-action engine
 * beside the one that already runs the work.
 *
 * A host with its own bar — `apps/ui`'s sessions list — consumes the same store
 * and skips this component. One selection owner, two presentations, no second
 * rule.
 */
export function ListSelectionActionBar(props: ListSelectionActionBarProps): ReactElement | null {
  const translate = usePluginTranslation();
  const store = useContext(ListMultiSelectionContext);
  const snapshot = useListMultiSelectionSnapshot();
  if (store === null || !snapshot.isSelectionMode) return null;
  const selectedKeys = Array.from(snapshot.selectedKeys);
  return (
    <View
      role="toolbar"
      accessibilityLabel={props.accessibilityLabel ?? translate(
        SELECTION_ACTION_BAR_TRANSLATION_KEY,
        'Selection actions',
      )}
      testID={props.testID}
      style={[actionBarBoxStyle, props.style] as HappierStyleProp}
    >
      <Text
        value={translate(SELECTION_COUNT_TRANSLATION_KEY, '{count} selected', {
          count: String(snapshot.count),
        })}
        variant="caption"
        tone="secondary"
      />
      <Row gap="small" align="center" wrap>
        {props.actions.map((action) => (
          <Button
            key={action.id}
            title={action.label ?? translate(action.labelKey ?? action.id, action.labelFallback ?? action.id)}
            variant="secondary"
            disabled={action.disabled}
            testID={action.testID}
            onPress={() => props.onAction(action.id, selectedKeys)}
          />
        ))}
        <Button
          title={translate(SELECTION_CLEAR_TRANSLATION_KEY, 'Clear selection')}
          variant="plain"
          onPress={() => {
            if (props.onDismiss) props.onDismiss();
            else store.exit();
          }}
        />
      </Row>
    </View>
  );
}
