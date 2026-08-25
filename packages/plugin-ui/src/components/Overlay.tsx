import { useCallback, useMemo, useRef, type MutableRefObject, type ReactElement, type ReactNode, type RefObject } from 'react';
import { View } from 'react-native';

import {
  useHappierNativeMinimumInteractiveTargetSize,
} from '../environment/interactiveTarget.js';
import {
  useOptionalPluginUiPresentationHost,
  useOptionalPluginUiPopoverScrollSource,
  type PluginUiPopoverContentControls,
  type PluginUiPopoverPresentation,
} from '../presentationHost/context.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { HappierScrollArea, HappierStack } from '../presentation/layout/Layout.js';
import { HappierText } from '../presentation/text/Text.js';
import {
  resolveHappierMenuContent,
  resolveHappierMenuRadioGroups,
  useHappierMenuInteraction,
  type HappierMenuEntry,
} from '../presentation/interaction/Menu.js';
import type { HappierTextVariant, HappierTone } from '../presentation/semantics.js';
import { Surface } from './Surface.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type PopoverProps = Readonly<{
  open: boolean;
  onOpenChange(open: boolean): void;
  /**
   * Visible text for Popover's one built-in interactive trigger.
   *
   * Do not pass Button, IconButton, Action, Pressable, or another element here:
   * this Popover owns activation, focus return, keyboard state, and accessible
   * expanded state for its trigger.
   */
  trigger: string;
  /** Bounded semantic typography for the text inside Popover's owned trigger. */
  triggerTextVariant?: HappierTextVariant;
  /** Bounded semantic colour for the text inside Popover's owned trigger. */
  triggerTextTone?: HappierTone;
  triggerAccessibilityLabel: string;
  /** Accessible name for the non-menu dialog surface; defaults to the trigger label. */
  contentAccessibilityLabel?: string;
  children?: ReactNode;
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  disabled?: boolean;
  testID?: string;
  /** Optional composite-owner tab stop for the built-in trigger. */
  triggerTabIndex?: -1 | 0;
  /** Optional composite-owner focus target used when the overlay closes. */
  focusReturnRef?: RefObject<unknown>;
}>;

type OverlayTriggerMode = 'toggle' | 'context';

type PopoverPresentationProps = PopoverProps & Readonly<{
  /** Private composition flag: menus ask the incumbent host to focus their first item. */
  autoFocusOnOpen?: boolean;
  triggerMode?: OverlayTriggerMode;
  presentation?: PluginUiPopoverPresentation;
  /** The app Popover owns focus; menu content only nominates its active row. */
  initialFocusRef?: RefObject<unknown>;
  /** Private menu-content bridge for the incumbent Popover close lifecycle. */
  renderContent?: (controls: PluginUiPopoverContentControls) => ReactNode;
}>;

function requestContextOpen(event: unknown, onOpenChange: (open: boolean) => void) {
  const candidate = event as { preventDefault?: () => void; stopPropagation?: () => void } | null;
  candidate?.preventDefault?.();
  candidate?.stopPropagation?.();
  onOpenChange(true);
}

/**
 * Curated controlled popover. Positioning, portal selection, focus return,
 * outside dismissal, Escape and Android Back stay in Happier's incumbent
 * Popover owner, reached through the private presentation adapter.
 */
function PopoverPresentation({
  open,
  onOpenChange,
  trigger,
  triggerTextVariant = 'body',
  triggerTextTone = 'neutral',
  triggerAccessibilityLabel,
  contentAccessibilityLabel: requestedContentAccessibilityLabel,
  children,
  placement,
  disabled,
  testID,
  triggerTabIndex,
  focusReturnRef: requestedFocusReturnRef,
  autoFocusOnOpen = false,
  triggerMode = 'toggle',
  presentation = 'popover',
  initialFocusRef,
  renderContent,
}: PopoverPresentationProps): ReactElement {
  // TypeScript callers cannot supply an element, and this keeps the same
  // one-owner contract for untyped/plugin-bundle callers before React Native
  // can mount nested interactive hosts.
  if (typeof trigger !== 'string') {
    throw new TypeError('Popover requires a plain text trigger because it owns the trigger interaction.');
  }
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
  const host = useOptionalPluginUiPresentationHost();
  const followScrollRef = useOptionalPluginUiPopoverScrollSource();
  const anchorRef = useRef<View | null>(null);
  const ownedFocusReturnRef = useRef<View | null>(null);
  const focusReturnRef = requestedFocusReturnRef ?? ownedFocusReturnRef;
  const toggle = useCallback(() => onOpenChange(triggerMode === 'context' ? true : !open), [onOpenChange, open, triggerMode]);
  const openContextMenu = useCallback((event: unknown) => {
    requestContextOpen(event, onOpenChange);
  }, [onOpenChange]);
  const contentAccessibilityLabel = requestedContentAccessibilityLabel ?? triggerAccessibilityLabel;
  const hasContent = renderContent !== undefined || children !== undefined;
  const isMenuPresentation = presentation !== 'popover';
  const shouldAutoFocusOnOpen = hasContent || autoFocusOnOpen;
  const content = useCallback((controls: PluginUiPopoverContentControls) => {
    const renderedChildren = renderContent ? renderContent(controls) : children;
    if (renderedChildren === undefined || renderedChildren === null) return null;
    const contentBody = (
      <HappierScrollArea style={{ maxHeight: controls.maxHeight }}>
        <Surface padding="small">
          <HappierStack gap={4}>{renderedChildren}</HappierStack>
        </Surface>
      </HappierScrollArea>
    );
    return isMenuPresentation
      ? contentBody
      : (
        <View
          role="dialog"
          accessibilityLabel={contentAccessibilityLabel}
          aria-label={contentAccessibilityLabel}
        >
          {contentBody}
        </View>
      );
  }, [children, contentAccessibilityLabel, isMenuPresentation, renderContent]);

  return (
    <View ref={anchorRef} collapsable={false}>
      <HappierPressable
        controlRef={(node) => {
          if (requestedFocusReturnRef === undefined) ownedFocusReturnRef.current = node as View | null;
        }}
        onPress={toggle}
        onLongPress={triggerMode === 'context' ? openContextMenu : undefined}
        onContextMenu={triggerMode === 'context' ? openContextMenu : undefined}
        disabled={disabled}
        selected={open}
        expanded={open}
        hasPopup={isMenuPresentation ? 'menu' : hasContent ? 'dialog' : undefined}
        accessibilityLabel={triggerAccessibilityLabel}
        accessibilityRole="button"
        tabIndex={triggerTabIndex}
        testID={testID}
        style={(state) => ({
          ...(nativeMinimumTouchTarget === undefined ? {} : {
            minHeight: nativeMinimumTouchTarget,
            minWidth: nativeMinimumTouchTarget,
          }),
          alignItems: 'center',
          justifyContent: 'center',
          opacity: state.disabled ? 0.45 : state.pressed ? 0.75 : 1,
        })}
      >
        <HappierText accessible={false} variant={triggerTextVariant} tone={triggerTextTone}>
          {trigger}
        </HappierText>
      </HappierPressable>
      {host && open
        ? host.renderPopover({
            open,
            anchorRef: anchorRef as React.RefObject<unknown>,
            ...(followScrollRef ? { followScrollRef } : {}),
            focusReturnRef,
            initialFocusRef,
            placement: placement ?? 'auto',
            presentation,
            autoFocusOnOpen: shouldAutoFocusOnOpen,
            onRequestClose: () => onOpenChange(false),
            content,
          })
        : null}
    </View>
  );
}

export function Popover(props: PopoverProps): ReactElement {
  return <PopoverPresentation {...props} />;
}

type MenuItemBase = Readonly<{
  id: string;
  label: string;
  disabled?: boolean;
}>;

export type MenuItem = MenuItemBase & (
  | Readonly<{
      kind?: 'action';
      checked?: never;
      radioGroupId?: never;
    }>
  | Readonly<{
      kind: 'checkbox';
      /** Checkbox rows always publish an explicit checked state. */
      checked: boolean;
      radioGroupId?: never;
    }>
  | Readonly<{
      kind: 'radio';
      radioGroupId: string;
      /** Radio checks derive only from MenuProps.radioGroups. */
      checked?: never;
    }>
);

/** The one controlled selected id for a public radio-menu group. */
export type MenuRadioGroup = Readonly<{
  id: string;
  accessibilityLabel: string;
  selectedId: string | null;
}>;

/** A named public menu section whose item order stays menu-owned. */
export type MenuGroup = Readonly<{
  id: string;
  accessibilityLabel: string;
  items: readonly MenuItem[];
}>;

type MenuEntry = HappierMenuEntry<MenuItem>;

type MenuRenderEntry =
  | Readonly<{ kind: 'item'; entry: MenuEntry }>
  | Readonly<{ kind: 'radioGroup'; group: MenuRadioGroup; entries: readonly MenuEntry[] }>;

function createMenuRenderEntries(
  entries: readonly MenuEntry[],
  radioGroups: ReadonlyMap<string, MenuRadioGroup>,
): readonly MenuRenderEntry[] {
  const result: MenuRenderEntry[] = [];
  for (let entryIndex = 0; entryIndex < entries.length;) {
    const entry = entries[entryIndex]!;
    const item = entry.item;
    if (item.kind !== 'radio') {
      result.push({ kind: 'item', entry });
      entryIndex += 1;
      continue;
    }
    const group = radioGroups.get(item.radioGroupId);
    if (!group) throw new Error(`Radio menu item "${item.id}" has no resolved group.`);
    const radioEntries: MenuEntry[] = [];
    while (entries[entryIndex]?.item.kind === 'radio' && entries[entryIndex]?.item.radioGroupId === item.radioGroupId) {
      radioEntries.push(entries[entryIndex]!);
      entryIndex += 1;
    }
    result.push({ kind: 'radioGroup', group, entries: radioEntries });
  }
  return result;
}

type MenuContentProps =
  | Readonly<{
      /** Ungrouped rows render before any named semantic groups. */
      items: readonly MenuItem[];
      groups?: readonly MenuGroup[];
    }>
  | Readonly<{
      items?: never;
      groups: readonly MenuGroup[];
    }>;

export type MenuProps = Omit<PopoverProps, 'children'> & MenuContentProps & Readonly<{
  /** One controlled selected id per named radio group; radio rows never own checks locally. */
  radioGroups?: readonly MenuRadioGroup[];
  onSelect(id: string): void;
}>;

type MenuPresentationKind = 'menu' | 'dropdown' | 'context';

type MenuRowsProps = Readonly<{
  ungroupedItems: readonly MenuItem[];
  groups: readonly MenuGroup[];
  radioGroups: readonly MenuRadioGroup[];
  onSelect(id: string): void;
  open: boolean;
  triggerAccessibilityLabel: string;
  controls: PluginUiPopoverContentControls;
  initialFocusRef: MutableRefObject<View | null>;
}>;

function MenuRows({
  ungroupedItems,
  groups,
  radioGroups,
  onSelect,
  open,
  triggerAccessibilityLabel,
  controls,
  initialFocusRef,
}: MenuRowsProps): ReactElement {
  const theme = usePluginTheme();
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
  const content = useMemo(
    () => resolveHappierMenuContent({ items: ungroupedItems, groups }),
    [groups, ungroupedItems],
  );
  const { items } = content;
  const resolvedRadioGroups = useMemo(
    () => resolveHappierMenuRadioGroups({ items, radioGroups }),
    [items, radioGroups],
  );
  const ungroupedRenderEntries = useMemo(
    () => createMenuRenderEntries(content.ungroupedEntries, resolvedRadioGroups),
    [content.ungroupedEntries, resolvedRadioGroups],
  );
  const controlledInitialSelectedId = useMemo(() => {
    for (const item of items) {
      if (item.kind !== 'radio' || item.disabled) continue;
      if (resolvedRadioGroups.get(item.radioGroupId)?.selectedId === item.id) return item.id;
    }
    return null;
  }, [items, resolvedRadioGroups]);
  const itemRefs = useRef(new Map<string, View>());
  const focusItem = useCallback((index: number) => {
    const id = items[index]?.id;
    if (id) itemRefs.current.get(id)?.focus?.();
  }, [items]);
  const getItemLabel = useCallback((item: MenuItem) => item.label, []);
  const requestEscapeClose = useCallback(() => {
    controls.requestClose('escape');
  }, [controls]);
  const {
    selectedIndex,
    setSelectedIndex,
    handleKeyPress,
  } = useHappierMenuInteraction({
    items,
    open,
    initialSelectedId: controlledInitialSelectedId,
    onRequestClose: requestEscapeClose,
    getItemLabel,
    onKeyboardSelectionChange: focusItem,
  });
  const onItemKey = useCallback((key: string, currentIndex: number) => {
    return handleKeyPress(key, (item) => {
      onSelect(item.id);
      controls.requestClose('selection');
    }, currentIndex);
  }, [controls, handleKeyPress, onSelect]);
  const activeItemId = items[selectedIndex]?.id;
  const registerItemRef = useCallback((id: string, node: View | null) => {
    if (node) itemRefs.current.set(id, node);
    else itemRefs.current.delete(id);
    if (id === activeItemId) initialFocusRef.current = node;
  }, [activeItemId, initialFocusRef]);
  const renderItem = (entry: MenuEntry) => {
    const { item, index } = entry;
    const checked = item.kind === 'radio'
      ? resolvedRadioGroups.get(item.radioGroupId)?.selectedId === item.id
      : item.kind === 'checkbox' ? item.checked : undefined;
    return (
      <HappierPressable
        key={item.id}
        controlRef={(node) => registerItemRef(item.id, node as View | null)}
        accessibilityRole={item.kind === 'checkbox'
          ? 'checkbox'
          : item.kind === 'radio'
            ? 'radio'
            : 'menuitem'}
        webRole={item.kind === 'checkbox'
          ? 'menuitemcheckbox'
          : item.kind === 'radio'
            ? 'menuitemradio'
            : undefined}
        accessibilityLabel={item.label}
        checked={checked}
        highlighted={index === selectedIndex}
        disabled={item.disabled}
        tabIndex={!item.disabled && index === selectedIndex ? 0 : -1}
        onKeyDown={(key) => onItemKey(key, index)}
        onPress={() => {
          if (item.disabled) return;
          setSelectedIndex(index);
          onSelect(item.id);
          controls.requestClose('selection');
        }}
        style={(state) => ({
          ...(nativeMinimumTouchTarget === undefined ? {} : {
            minWidth: nativeMinimumTouchTarget,
            minHeight: nativeMinimumTouchTarget,
          }),
          paddingHorizontal: theme.spacing.medium,
          borderRadius: theme.radii.control,
          borderWidth: 2,
          borderColor: state.focused ? theme.colors.focus : 'transparent',
          backgroundColor: state.highlighted || state.hovered ? theme.colors.control : 'transparent',
          justifyContent: 'center',
          opacity: state.disabled ? 0.45 : state.pressed ? 0.9 : 1,
        })}
      >
        <HappierText>{item.label}</HappierText>
      </HappierPressable>
    );
  };
  const renderEntries = (entries: readonly MenuRenderEntry[]) => entries.map((entry) => entry.kind === 'radioGroup'
    ? (
      <View
        key={`radio-group:${entry.group.id}:${entry.entries[0]?.item.id ?? ''}`}
        role="group"
        accessibilityLabel={entry.group.accessibilityLabel}
        aria-label={entry.group.accessibilityLabel}
      >
        {entry.entries.map(renderItem)}
      </View>
    )
    : renderItem(entry.entry));

  return (
    <View
      role="menu"
      accessibilityRole="menu"
      accessibilityLabel={triggerAccessibilityLabel}
    >
      {renderEntries(ungroupedRenderEntries)}
      {content.groups.map((group) => (
        <View
          key={`menu-group:${group.id}`}
          role="group"
          accessibilityLabel={group.accessibilityLabel}
          aria-label={group.accessibilityLabel}
        >
          {renderEntries(createMenuRenderEntries(group.entries, resolvedRadioGroups))}
        </View>
      ))}
    </View>
  );
}

function MenuPresentation({
  items: ungroupedItems = [],
  groups = [],
  radioGroups = [],
  onSelect,
  onOpenChange,
  kind,
  ...popover
}: MenuProps & Readonly<{ kind: MenuPresentationKind }>): ReactElement {
  const initialFocusRef = useRef<View | null>(null);
  const placement = kind === 'dropdown' && popover.placement === undefined
    ? 'bottom'
    : popover.placement;
  const triggerMode: OverlayTriggerMode = kind === 'context' ? 'context' : 'toggle';

  return (
    <PopoverPresentation
      {...popover}
      placement={placement}
      onOpenChange={onOpenChange}
      autoFocusOnOpen
      triggerMode={triggerMode}
      presentation={kind}
      initialFocusRef={initialFocusRef}
      renderContent={(controls) => (
        <MenuRows
          ungroupedItems={ungroupedItems}
          groups={groups}
          radioGroups={radioGroups}
          onSelect={onSelect}
          open={popover.open}
          triggerAccessibilityLabel={popover.triggerAccessibilityLabel}
          controls={controls}
          initialFocusRef={initialFocusRef}
        />
      )}
    />
  );
}

/** A bounded semantic menu over the shared Popover lifecycle. */
export function Menu(props: MenuProps): ReactElement {
  return <MenuPresentation {...props} kind="menu" />;
}

/** Dropdowns use the same selection owner but prefer a below-trigger presentation. */
export function Dropdown(props: MenuProps): ReactElement {
  return <MenuPresentation {...props} kind="dropdown" />;
}

/** Context menus use the same selection owner, opened by click, right-click, or native long press. */
export function ContextMenu(props: MenuProps): ReactElement {
  return <MenuPresentation {...props} kind="context" />;
}
