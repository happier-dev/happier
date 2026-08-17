import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { I18nManager, View, type ViewStyle } from 'react-native';

import { useOptionalHappierUiLocalization } from '../../environment/context.js';
import { resolveHappierRovingTabStop } from '../collection/semantics.js';
import {
  useHappierNativeMinimumInteractiveTargetSize,
} from '../../environment/interactiveTarget.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierScrollArea } from '../layout/Layout.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HappierText } from '../text/Text.js';

/**
 * Whether leaving a panel keeps its subtree, declared per tab.
 *
 * Omission is `discard`, so no incumbent caller silently acquires retention,
 * and a panel holding revealed provider material declares `discard` explicitly
 * instead of relying on a heuristic that infers sensitivity.
 */
export type HappierTabRetention = 'retain' | 'discard';

export type HappierTabDescriptor = Readonly<{
  value: string;
  title: string;
  icon?: ReactNode;
  badge?: string;
  disabled?: boolean;
  retention?: HappierTabRetention;
  children?: ReactNode;
}>;

/**
 * A panel's current **active interval**, which is not the same fact as being
 * mounted.
 *
 * A retained panel keeps its subtree and its parse work across a tab switch
 * while its interval ends, so live reads, reveals and completion delivery stop
 * without discarding that work. Returning to the panel opens the next interval
 * with a new signal; the previous one stays aborted forever.
 */
export type HappierTabPanelActivity = Readonly<{
  active: boolean;
  activeSignal: AbortSignal;
}>;

const HappierTabPanelActivityContext = createContext<HappierTabPanelActivity | null>(null);

/**
 * Read the enclosing panel's active interval.
 *
 * This throws outside a panel rather than reporting a permanently active
 * interval: a caller that silently received `active: true` would keep
 * publishing after leave, which is the exact failure the signal exists to
 * prevent.
 */
export function useHappierTabPanelActivity(): HappierTabPanelActivity {
  const activity = useContext(HappierTabPanelActivityContext);
  if (activity === null) {
    throw new Error('useTabPanelActivity must be called inside a Tabs panel.');
  }
  return activity;
}

const hiddenPanelStyle: ViewStyle = { display: 'none' };

/**
 * One panel's mounted subtree and the single owner of its active interval.
 *
 * The interval belongs to the panel rather than to a map in the tablist so that
 * mount, deactivation, reactivation and unmount are one component lifetime with
 * one rule: an active panel holds an unaborted controller. Nothing else may
 * open or end an interval.
 */
function HappierTabPanel(props: Readonly<{
  active: boolean;
  nativeID: string;
  labelledBy: string;
  children?: ReactNode;
}>): ReactElement {
  const [openInterval, setOpenInterval] = useState(() => new AbortController());
  let controller = openInterval;
  if (props.active && controller.signal.aborted) {
    // Returning to a retained panel opens its next interval. Deriving it during
    // render keeps the panel from ever observing the previous, aborted signal
    // as its current one.
    controller = new AbortController();
    setOpenInterval(controller);
  }

  useEffect(() => {
    if (!props.active) {
      controller.abort();
      return;
    }
    // StrictMode and HMR probe setup -> cleanup -> setup against the same
    // state, so a replayed setup must reopen the interval its own cleanup just
    // ended instead of leaving an active panel holding an aborted signal.
    if (controller.signal.aborted) {
      setOpenInterval(new AbortController());
      return;
    }
    return () => { controller.abort(); };
  }, [controller, props.active]);

  const activity = useMemo<HappierTabPanelActivity>(
    () => ({ active: props.active, activeSignal: controller.signal }),
    [controller, props.active],
  );

  return (
    <HappierTabPanelActivityContext.Provider value={activity}>
      <View
        role="tabpanel"
        nativeID={props.nativeID}
        aria-labelledby={props.labelledBy}
        // A retained panel keeps its subtree but must not occupy layout or be
        // reachable by assistive technology, or the surface would expose
        // several panels for one selected tab.
        aria-hidden={props.active ? undefined : true}
        accessibilityElementsHidden={!props.active}
        importantForAccessibility={props.active ? 'auto' : 'no-hide-descendants'}
        style={props.active ? undefined : hiddenPanelStyle}
      >
        {props.children}
      </View>
    </HappierTabPanelActivityContext.Provider>
  );
}

/** One equality rule for controlled selection across core and plugin adapters. */
export function isHappierTabSelected(value: string, candidate: string): boolean {
  return value === candidate;
}

function isHappierTabDisabled(tab: object): boolean {
  return 'disabled' in tab && tab.disabled === true;
}

/** One RTL-aware roving destination rule for core and public tablists. */
export function resolveHappierTabKeySelection<T extends object>(input: Readonly<{
  tabs: readonly T[];
  currentIndex: number;
  key: string;
  rtl: boolean;
}>): number | null {
  if (input.tabs.length === 0) return null;
  if (input.key === 'Home') return input.tabs.findIndex((tab) => !isHappierTabDisabled(tab));
  if (input.key === 'End') {
    for (let index = input.tabs.length - 1; index >= 0; index -= 1) {
      const tab = input.tabs[index];
      if (tab && !isHappierTabDisabled(tab)) return index;
    }
    return null;
  }
  const direction = input.key === 'ArrowRight'
    ? (input.rtl ? -1 : 1)
    : input.key === 'ArrowLeft'
      ? (input.rtl ? 1 : -1)
      : 0;
  if (direction === 0) return input.key === ' ' || input.key === 'Spacebar' ? input.currentIndex : null;
  for (let offset = 1; offset <= input.tabs.length; offset += 1) {
    const index = (input.currentIndex + (direction * offset) + input.tabs.length) % input.tabs.length;
    const tab = input.tabs[index];
    if (tab && !isHappierTabDisabled(tab)) return index;
  }
  return null;
}

export function HappierTabs(props: Readonly<{
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  children?: ReactNode;
  theme: HappierUiTheme;
  testID?: string;
}>) {
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const instanceId = useId().replace(/:/gu, '');
  const tabs = Children.toArray(props.children)
    .filter((child): child is ReactElement<HappierTabDescriptor> => isValidElement(child))
    .map((child) => child.props);
  const selected = tabs.find((tab) => tab.value === props.value) ?? tabs.find((tab) => !tab.disabled);
  const tabRefs = useRef(new Map<string, View>());
  // Which trigger currently holds focus, published by the trigger itself while
  // it still exists. A removed node cannot be identified afterwards.
  const focusedTabValue = useRef<string | null>(null);
  const visitedPanels = useRef(new Set<string>());
  const reportedReconciliation = useRef<string | null>(null);
  const selectedValue = selected?.value;
  const reconciliationKey = selectedValue !== undefined && selectedValue !== props.value
    ? `${props.value}\u0000${selectedValue}`
    : null;

  // Rendering a fallback panel while leaving the controlled owner on a removed
  // value makes the visible tab and its data/persistence decisions diverge.
  // Report each exact mismatch once; a parent that intentionally declines the
  // update does not receive an effect-loop callback on every render.
  useEffect(() => {
    if (reconciliationKey === null) {
      reportedReconciliation.current = null;
      return;
    }
    if (reportedReconciliation.current === reconciliationKey) return;
    reportedReconciliation.current = reconciliationKey;
    props.onValueChange(selectedValue!);
  }, [props.onValueChange, reconciliationKey, selectedValue]);

  // Visiting is monotone and derived from the selection React is already
  // rendering, so recording it here needs no second render pass. A panel is
  // never prefetched: a retained tab mounts on its first visit and only then
  // survives a later switch.
  if (selectedValue !== undefined) visitedPanels.current.add(selectedValue);
  const mountedPanels = tabs.flatMap((tab) => (
    tab.value === selectedValue || (tab.retention === 'retain' && visitedPanels.current.has(tab.value))
      ? [tab.value]
      : []
  ));

  // The tablist reaches the same roving tab-stop rule every composite
  // collection uses, so a tablist whose controlled value names a disabled tab
  // still offers exactly one Tab-reachable trigger instead of none.
  const tabStopIndex = resolveHappierRovingTabStop({
    entries: tabs.map((tab) => ({ disabled: isHappierTabDisabled(tab) })),
    selectedIndex: selected === undefined ? -1 : tabs.indexOf(selected),
  });

  // A source withdraws a tab while a reader is standing on its trigger. The
  // browser drops focus to the document body, which loses the tablist entirely,
  // so the collection hands focus to the trigger a reader would return to: its
  // single roving tab stop. Only a reader whose focus was still inside this
  // tablist is moved — a reader who had already left keeps their place.
  const presentTabValues = tabs.map((tab) => tab.value).join('\u001f');
  const fallbackTabValue = tabStopIndex === null ? undefined : tabs[tabStopIndex]?.value;
  useEffect(() => {
    const previouslyFocused = focusedTabValue.current;
    if (previouslyFocused === null) return;
    if (presentTabValues.split('\u001f').includes(previouslyFocused)) return;
    if (fallbackTabValue === undefined) {
      focusedTabValue.current = null;
      return;
    }
    focusedTabValue.current = fallbackTabValue;
    tabRefs.current.get(fallbackTabValue)?.focus?.();
  }, [fallbackTabValue, presentTabValues]);

  return (
    <View testID={props.testID} style={{ gap: props.theme.spacing.medium }}>
      <HappierScrollArea horizontal>
        <View
          role="tablist"
          aria-label={props.ariaLabel}
          accessibilityLabel={props.ariaLabel}
          // The strip scrolls rather than wraps: a wrapped tablist reflows the
          // panel below it every time a source adds or withdraws a tab.
          style={{ flexDirection: 'row', flexWrap: 'nowrap', gap: props.theme.spacing.xsmall }}
        >
          {tabs.map((tab, tabIndex) => {
            const isSelected = isHappierTabSelected(selected?.value ?? '', tab.value);
            // Values are opaque product keys and may contain whitespace. Indexes
            // keep ARIA token identities valid without normalizing author data.
            const tabId = `${instanceId}-tab-${tabIndex}`;
            const panelId = `${instanceId}-panel-${tabIndex}`;
            return (
              <HappierPressable
                key={tab.value}
                accessibilityRole="tab"
                accessibilityLabel={tab.title}
                selected={isSelected}
                disabled={tab.disabled}
                tabIndex={tabIndex === tabStopIndex ? 0 : -1}
                nativeID={tabId}
                controls={panelId}
                controlRef={(node) => {
                  if (node) tabRefs.current.set(tab.value, node as View);
                  else tabRefs.current.delete(tab.value);
                }}
                onKeyDown={(key) => {
                  const nextIndex = resolveHappierTabKeySelection({
                    tabs,
                    currentIndex: tabIndex,
                    key,
                    rtl,
                  });
                  if (nextIndex === null) return false;
                  const next = tabs[nextIndex];
                  if (!next) return false;
                  props.onValueChange(next.value);
                  if (nextIndex !== tabIndex) tabRefs.current.get(next.value)?.focus?.();
                  return true;
                }}
                onPress={() => props.onValueChange(tab.value)}
                onFocusChange={(isFocused) => {
                  if (isFocused) focusedTabValue.current = tab.value;
                  else if (focusedTabValue.current === tab.value) focusedTabValue.current = null;
                }}
                testID={`${props.testID ?? 'tabs'}:${tab.value}`}
                style={(state) => ({
                  ...(nativeMinimumTouchTarget === undefined ? {} : {
                    minWidth: nativeMinimumTouchTarget,
                    minHeight: nativeMinimumTouchTarget,
                  }),
                  flexDirection: 'row',
                  alignItems: 'center',
                  // The scroller absorbs the overflow; a flexible trigger would
                  // instead compress until its own label is unreadable.
                  flexShrink: 0,
                  gap: props.theme.spacing.xsmall,
                  paddingHorizontal: props.theme.spacing.medium,
                  borderBottomWidth: state.focused ? 3 : 2,
                  borderBottomColor: state.focused ? props.theme.colors.focus : (isSelected ? props.theme.colors.accent : 'transparent'),
                  opacity: state.disabled ? 0.4 : state.pressed ? 0.75 : 1,
                })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.xsmall }}>
                  {tab.icon}
                  <HappierText variant="label" tone={isSelected ? 'accent' : 'secondary'}>{tab.title}</HappierText>
                  {tab.badge ? <HappierText variant="caption" tone="secondary">{tab.badge}</HappierText> : null}
                </View>
              </HappierPressable>
            );
          })}
        </View>
      </HappierScrollArea>
      {tabs.map((tab, tabIndex) => (mountedPanels.includes(tab.value) ? (
        <HappierTabPanel
          key={tab.value}
          active={tab.value === selectedValue}
          nativeID={`${instanceId}-panel-${tabIndex}`}
          labelledBy={`${instanceId}-tab-${tabIndex}`}
        >
          {tab.children}
        </HappierTabPanel>
      ) : null))}
    </View>
  );
}
