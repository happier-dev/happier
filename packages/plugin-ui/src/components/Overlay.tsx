import { useCallback, useContext, useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactElement, type ReactNode, type RefObject } from 'react';
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
import { HappierPressable, type HappierPressableStyleState } from '../presentation/interaction/Pressable.js';
import { HappierScrollArea, HappierStack } from '../presentation/layout/Layout.js';
import { HappierText } from '../presentation/text/Text.js';
import {
  resolveHappierMenuContent,
  resolveHappierMenuRadioGroups,
  useHappierMenuInteraction,
  type HappierMenuEntry,
} from '../presentation/interaction/Menu.js';
import type { HappierTextVariant, HappierTone } from '../presentation/semantics.js';
import { HAPPIER_PRESS_FEEDBACK_V1, happierPressTransitionStyle } from '../presentation/interaction/pressFeedback.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle } from '../presentation/interaction/focusVisible.js';
import { resolveHappierButtonChrome } from '../presentation/interaction/buttonChrome.js';
import { settleHappierRaisedEdge } from '../presentation/layout/raisedEdge.js';
import { HAPPIER_ICON_BUTTON_SIZE, resolveHappierIconButtonChrome } from '../presentation/interaction/iconButtonChrome.js';
import {
  HappierFieldBoxChevron,
  HappierFieldBoxTrigger,
  resolveHappierFieldBoxLabel,
} from '../presentation/form/FieldBox.js';
import { resolveHappierUiPalette, useOptionalHappierUiPalette } from '../environment/context.js';
import { Icon, type IconName } from './Icon.js';
import { OverlayFieldTriggerContext } from './overlayFieldTrigger.js';
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
  /**
   * `text` (the default) draws the trigger as plain text. `control` draws it as
   * a compact control on the theme's control surface — the look of a toolbar
   * picker such as a view, sort or filter menu. `primary` draws it as the
   * view's one primary button, for a primary action that is a choice ("Add a
   * source" opening the sources that can be added).
   */
  triggerAppearance?: 'text' | 'control' | 'primary';
  /**
   * Draw the trigger as this glyph alone, an icon button, instead of its text: a pane header's "+" or
   * a row's ⋯. `trigger` stays the words the control stands for; `triggerAccessibilityLabel` names it.
   */
  triggerIcon?: IconName;
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
  triggerAppearance = 'text',
  triggerIcon,
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
  const theme = usePluginTheme();
  const host = useOptionalPluginUiPresentationHost();
  const followScrollRef = useOptionalPluginUiPopoverScrollSource();
  const fieldTrigger = useContext(OverlayFieldTriggerContext);
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const anchorRef = useRef<View | null>(null);
  const ownedFocusReturnRef = useRef<View | null>(null);
  const focusReturnRef = requestedFocusReturnRef ?? ownedFocusReturnRef;
  const toggle = useCallback(() => onOpenChange(triggerMode === 'context' ? true : !open), [onOpenChange, open, triggerMode]);
  const openContextMenu = useCallback((event: unknown) => {
    requestContextOpen(event, onOpenChange);
  }, [onOpenChange]);
  const contentAccessibilityLabel = requestedContentAccessibilityLabel ?? triggerAccessibilityLabel;
  const iconChrome = (state: HappierPressableStyleState) => resolveHappierIconButtonChrome({
    size: HAPPIER_ICON_BUTTON_SIZE, variant: 'plain', selected: state.selected,
    hovered: state.hovered, pressed: state.pressed, focused: state.focused, disabled: state.disabled,
    colors: { background: theme.colors.control, border: theme.colors.border,
      hover: theme.colors.control, pressed: theme.colors.control,
      selected: theme.colors.control, focus: theme.colors.focus },
  });
  const hasContent = renderContent !== undefined || children !== undefined;
  const isMenuPresentation = presentation !== 'popover';
  const shouldAutoFocusOnOpen = hasContent || autoFocusOnOpen;
  const content = useCallback((controls: PluginUiPopoverContentControls) => {
    const renderedChildren = renderContent ? renderContent(controls) : children;
    if (renderedChildren === undefined || renderedChildren === null) return null;
    const contentBody = (
      <OverlayFieldTriggerContext.Provider value={null}>
        <HappierScrollArea style={{ maxHeight: controls.maxHeight }}>
          <Surface padding="small" materialRole="floating">
            <HappierStack gap={4}>{renderedChildren}</HappierStack>
          </Surface>
        </HappierScrollArea>
      </OverlayFieldTriggerContext.Provider>
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
          // Like Happier's page field trigger: it hugs its choice beside a label, and under a label
          // on a narrow row it takes the row's width up to the field box's own maximum.
          // The field box inside draws the ring.
          ...(fieldTrigger ? { alignSelf: 'stretch', alignItems: 'stretch', ...HAPPIER_FOCUS_RING_DELEGATED_STYLE } : {}),
          ...(!fieldTrigger && triggerIcon !== undefined ? iconChrome(state).frame : {}),
          ...(!fieldTrigger && triggerIcon !== undefined ? { borderRadius: HAPPIER_ICON_BUTTON_SIZE / 2 } : {}),
          ...(!fieldTrigger && triggerIcon === undefined && triggerAppearance === 'primary'
            ? resolveHappierButtonChrome({
                theme,
                variant: 'primary',
                disabled: state.disabled,
                focused: state.focused,
                pressed: state.pressed,
                gloss: palette.accentGloss,
              }).style
            : {}),
          ...(!fieldTrigger && triggerIcon === undefined && triggerAppearance === 'control'
            ? {
                flexDirection: 'row',
                gap: theme.spacing.xsmall,
                paddingHorizontal: theme.spacing.medium,
                borderRadius: theme.radii.control,
                borderWidth: 1,
                borderColor: 'transparent',
                backgroundColor: theme.colors.control,
                ...happierFocusRingStyle({ visible: state.focused, color: theme.colors.focus }),
              }
            : {}),
          opacity: state.disabled ? 0.45 : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
          ...happierPressTransitionStyle(state.pressed, ['opacity']),
        })}
      >
        {fieldTrigger ? (state) => {
          // The field box shows the choice; the row title names the field.
          const label = resolveHappierFieldBoxLabel({
            value: fieldTrigger.value,
            placeholder: fieldTrigger.placeholder,
            colors: { valueColor: theme.colors.text, placeholderColor: palette.placeholder },
          });
          return (
            <HappierFieldBoxTrigger
              colors={{
                borderColor: palette.controlBorder,
                focusRing: state.focused ? theme.colors.focus : null,
                backgroundColor: palette.fieldBackground,
                edge: settleHappierRaisedEdge(palette.controlEdge, { focused: state.focused }),
              }}
              trailing={<HappierFieldBoxChevron open={open} color={theme.colors.secondaryText} />}
            >
              <HappierText accessible={false} numberOfLines={1} style={label.style}>{label.text}</HappierText>
            </HappierFieldBoxTrigger>
          );
        } : triggerIcon !== undefined ? (state) => (
          <View style={iconChrome({ ...state, pressed: false }).surface}>
            <Icon name={triggerIcon} size="medium" tone="neutral" />
          </View>
        ) : triggerAppearance === 'primary' ? (
          <HappierText
            accessible={false}
            variant="label"
            numberOfLines={1}
            style={{ color: resolveHappierButtonChrome({ theme, variant: 'primary', disabled: false, focused: false }).foreground }}
          >
            {trigger}
          </HappierText>
        ) : (
          <HappierText accessible={false} variant={triggerTextVariant} tone={triggerTextTone} numberOfLines={1}>
            {trigger}
          </HappierText>
        )}
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
  /** A consequential operation uses the theme's danger tone. */
  destructive?: boolean;
  /** Identity glyph owned by the existing public icon catalog. */
  icon?: IconName;
  /** Supporting identity or consequence, kept separate from the action label. */
  subtitle?: string;
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
  /** Chooser sections have visible headings as well as their semantic group names. */
  showGroupLabels?: boolean;
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
  showGroupLabels = false,
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
      // Toggling a checkbox row is one of several choices, so the menu stays
      // open for the next; an action or a radio choice completes the menu.
      if (item.kind !== 'checkbox') controls.requestClose('selection');
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
        accessibilityLabel={item.subtitle ? `${item.label} · ${item.subtitle}` : item.label}
        checked={checked}
        highlighted={index === selectedIndex}
        disabled={item.disabled}
        tabIndex={!item.disabled && index === selectedIndex ? 0 : -1}
        onKeyDown={(key) => onItemKey(key, index)}
        onPress={() => {
          if (item.disabled) return;
          setSelectedIndex(index);
          onSelect(item.id);
          if (item.kind !== 'checkbox') controls.requestClose('selection');
        }}
        style={(state) => ({
          ...(nativeMinimumTouchTarget === undefined ? {} : {
            minWidth: nativeMinimumTouchTarget,
            minHeight: nativeMinimumTouchTarget,
          }),
          paddingHorizontal: theme.spacing.medium,
          borderRadius: theme.radii.control,
          borderWidth: 2,
          borderColor: 'transparent',
          // Inset: menu rows span the floating surface, whose scroll area clips anything outside it.
          ...happierFocusRingStyle({ visible: state.focused, color: theme.colors.focus, placement: 'inset' }),
          backgroundColor: state.highlighted || state.hovered ? theme.colors.control : 'transparent',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.small,
          opacity: state.disabled ? 0.45 : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1,
        })}
      >
        {item.icon ? <Icon name={item.icon} size="medium" tone={item.destructive ? 'danger' : 'secondary'} /> : null}
        <View style={{ flex: 1, flexShrink: 1 }}>
          <HappierText tone={item.destructive ? 'danger' : 'neutral'}>{item.label}</HappierText>
          {item.subtitle ? <HappierText variant="caption" tone="secondary">{item.subtitle}</HappierText> : null}
        </View>
        {/* The checked state is drawn, not only announced. */}
        {checked === true ? <Icon name="check" size="small" tone="accent" /> : null}
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
          {showGroupLabels ? <HappierText variant="caption" tone="secondary">{group.accessibilityLabel}</HappierText> : null}
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

export type HostedAnchoredMenuProps = Readonly<{
  anchorRef: RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): void;
  accessibilityLabel: string;
  items: readonly MenuItem[];
  groups: readonly MenuGroup[];
  onSelect(id: string): void;
}>;

/** Hosted-realm anchor adapter. Native dialog owns modal focus/Escape; MenuRows owns choices. */
export function HostedAnchoredMenu(props: HostedAnchoredMenuProps): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const initialFocusRef = useRef<View | null>(null);
  const theme = usePluginTheme();
  const margin = theme.spacing.small;
  const maxHeight = Math.max(0, (props.anchorRef.current?.ownerDocument.defaultView?.innerHeight ?? 0) - margin * 2);
  const controls = useMemo<PluginUiPopoverContentControls>(() => ({ requestClose: () => props.onOpenChange(false), maxHeight }), [maxHeight, props.onOpenChange]);
  useLayoutEffect(() => {
    const node = dialog.current;
    const anchor = props.anchorRef.current;
    if (!node || !anchor) return;
    const realm = anchor.ownerDocument.defaultView;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      node.style.left = `${Math.max(margin, Math.min(rect.left, (realm?.innerWidth ?? 0) - node.offsetWidth - margin))}px`;
      node.style.top = `${Math.max(margin, Math.min(rect.bottom, (realm?.innerHeight ?? 0) - node.offsetHeight - margin))}px`;
    };
    node.showModal(); position();
    initialFocusRef.current?.focus?.();
    realm?.addEventListener('resize', position);
    realm?.addEventListener('scroll', position, true);
    return () => {
      realm?.removeEventListener('resize', position);
      realm?.removeEventListener('scroll', position, true);
      node.close();
      if (anchor.isConnected) anchor.focus();
    };
  }, [margin, props.anchorRef]);
  useLayoutEffect(() => { initialFocusRef.current?.focus?.(); }, [props.items, props.groups]);
  return <dialog ref={dialog} aria-label={props.accessibilityLabel}
    onCancel={event => { event.preventDefault(); props.onOpenChange(false); }}
    onClick={event => { if (event.target === event.currentTarget) props.onOpenChange(false); }}
    style={{ position: 'fixed', margin: 0, padding: 0, border: 0, background: 'transparent', color: 'inherit', maxWidth: `calc(100vw - ${margin * 2}px)` }}>
    <OverlayFieldTriggerContext.Provider value={null}>
      <HappierScrollArea style={{ maxHeight }}><Surface padding="small" materialRole="floating"><HappierStack gap={4}>
        <MenuRows ungroupedItems={props.items} groups={props.groups} radioGroups={[]} onSelect={props.onSelect}
          open showGroupLabels triggerAccessibilityLabel={props.accessibilityLabel} controls={controls} initialFocusRef={initialFocusRef} />
      </HappierStack></Surface></HappierScrollArea>
    </OverlayFieldTriggerContext.Provider>
  </dialog>;
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
