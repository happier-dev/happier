import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { I18nManager, View, type ViewStyle } from 'react-native';

import {
  HappierUiAnimationActivityProviderInternal,
  useOptionalHappierUiLocalization,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import { resolveHappierRovingTabStop } from '../collection/semantics.js';
import {
  useHappierNativeMinimumInteractiveTargetSize,
} from '../../environment/interactiveTarget.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierScrollArea } from '../layout/Layout.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HappierText } from '../text/Text.js';
import { readHappierTypeRoleTabular, resolveHappierTypeRoleStyle } from '../text/typeRole.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';

/** A tab's pointer height (lab `.tabs .tb`); a native touch platform's floor still wins. */
const TAB_STRIP_HEIGHT = 38;

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
  /** The badge's tone; quiet (`secondary`) unless the count is itself a state ("2 failing"). */
  badgeTone?: HappierTone;
  /** A quiet dot whose localized meaning is included in the accessible tab name. */
  marker?: string;
  disabled?: boolean;
  retention?: HappierTabRetention;
  children?: ReactNode;
}>;

/** Shared quiet status dot for tabs and compact layout selectors; the parent announces its meaning. */
export function HappierTabMarker(props: Readonly<{ color: string; testID?: string }>): ReactElement {
  return <View testID={props.testID} accessible={false} aria-hidden={true}
    style={{ width: 6, height: 6, borderRadius: 3, marginLeft: 6, flexShrink: 0, backgroundColor: props.color }} />;
}

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

/**
 * Private presentation composition seam. Semantic components that merely need
 * to pause work inside a retained panel may read absence as "not nested";
 * author code keeps using the strict public hook above so an accidental read
 * outside Tabs never fabricates an active interval.
 */
export function useOptionalHappierTabPanelActivityInternal(): HappierTabPanelActivity | null {
  return useContext(HappierTabPanelActivityContext);
}

const hiddenPanelStyle: ViewStyle = { display: 'none' };
const fillStyle: ViewStyle = { flex: 1, minHeight: 0 };

/**
 * How the tabbed region takes space. `content` (the default) sizes to the
 * selected panel, which is right inside a scroll area. `fill` gives the tab
 * root and the active panel the parent's remaining height, for a panel that
 * hosts a bounded view (a live Session, a self-scrolling source panel).
 */
export type HappierTabsLayout = 'content' | 'fill';

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
  /** Absent when the strip naming this panel lives in another surface. */
  nativeID?: string;
  labelledBy?: string;
  /**
   * Whether focus is inside this panel's own subtree.
   *
   * The platform's focus events bubble, so the panel box is the one place that
   * can answer this for every control a source renders inside it without the
   * tablist knowing what those controls are. It is reported to the tablist
   * rather than acted on here: recovery is a collection-level decision about
   * where focus goes next, and the panel is the thing disappearing.
   */
  onFocusWithinChange?: (focused: boolean) => void;
  fill?: boolean;
  children?: ReactNode;
}>): ReactElement {
  const ancestorActivity = useOptionalHappierTabPanelActivityInternal();
  const active = props.active && ancestorActivity?.active !== false;
  const [openInterval, setOpenInterval] = useState(() => new AbortController());
  let controller = openInterval;
  if (active && controller.signal.aborted) {
    // Returning to a retained panel opens its next interval. Deriving it during
    // render keeps the panel from ever observing the previous, aborted signal
    // as its current one.
    controller = new AbortController();
    setOpenInterval(controller);
  }

  useEffect(() => {
    if (!active) {
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
  }, [active, controller]);

  const activity = useMemo<HappierTabPanelActivity>(
    () => ({ active, activeSignal: controller.signal }),
    [active, controller],
  );

  return (
    <HappierTabPanelActivityContext.Provider value={activity}>
      <HappierUiAnimationActivityProviderInternal active={props.active}>
      <View
        role={props.labelledBy === undefined ? undefined : 'tabpanel'}
        nativeID={props.nativeID}
        aria-labelledby={props.labelledBy}
        // A retained panel keeps its subtree but must not occupy layout or be
        // reachable by assistive technology, or the surface would expose
        // several panels for one selected tab.
        aria-hidden={props.active ? undefined : true}
        accessibilityElementsHidden={!props.active}
        importantForAccessibility={props.active ? 'auto' : 'no-hide-descendants'}
        style={props.active ? (props.fill ? fillStyle : undefined) : hiddenPanelStyle}
        onFocus={() => { props.onFocusWithinChange?.(true); }}
        onBlur={() => { props.onFocusWithinChange?.(false); }}
      >
        {props.children}
      </View>
      </HappierUiAnimationActivityProviderInternal>
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
  /**
   * Who draws the tab strip. `host`: an enclosing frame (an aggregate that
   * mounted this surface for one of its tabs) already shows the strip, so this
   * renders only the selected panel, with the same active interval, and no
   * tablist of its own.
   */
  tabList?: 'shown' | 'host';
  layout?: HappierTabsLayout;
  sharedPanel?: ReactNode;
  /**
   * Controls that act on the tab set itself (add a tab, the selected tab's menu), at the strip's
   * trailing edge above its hairline. The strip scrolls beside them; they never scroll away.
   */
  trailing?: ReactNode;
}>) {
  const fill = props.layout === 'fill';
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
  const localization = useOptionalHappierUiLocalization();
  const typography = useOptionalHappierUiTypography();
  const labelStyle = resolveHappierTypeRoleStyle('label', props.theme, typography);
  const badgeStyle = resolveHappierTypeRoleStyle('caption', props.theme, typography);
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const instanceId = useId().replace(/:/gu, '');
  const tabs = Children.toArray(props.children)
    .filter((child): child is ReactElement<HappierTabDescriptor> => isValidElement(child))
    .map((child) => child.props);
  const admittedTabValues = new Set<string>();
  for (const tab of tabs) {
    if (admittedTabValues.has(tab.value)) {
      throw new Error(`Tabs contains duplicate tab value '${tab.value}'.`);
    }
    admittedTabValues.add(tab.value);
  }
  const selected = tabs.find((tab) => tab.value === props.value) ?? tabs.find((tab) => !tab.disabled);
  const tabRefs = useRef(new Map<string, View>());
  // Which TAB currently holds focus — its trigger or anything inside its panel —
  // published by the part that holds it while that part still exists. A removed
  // node cannot be identified afterwards, which is why this is recorded as the
  // reader moves rather than read back from the tree once the tab is gone.
  const focusedTabValue = useRef<string | null>(null);
  const recordFocusWithin = (value: string, focused: boolean): void => {
    if (focused) focusedTabValue.current = value;
    else if (focusedTabValue.current === value) focusedTabValue.current = null;
  };
  const visitedPanels = useRef(new Set<string>());
  const reportedReconciliation = useRef<Readonly<{ requested: string; resolved: string }> | null>(null);
  const selectedValue = selected?.value;
  // Keep the mismatch as a tuple of the two opaque values. Delimiters are not
  // identity: an author is allowed to use any string, including one that
  // contains a delimiter chosen by the implementation.
  const reconciliationTuple = selectedValue !== undefined && selectedValue !== props.value
    ? { requested: props.value, resolved: selectedValue }
    : null;

  // Rendering a fallback panel while leaving the controlled owner on a removed
  // value makes the visible tab and its data/persistence decisions diverge.
  // Report each exact mismatch once; a parent that intentionally declines the
  // update does not receive an effect-loop callback on every render.
  useEffect(() => {
    if (reconciliationTuple === null) {
      reportedReconciliation.current = null;
      return;
    }
    const reported = reportedReconciliation.current;
    if (reported?.requested === reconciliationTuple.requested && reported.resolved === reconciliationTuple.resolved) return;
    reportedReconciliation.current = reconciliationTuple;
    props.onValueChange(selectedValue!);
  }, [props.onValueChange, reconciliationTuple, selectedValue]);

  // Visiting is monotone, but only committed renders may change the marker.
  // An abandoned concurrent render must not erase a committed retained panel
  // or falsely record a tab that never reached the screen. The render path
  // therefore reads the last committed set and always mounts the selected tab
  // even before the commit effect records its first visit.
  const presentTabValues = useMemo(() => Children.toArray(props.children)
    .filter((child): child is ReactElement<HappierTabDescriptor> => isValidElement(child))
    .map((child) => child.props.value), [props.children]);
  const presentTabValueSet = useMemo(() => new Set(presentTabValues), [presentTabValues]);
  const committedVisitedPanels = visitedPanels.current;
  useLayoutEffect(() => {
    for (const value of visitedPanels.current) {
      if (!presentTabValueSet.has(value)) visitedPanels.current.delete(value);
    }
    if (selectedValue !== undefined) visitedPanels.current.add(selectedValue);
  }, [presentTabValueSet, presentTabValues, selectedValue]);
  const mountedPanels = tabs.flatMap((tab) => (
    tab.value === selectedValue || (tab.retention === 'retain' && committedVisitedPanels.has(tab.value))
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

  // A source withdraws a tab while a reader is standing on its trigger, or on a
  // control inside its panel — a panel whose very existence depends on
  // asynchronous provider evidence is the ordinary case, not the edge one. The
  // browser drops focus to the document body, which loses the tablist entirely,
  // so the collection hands focus to the trigger a reader would return to: its
  // single roving tab stop. Only a reader whose focus was still inside the
  // removed trigger or panel is moved — a reader who had already left keeps
  // their place.
  const fallbackTabValue = tabStopIndex === null ? undefined : tabs[tabStopIndex]?.value;
  useEffect(() => {
    const previouslyFocused = focusedTabValue.current;
    if (previouslyFocused === null) return;
    if (tabs.some((tab) => tab.value === previouslyFocused)) return;
    if (fallbackTabValue === undefined) {
      focusedTabValue.current = null;
      return;
    }
    focusedTabValue.current = fallbackTabValue;
    tabRefs.current.get(fallbackTabValue)?.focus?.();
  }, [fallbackTabValue, tabs]);

  if (props.tabList === 'host') {
    return (
      <View testID={props.testID} style={{ flex: 1, minHeight: 0 }}>
        {selected === undefined ? null : props.sharedPanel !== undefined ? (
          <HappierTabPanel active fill={fill}>{props.sharedPanel}</HappierTabPanel>
        ) : tabs.map((tab) => mountedPanels.includes(tab.value) ? (
          <HappierTabPanel key={tab.value} active={tab.value === selectedValue} fill={fill}>
            {tab.children}
          </HappierTabPanel>
        ) : null)}
      </View>
    );
  }

  return (
    <View testID={props.testID} style={fill ? { ...fillStyle, gap: props.theme.spacing.medium } : { gap: props.theme.spacing.medium }}>
      <View style={props.trailing === undefined ? undefined : { flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.xsmall }}>
      {/* The strip's one hairline across the full width; the selected tab's underline lands on it (lab `.tabs`). */}
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, backgroundColor: props.theme.colors.divider }} />
      <View style={props.trailing === undefined ? undefined : { flex: 1, minWidth: 0 }}>
      <HappierScrollArea horizontal>
        <View
          role="tablist"
          aria-label={props.ariaLabel}
          accessibilityLabel={props.ariaLabel}
          // The strip scrolls rather than wraps: a wrapped tablist reflows the
          // panel below it every time a source adds or withdraws a tab.
          // The tabs are spaced, not boxed: each underline is its label's own width.
          style={{ flexDirection: 'row', flexWrap: 'nowrap', gap: props.theme.spacing.large }}
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
                accessibilityLabel={[tab.title, tab.marker].filter(Boolean).join(' ')}
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
                onFocusChange={(isFocused) => { recordFocusWithin(tab.value, isFocused); }}
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
                  minHeight: Math.max(TAB_STRIP_HEIGHT, nativeMinimumTouchTarget ?? 0),
                  borderBottomWidth: 2,
                  borderBottomColor: isSelected ? props.theme.colors.accent : 'transparent',
                  // Inset: the strip scrolls, and its scroller clips anything drawn outside a tab.
                  ...happierFocusRingStyle({ visible: state.focused, color: props.theme.colors.focus, placement: 'inset' }),
                  opacity: state.disabled ? 0.4 : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
                })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.xsmall }}>
                  {tab.icon}
                  <HappierText style={{ ...labelStyle, color: isSelected ? props.theme.colors.accent : props.theme.colors.secondaryText }} tabularNumbers={readHappierTypeRoleTabular('label', typography)}>{tab.title}</HappierText>
                  {tab.badge ? <HappierText style={{ ...badgeStyle, color: props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[tab.badgeTone ?? 'secondary']] }} tabularNumbers>{tab.badge}</HappierText> : null}
                  {tab.marker ? <HappierTabMarker color={props.theme.colors.mutedText}
                    testID={`${props.testID ?? 'tabs'}:${tab.value}:marker`} /> : null}
                </View>
              </HappierPressable>
            );
          })}
        </View>
      </HappierScrollArea>
      </View>
      {props.trailing}
      </View>
      {/* `null`: the strip selects something its host draws elsewhere (a page's widget area), so no empty panel or gap follows it. */}
      {props.sharedPanel === null ? null : props.sharedPanel !== undefined && selected !== undefined ? (
        <HappierTabPanel
          active
          nativeID={`${instanceId}-panel-${tabs.indexOf(selected)}`}
          labelledBy={`${instanceId}-tab-${tabs.indexOf(selected)}`}
          onFocusWithinChange={(focused) => { recordFocusWithin(selected.value, focused); }}
          fill={fill}
        >
          {props.sharedPanel}
        </HappierTabPanel>
      ) : tabs.map((tab, tabIndex) => (mountedPanels.includes(tab.value) ? (
        <HappierTabPanel
          key={tab.value}
          active={tab.value === selectedValue}
          nativeID={`${instanceId}-panel-${tabIndex}`}
          labelledBy={`${instanceId}-tab-${tabIndex}`}
          onFocusWithinChange={(focused) => { recordFocusWithin(tab.value, focused); }}
          fill={fill}
        >
          {tab.children}
        </HappierTabPanel>
      ) : null))}
    </View>
  );
}
