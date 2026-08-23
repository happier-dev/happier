import type { HappierRovingEntry } from './semantics.js';

/**
 * The ONE keyed multi-selection rule for a Happier collection.
 *
 * It is the state machine the sessions list has owned since multi-select
 * shipped, lifted here so the public `List` can offer it as an opt-in
 * capability and every list — app or plugin — reaches the same answer. There is
 * no second reducer: `apps/ui`'s sessions selection module is an adapter over
 * this owner, and a plugin list opts in through `List`'s `selection.multiple`.
 *
 * Three facts are deliberately separate and none derives from another:
 *
 * - `selectedKeys` is what a bulk action acts on;
 * - `anchorKey` is where a range extension measures from;
 * - `focusedKey` is where the reader is.
 *
 * Only the collection owner may drive `setVisibleOrder`/`resetScope`, because
 * only it can see the rows a virtualizer has not mounted. `eligibleKeys` is the
 * larger set a selection may SURVIVE in while `visibleOrderedKeys` is the
 * smaller set navigation and range extension address, so narrowing a search
 * query does not silently drop rows the reader already chose.
 */
export type HappierListMultiSelectionKey = string;

export type HappierListMultiSelectionState = Readonly<{
  isSelectionMode: boolean;
  selectedKeys: ReadonlySet<HappierListMultiSelectionKey>;
  anchorKey: HappierListMultiSelectionKey | null;
  focusedKey: HappierListMultiSelectionKey | null;
  visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
  eligibleKeys: ReadonlySet<HappierListMultiSelectionKey>;
  scopeKey: string;
  version: number;
}>;

/** The state above plus the one derived fact every consumer reads. */
export type HappierListMultiSelectionSnapshot = HappierListMultiSelectionState & Readonly<{
  count: number;
}>;

export type CreateHappierListMultiSelectionStateInput = Readonly<{
  scopeKey: string;
  visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
  eligibleKeys?: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null;
}>;

export type HappierListMultiSelectionAction =
  | Readonly<{ type: 'enter'; key?: HappierListMultiSelectionKey | null }>
  | Readonly<{ type: 'exit' }>
  | Readonly<{ type: 'clear' }>
  | Readonly<{ type: 'replace'; key: HappierListMultiSelectionKey }>
  | Readonly<{ type: 'toggle'; key: HappierListMultiSelectionKey }>
  | Readonly<{ type: 'selectRange'; targetKey: HappierListMultiSelectionKey; add?: boolean }>
  | Readonly<{ type: 'selectAllVisible' }>
  | Readonly<{ type: 'setSelectedKeys'; keys: readonly HappierListMultiSelectionKey[] }>
  | Readonly<{ type: 'setFocusedKey'; key: HappierListMultiSelectionKey | null }>
  | Readonly<{
      type: 'setVisibleOrder';
      visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
      eligibleKeys?: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null;
    }>
  | Readonly<{
      type: 'resetScope';
      scopeKey: string;
      visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
      eligibleKeys?: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null;
    }>;

function normalizeKeys(
  keys: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null | undefined,
): HappierListMultiSelectionKey[] {
  return Array.from(keys ?? [])
    .map((key) => key.trim())
    .filter(Boolean);
}

function createEligibleKeys(
  visibleOrderedKeys: readonly HappierListMultiSelectionKey[],
  eligibleKeys: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null | undefined,
): ReadonlySet<HappierListMultiSelectionKey> {
  if (!eligibleKeys) return new Set(normalizeKeys(visibleOrderedKeys));
  return new Set(normalizeKeys(eligibleKeys));
}

function setsEqual(
  left: ReadonlySet<HappierListMultiSelectionKey>,
  right: ReadonlySet<HappierListMultiSelectionKey>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function arraysEqual(
  left: readonly HappierListMultiSelectionKey[],
  right: readonly HappierListMultiSelectionKey[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function isEligible(
  state: HappierListMultiSelectionState,
  key: HappierListMultiSelectionKey | null,
): key is HappierListMultiSelectionKey {
  return typeof key === 'string' && state.eligibleKeys.has(key);
}

function firstSelectedVisibleKey(
  selectedKeys: ReadonlySet<HappierListMultiSelectionKey>,
  visibleOrderedKeys: readonly HappierListMultiSelectionKey[],
): HappierListMultiSelectionKey | null {
  for (const key of visibleOrderedKeys) {
    if (selectedKeys.has(key)) return key;
  }
  return null;
}

function pruneState(
  state: HappierListMultiSelectionState,
  visibleOrderedKeys: readonly HappierListMultiSelectionKey[],
  eligibleKeys: ReadonlySet<HappierListMultiSelectionKey>,
): Pick<HappierListMultiSelectionState, 'selectedKeys' | 'anchorKey' | 'focusedKey'> {
  const visible = new Set(visibleOrderedKeys);
  const selectedKeys = new Set<HappierListMultiSelectionKey>();
  for (const key of state.selectedKeys) {
    if (eligibleKeys.has(key)) selectedKeys.add(key);
  }
  const anchorKey = state.anchorKey && selectedKeys.has(state.anchorKey) && eligibleKeys.has(state.anchorKey)
    ? state.anchorKey
    : firstSelectedVisibleKey(selectedKeys, visibleOrderedKeys);
  const focusedKey = state.focusedKey && visible.has(state.focusedKey) && eligibleKeys.has(state.focusedKey)
    ? state.focusedKey
    : firstSelectedVisibleKey(selectedKeys, visibleOrderedKeys);
  return { selectedKeys, anchorKey, focusedKey };
}

function commit(
  state: HappierListMultiSelectionState,
  next: Omit<HappierListMultiSelectionState, 'version'>,
): HappierListMultiSelectionState {
  const same = state.isSelectionMode === next.isSelectionMode
    && state.scopeKey === next.scopeKey
    && state.anchorKey === next.anchorKey
    && state.focusedKey === next.focusedKey
    && arraysEqual(state.visibleOrderedKeys, next.visibleOrderedKeys)
    && setsEqual(state.eligibleKeys, next.eligibleKeys)
    && setsEqual(state.selectedKeys, next.selectedKeys);
  if (same) return state;
  return {
    ...next,
    version: state.version + 1,
  };
}

export function createInitialHappierListMultiSelectionState(
  input: CreateHappierListMultiSelectionStateInput,
): HappierListMultiSelectionState {
  const visibleOrderedKeys = normalizeKeys(input.visibleOrderedKeys);
  return {
    isSelectionMode: false,
    selectedKeys: new Set(),
    anchorKey: null,
    focusedKey: null,
    visibleOrderedKeys,
    eligibleKeys: createEligibleKeys(visibleOrderedKeys, input.eligibleKeys),
    scopeKey: input.scopeKey,
    version: 0,
  };
}

export function reduceHappierListMultiSelection(
  state: HappierListMultiSelectionState,
  action: HappierListMultiSelectionAction,
): HappierListMultiSelectionState {
  switch (action.type) {
    case 'enter': {
      const key = action.key ?? null;
      const selectedKeys = isEligible(state, key)
        ? new Set<HappierListMultiSelectionKey>([key])
        : new Set<HappierListMultiSelectionKey>();
      const anchorKey = selectedKeys.size > 0 ? key : null;
      return commit(state, {
        ...state,
        isSelectionMode: true,
        selectedKeys,
        anchorKey,
        focusedKey: anchorKey,
      });
    }
    case 'exit':
    case 'clear':
      return commit(state, {
        ...state,
        isSelectionMode: false,
        selectedKeys: new Set(),
        anchorKey: null,
        focusedKey: null,
      });
    case 'replace': {
      if (!isEligible(state, action.key)) return state;
      return commit(state, {
        ...state,
        isSelectionMode: true,
        selectedKeys: new Set([action.key]),
        anchorKey: action.key,
        focusedKey: action.key,
      });
    }
    case 'toggle': {
      if (!isEligible(state, action.key)) return state;
      const selectedKeys = new Set(state.selectedKeys);
      if (selectedKeys.has(action.key)) selectedKeys.delete(action.key);
      else selectedKeys.add(action.key);
      const nextAnchorKey = selectedKeys.size > 0 ? action.key : null;
      return commit(state, {
        ...state,
        isSelectionMode: selectedKeys.size > 0,
        selectedKeys,
        anchorKey: nextAnchorKey,
        focusedKey: nextAnchorKey,
      });
    }
    case 'selectRange': {
      const anchorKey = state.anchorKey
        && state.eligibleKeys.has(state.anchorKey)
        && state.visibleOrderedKeys.includes(state.anchorKey)
        ? state.anchorKey
        : null;
      const range = resolveHappierListMultiSelectionRange({
        visibleOrderedKeys: state.visibleOrderedKeys,
        anchorKey,
        targetKey: action.targetKey,
        eligibleKeys: state.eligibleKeys,
      });
      if (range.length === 0) return state;
      const selectedKeys = action.add === true
        ? new Set(state.selectedKeys)
        : new Set<HappierListMultiSelectionKey>();
      for (const key of range) selectedKeys.add(key);
      return commit(state, {
        ...state,
        isSelectionMode: true,
        selectedKeys,
        anchorKey: anchorKey ?? action.targetKey,
        focusedKey: action.targetKey,
      });
    }
    case 'selectAllVisible': {
      const selectedKeys = new Set<HappierListMultiSelectionKey>();
      for (const key of state.visibleOrderedKeys) {
        if (state.eligibleKeys.has(key)) selectedKeys.add(key);
      }
      const firstKey = firstSelectedVisibleKey(selectedKeys, state.visibleOrderedKeys);
      return commit(state, {
        ...state,
        isSelectionMode: selectedKeys.size > 0,
        selectedKeys,
        anchorKey: firstKey,
        focusedKey: firstKey,
      });
    }
    case 'setSelectedKeys': {
      const requested = new Set(normalizeKeys(action.keys));
      const selectedKeys = new Set<HappierListMultiSelectionKey>();
      for (const key of requested) {
        if (state.eligibleKeys.has(key)) selectedKeys.add(key);
      }
      const firstKey = firstSelectedVisibleKey(selectedKeys, state.visibleOrderedKeys);
      return commit(state, {
        ...state,
        isSelectionMode: selectedKeys.size > 0,
        selectedKeys,
        anchorKey: firstKey,
        focusedKey: firstKey,
      });
    }
    case 'setFocusedKey': {
      const focusedKey = isEligible(state, action.key) ? action.key : null;
      return commit(state, {
        ...state,
        focusedKey,
      });
    }
    case 'setVisibleOrder': {
      const visibleOrderedKeys = normalizeKeys(action.visibleOrderedKeys);
      const eligibleKeys = createEligibleKeys(visibleOrderedKeys, action.eligibleKeys);
      const pruned = pruneState(state, visibleOrderedKeys, eligibleKeys);
      return commit(state, {
        ...state,
        isSelectionMode: pruned.selectedKeys.size > 0,
        visibleOrderedKeys,
        eligibleKeys,
        ...pruned,
      });
    }
    case 'resetScope': {
      if (action.scopeKey === state.scopeKey) {
        return reduceHappierListMultiSelection(state, {
          type: 'setVisibleOrder',
          visibleOrderedKeys: action.visibleOrderedKeys,
          eligibleKeys: action.eligibleKeys,
        });
      }
      const visibleOrderedKeys = normalizeKeys(action.visibleOrderedKeys);
      const eligibleKeys = createEligibleKeys(visibleOrderedKeys, action.eligibleKeys);
      return commit(state, {
        isSelectionMode: false,
        selectedKeys: new Set(),
        anchorKey: null,
        focusedKey: null,
        visibleOrderedKeys,
        eligibleKeys,
        scopeKey: action.scopeKey,
      });
    }
    default:
      return state;
  }
}

export type HappierListMultiSelectionRangeInput = Readonly<{
  visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
  anchorKey: HappierListMultiSelectionKey | null;
  targetKey: HappierListMultiSelectionKey;
  eligibleKeys?: ReadonlySet<HappierListMultiSelectionKey> | null;
}>;

function isRangeKeyEligible(
  key: HappierListMultiSelectionKey,
  eligibleKeys: ReadonlySet<HappierListMultiSelectionKey> | null | undefined,
): boolean {
  return !eligibleKeys || eligibleKeys.has(key);
}

/**
 * The contiguous visible run between the anchor and the target, ineligible rows
 * dropped. With no anchor the target alone is the range, which is what makes a
 * Shift extension before any anchor exists behave like an ordinary pick rather
 * than selecting from the top of the list.
 */
export function resolveHappierListMultiSelectionRange(
  input: HappierListMultiSelectionRangeInput,
): HappierListMultiSelectionKey[] {
  if (!input.visibleOrderedKeys.includes(input.targetKey)) return [];
  if (!isRangeKeyEligible(input.targetKey, input.eligibleKeys)) return [];

  const anchorIndex = input.anchorKey ? input.visibleOrderedKeys.indexOf(input.anchorKey) : -1;
  const targetIndex = input.visibleOrderedKeys.indexOf(input.targetKey);
  if (targetIndex < 0) return [];
  if (anchorIndex < 0) return [input.targetKey];

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return input.visibleOrderedKeys
    .slice(start, end + 1)
    .filter((key) => isRangeKeyEligible(key, input.eligibleKeys));
}

/**
 * The platforms this monorepo's pointer/keyboard rules distinguish. It is the
 * same vocabulary React Native's own `Platform.OS` uses, so the collection owner
 * reads it from the mounted platform rather than taking it as an author prop,
 * and `apps/ui`'s keyboard platform is assignable to it unchanged.
 */
export type HappierPointerPlatform = 'macos' | 'ios' | 'windows' | 'linux' | 'android' | 'web';

export type HappierListMultiSelectionPointerAction = 'open' | 'toggle' | 'selectRange' | 'addRange';

export type HappierListMultiSelectionPointerInput = Readonly<{
  isSelectionMode: boolean;
  platform: HappierPointerPlatform;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}>;

function isApplePlatform(platform: HappierPointerPlatform): boolean {
  return platform === 'macos' || platform === 'ios';
}

/**
 * What one modified activation means. Once selection mode is on, an unmodified
 * activation toggles rather than opens: the reader is choosing a set, and
 * opening a detail mid-selection would discard the set they were building.
 */
export function resolveHappierListMultiSelectionPointerAction(
  input: HappierListMultiSelectionPointerInput,
): HappierListMultiSelectionPointerAction {
  const commandModifier = isApplePlatform(input.platform) ? input.metaKey : input.ctrlKey;
  if (input.shiftKey && commandModifier) return 'addRange';
  if (input.shiftKey) return 'selectRange';
  if (commandModifier || input.isSelectionMode) return 'toggle';
  return 'open';
}

/**
 * The keyboard half of the same rule, resolved over the collection's flattened
 * traversal order.
 *
 * Only the collection owner can answer this: `Shift+ArrowDown` extends from the
 * anchor to the row AFTER the cursor, and the row that key event reached cannot
 * see the row below it when the virtualizer has not mounted it. `null` means the
 * key is not a multi-selection key and the ordinary roving owner keeps it.
 */
export type HappierListMultiSelectionKeyboardIntent =
  | Readonly<{ kind: 'toggleFocused' }>
  | Readonly<{ kind: 'selectAllVisible' }>
  | Readonly<{ kind: 'exit' }>
  | Readonly<{ kind: 'extendRange'; toIndex: number }>;

export type HappierListMultiSelectionKeyboardInput = Readonly<{
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  platform: HappierPointerPlatform;
  entries: readonly HappierRovingEntry[];
  currentIndex: number;
  rtl: boolean;
}>;

function nextEnabledIndex(
  entries: readonly HappierRovingEntry[],
  fromIndex: number,
  step: number,
): number | null {
  for (let index = fromIndex + step; index >= 0 && index < entries.length; index += step) {
    if (entries[index]?.disabled !== true) return index;
  }
  return null;
}

export function resolveHappierListMultiSelectionKeyboardIntent(
  input: HappierListMultiSelectionKeyboardInput,
): HappierListMultiSelectionKeyboardIntent | null {
  const commandModifier = isApplePlatform(input.platform) ? input.metaKey : input.ctrlKey;
  if (input.key === 'Escape') return { kind: 'exit' };
  if (commandModifier && (input.key === 'a' || input.key === 'A') && !input.shiftKey) {
    return { kind: 'selectAllVisible' };
  }
  // Space is the platform's own "choose this row" key in a multi-selectable
  // listbox. It is claimed here only while the capability is mounted, so a
  // single-select List keeps handing Space to the row's own activation.
  if (input.key === ' ' || input.key === 'Spacebar') return { kind: 'toggleFocused' };
  if (!input.shiftKey) return null;
  const step = input.key === 'ArrowDown' || (input.key === 'ArrowRight' && !input.rtl) || (input.key === 'ArrowLeft' && input.rtl)
    ? 1
    : input.key === 'ArrowUp' || (input.key === 'ArrowLeft' && !input.rtl) || (input.key === 'ArrowRight' && input.rtl)
      ? -1
      : 0;
  if (step === 0) return null;
  if (input.currentIndex < 0) return null;
  const toIndex = nextEnabledIndex(input.entries, input.currentIndex, step);
  return toIndex === null ? null : { kind: 'extendRange', toIndex };
}

export type HappierPointerModifiers = Readonly<{
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}>;

const NO_MODIFIERS: HappierPointerModifiers = Object.freeze({
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
});

function readModifierFlag(source: Readonly<Record<string, unknown>>, name: string): boolean {
  return source[name] === true;
}

/**
 * The modifier keys carried by one press or key event.
 *
 * React Native Web puts them on the synthetic event, a raw DOM event carries
 * them directly, and a native press event has none at all. Reading all three
 * shapes here — rather than at each call site — is what keeps "was Shift held"
 * one answer instead of one per platform, and an event without modifiers is a
 * plain activation rather than a crash.
 */
export function readHappierPointerModifiers(event: unknown): HappierPointerModifiers {
  if (typeof event !== 'object' || event === null) return NO_MODIFIERS;
  const candidate = event as Readonly<Record<string, unknown>>;
  const shiftKey = readModifierFlag(candidate, 'shiftKey');
  const ctrlKey = readModifierFlag(candidate, 'ctrlKey');
  const metaKey = readModifierFlag(candidate, 'metaKey');
  if (shiftKey || ctrlKey || metaKey) return { shiftKey, ctrlKey, metaKey };
  const nativeEvent = candidate['nativeEvent'];
  if (typeof nativeEvent !== 'object' || nativeEvent === null) return { shiftKey, ctrlKey, metaKey };
  const native = nativeEvent as Readonly<Record<string, unknown>>;
  return {
    shiftKey: readModifierFlag(native, 'shiftKey'),
    ctrlKey: readModifierFlag(native, 'ctrlKey'),
    metaKey: readModifierFlag(native, 'metaKey'),
  };
}

const POINTER_PLATFORMS: ReadonlySet<string> = new Set<HappierPointerPlatform>([
  'macos',
  'ios',
  'windows',
  'linux',
  'android',
  'web',
]);

/**
 * The mounted platform, narrowed to the vocabulary the modifier rule uses.
 *
 * An unrecognised platform resolves to `web`, whose command modifier is
 * Control — the same choice every non-Apple desktop makes — rather than
 * refusing to resolve a selection gesture at all.
 */
export function resolveHappierPointerPlatform(platformOs: string): HappierPointerPlatform {
  return POINTER_PLATFORMS.has(platformOs) ? platformOs as HappierPointerPlatform : 'web';
}
