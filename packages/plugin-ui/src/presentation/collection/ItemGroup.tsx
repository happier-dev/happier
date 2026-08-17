import * as React from 'react';
import { I18nManager, View } from 'react-native';

import { useOptionalHappierUiLocalization } from '../../environment/context.js';
import type { HappierFocusable, HappierStyleProp } from '../portableTypes.js';
import {
  resolveHappierItemGroupConstraints,
  resolveHappierRovingSelection,
  resolveHappierRovingTabStop,
} from './semantics.js';

/** The real React Native pressable instance registered for roving focus. */
export type HappierItemGroupRadioFocusable = HappierFocusable;

type HappierItemGroupRadioContext = Readonly<{
  tabStopIndex: number | null;
  register(index: number, target: HappierItemGroupRadioFocusable | null): () => void;
  move(index: number, key: string): boolean;
}>;

export const HappierItemGroupSelectionContext = React.createContext<Readonly<{
  selectableItemCount: number;
  radioGroup?: HappierItemGroupRadioContext | null;
}> | null>(null);

export type HappierItemGroupItemBehaviorInput = Readonly<{
  role?: 'radio' | 'option' | 'button';
  itemGroupRadioIndex?: number;
  disabled?: boolean;
  busy?: boolean;
}>;

/**
 * The one item-side half of ItemGroup's composite-widget contract.
 *
 * Both Happier's product row and the public Plugin UI row use this hook. The
 * group owns projection and destination choice; the item owns only registering
 * its real focus target and forwarding a keyboard key to that owner.
 */
export function useHappierItemGroupItemBehavior(input: HappierItemGroupItemBehaviorInput) {
  const context = React.useContext(HappierItemGroupSelectionContext);
  const radioGroup = context?.radioGroup ?? null;
  const grouped = input.role === 'radio'
    && typeof input.itemGroupRadioIndex === 'number'
    && radioGroup !== null;
  const targetRef = React.useRef<HappierItemGroupRadioFocusable | null>(null);
  const setTargetRef = React.useCallback((target: HappierItemGroupRadioFocusable | null) => {
    targetRef.current = target;
  }, []);

  React.useEffect(() => {
    if (!grouped) return;
    return radioGroup.register(input.itemGroupRadioIndex!, targetRef.current);
  }, [grouped, input.itemGroupRadioIndex, radioGroup]);

  const onKeyDown = React.useCallback((key: string) => {
    if (!grouped || input.disabled === true || input.busy === true) return false;
    return radioGroup.move(input.itemGroupRadioIndex!, key);
  }, [grouped, input.busy, input.disabled, input.itemGroupRadioIndex, radioGroup]);

  return {
    grouped,
    onKeyDown,
    selectableItemCount: context?.selectableItemCount,
    tabStopIndex: grouped ? radioGroup.tabStopIndex : undefined,
    targetRef: setTargetRef,
  } as const;
}

type RadioChildProps = Readonly<{
  accessibilityRole?: string;
  webRole?: string;
  selected?: boolean;
  disabled?: boolean;
  loading?: boolean;
  busy?: boolean;
  onPress?: () => void;
  itemGroupRadioIndex?: number;
}>;

type RadioEntry = Readonly<{
  disabled: boolean;
  onPress: (() => void) | null;
  selected: boolean;
}>;

function projectRadioChildren(children: React.ReactNode, enabled: boolean): Readonly<{
  children: React.ReactNode;
  entries: readonly RadioEntry[];
}> {
  if (!enabled) return { children, entries: [] };
  const entries: RadioEntry[] = [];
  const project = (node: React.ReactNode): React.ReactNode => React.Children.map(node, (child) => {
    if (!React.isValidElement(child)) return child;
    if (child.type === React.Fragment) {
      const fragment = child as React.ReactElement<{ children?: React.ReactNode }>;
      return React.cloneElement(fragment, {}, project(fragment.props.children));
    }
    const element = child as React.ReactElement<RadioChildProps>;
    const isRadio = element.props.accessibilityRole === 'radio' || element.props.webRole === 'radio';
    if (!isRadio) return child;
    const itemGroupRadioIndex = entries.length;
    const onPress = typeof element.props.onPress === 'function' ? element.props.onPress : null;
    entries.push({
      disabled: element.props.disabled === true || element.props.loading === true || element.props.busy === true || onPress === null,
      onPress,
      selected: element.props.selected === true,
    });
    return React.cloneElement(element, { itemGroupRadioIndex });
  });
  return { children: project(children), entries };
}

export type HappierItemGroupBehaviorProps = Readonly<{
  children?: React.ReactNode;
  accessibilityRole?: 'radiogroup';
  accessibilityLabel?: string;
  selectableItemCount: number;
  renderContent(projectedChildren: React.ReactNode): React.ReactNode;
}>;

/** One radio projection, roving focus and group-selection owner for core/public. */
export function HappierItemGroupBehavior(props: HappierItemGroupBehaviorProps) {
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const projection = React.useMemo(
    () => projectRadioChildren(props.children, props.accessibilityRole === 'radiogroup'),
    [props.accessibilityRole, props.children],
  );
  const targets = React.useRef(new Map<number, HappierItemGroupRadioFocusable>());
  const register = React.useCallback((index: number, target: HappierItemGroupRadioFocusable | null) => {
    if (target) targets.current.set(index, target);
    else targets.current.delete(index);
    return () => {
      if (targets.current.get(index) === target) targets.current.delete(index);
    };
  }, []);
  const tabStopIndex = React.useMemo(() => resolveHappierRovingTabStop({
    entries: projection.entries,
    selectedIndex: projection.entries.findIndex((entry) => entry.selected && !entry.disabled),
  }), [projection.entries]);
  const move = React.useCallback((index: number, key: string) => {
    const next = resolveHappierRovingSelection({
      entries: projection.entries,
      currentIndex: index,
      key,
      rtl,
    });
    if (next === null) return false;
    projection.entries[next]?.onPress?.();
    targets.current.get(next)?.focus?.();
    return true;
  }, [projection.entries, rtl]);
  const value = React.useMemo(() => ({
    selectableItemCount: props.selectableItemCount,
    radioGroup: props.accessibilityRole === 'radiogroup' ? { tabStopIndex, register, move } : null,
  }), [move, props.accessibilityRole, props.selectableItemCount, register, tabStopIndex]);
  return (
    <HappierItemGroupSelectionContext.Provider value={value}>
      {props.renderContent(projection.children)}
    </HappierItemGroupSelectionContext.Provider>
  );
}

export type HappierItemGroupProps = Readonly<{
  children?: React.ReactNode;
  accessibilityRole?: 'radiogroup';
  accessibilityLabel?: string;
  testID?: string;
  style?: HappierStyleProp;
}>;

/** Portable group presentation wired to the shared behavior owner. */
export function HappierItemGroup(props: HappierItemGroupProps) {
  resolveHappierItemGroupConstraints({
    role: props.accessibilityRole,
    accessibilityLabel: props.accessibilityLabel,
    columns: 1,
    virtualized: false,
  });
  const selectableItemCount = React.Children.count(props.children);
  return (
    <HappierItemGroupBehavior
      accessibilityRole={props.accessibilityRole}
      accessibilityLabel={props.accessibilityLabel}
      selectableItemCount={selectableItemCount}
      renderContent={(children) => (
        <View
          role={props.accessibilityRole ?? 'group'}
          accessibilityRole={props.accessibilityRole}
          accessibilityLabel={props.accessibilityLabel}
          aria-label={props.accessibilityLabel}
          testID={props.testID}
          style={props.style}
        >
          {children}
        </View>
      )}
    >
      {props.children}
    </HappierItemGroupBehavior>
  );
}
