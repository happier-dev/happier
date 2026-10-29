import { useCallback, useContext, useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactElement, type ReactNode, type RefObject } from 'react';
import { View } from 'react-native';

import {
  useOptionalPluginUiPresentationHost,
  useOptionalPluginUiPopoverScrollSource,
  type PluginUiPopoverContentControls,
  type PluginUiPopoverPresentation,
} from '../presentationHost/context.js';
import { HappierPressable, type HappierPressableStyleState } from '../presentation/interaction/Pressable.js';
import { HappierScrollArea, HappierStack } from '../presentation/layout/Layout.js';
import { HappierText } from '../presentation/text/Text.js';
import { HappierBadge } from '../presentation/content/Foundation.js';
import {
  HAPPIER_MENU_ROW_METRICS,
  HAPPIER_MENU_ROW_TEXT,
  resolveHappierMenuContent,
  resolveHappierMenuRadioGroups,
  useHappierMenuInteraction,
  type HappierMenuEntry,
} from '../presentation/interaction/Menu.js';
import type { HappierTextVariant, HappierTone } from '../presentation/semantics.js';
import { HAPPIER_PRESS_FEEDBACK_V1, happierPressTransitionStyle } from '../presentation/interaction/pressFeedback.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle } from '../presentation/interaction/focusVisible.js';
import { settleHappierRaisedEdge } from '../presentation/layout/raisedEdge.js';
import { HAPPIER_ICON_BUTTON_SIZE, HAPPIER_ICON_BUTTON_WELL_SIZE, resolveHappierIconButtonChrome } from '../presentation/interaction/iconButtonChrome.js';
import {
  HappierFieldBoxChevron,
  HappierFieldBoxTrigger,
  resolveHappierFieldBoxLabel,
} from '../presentation/form/FieldBox.js';
import { resolveHappierUiPalette, useOptionalHappierUiPalette, useOptionalHappierUiTypography } from '../environment/context.js';
import { resolveHappierTextStepStyle } from '../presentation/layout/pageText.js';
import { resolveHappierIconSize } from '../presentation/content/Icon.js';
import { useButtonFace } from './Button.js';
import { ComposerStatusBadge, type ComposerStatusBadgeProps } from './ComposerStatusBadge.js';
import { Icon, PluginUiIconGlyph, type IconName } from './Icon.js';
import { TaskStatusGlyph, type TaskStatusCategory } from './TaskStatusGlyph.js';
import { OverlayFieldTriggerContext } from './overlayFieldTrigger.js';
import { Surface } from './Surface.js';
import type { HappierFloatingRole } from '../presentation/layout/Surface.js';
import { SURFACE_PADDING_BY_SIZE } from './surfacePadding.js';
import { HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL } from '../presentation/layout/pageChrome.js';
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
   * source" opening the sources that can be added). `well` is the glyph alone in a round resting fill
   * (needs `triggerIcon`): the phone toolbar's Filters and ⋯ beside the search, where the buttons are the
   * object on their row. `status` is a quiet status line that opens its own explanation (a pull request's
   * merge readiness beside Merge): optional `triggerMarks`, the words, a quieter `triggerDetail` clause and a
   * caret, on the plain button's hover fill. `composerStatus` reuses the composer's status badge
   * inside this same owned trigger.
   */
  triggerAppearance?: 'text' | 'control' | 'primary' | 'well' | 'status' | 'composerStatus';
  /** `composerStatus` only: the badge's existing semantic tone and emphasis. */
  triggerComposerStatus?: Pick<ComposerStatusBadgeProps, 'tone' | 'emphasis'>;
  /**
   * Draws a caret after a plain `text` trigger, so a title that opens a menu reads as one ("Entry ⌄" in
   * a table's column header). Labelled appearances (`control`, `primary`) are buttons and never take it.
   */
  triggerDisclosure?: boolean;
  /**
   * The trigger's glyph. With the default `text` appearance the trigger is this glyph alone, an icon
   * button (a pane header's "+", a row's ⋯), and `trigger` stays the words it stands for. With a
   * labelled appearance (`control`, `primary`) the glyph leads the visible words, as a `Button`'s
   * leading icon does ("+ Link a PR or issue"). `triggerAccessibilityLabel` names the control either way.
   */
  triggerIcon?: IconName;
  /**
   * Draws the trigger's glyph as a task's status (`TaskStatusGlyph`) instead of `triggerIcon`: alone as an icon
   * button with the default `text` appearance (a task row's status, whose menu is the source's workflow), or
   * leading the words of a labelled appearance (a detail's Status button: glyph + "In Review"). The glyph is
   * decoration; `triggerAccessibilityLabel` names the control ("Change status, In Review").
   */
  triggerTaskStatus?: TaskStatusCategory;
  triggerAccessibilityLabel: string;
  /** `status` only: the quieter clause after the words, on the same line ("1 approval needed"). */
  triggerDetail?: string;
  /**
   * `status` only: one small mark per tracked condition, before the words, in its tone (`danger` failed,
   * `attention` needs the reader, `secondary` met, `muted` still waiting). Decoration: the words and the
   * opened content carry the meaning.
   */
  triggerMarks?: readonly HappierTone[];
  /** On a phone, the host's bottom sheet titled `title` (with `footer` pinned under the content) instead of an anchored popover. */
  sheet?: Readonly<{ title: string; footer?: ReactNode }>;
  /** Accessible name for the non-menu dialog surface; defaults to the trigger label. */
  contentAccessibilityLabel?: string;
  /**
   * What the floating layer is: `menu` (the default) is a small popover that keeps the host's light
   * coat; `panel` is a large anchored panel (a form, a picker with search, a detail view) that takes
   * the host's heavy dialog coat so its words stay legible over the page. The host owns the paint.
   */
  floatingRole?: HappierFloatingRole;
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
  /** Private: how many choices are in force, drawn as a count on a `well` trigger. */
  triggerCount?: number;
}>;

/** A group heading starts on the rows' own text edge, with the menu's row rhythm above it. */
const groupLabelStyle = {
  paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
  paddingTop: HAPPIER_MENU_ROW_METRICS.paddingVerticalPx,
} as const;

/** A text trigger's words and caret on one line, the caret kept close like a sorted title's arrow. */
const disclosureTriggerStyle = { flexDirection: 'row', alignItems: 'center', gap: 3, minWidth: 0 } as const;

/** A status trigger: marks, words and caret on one line, the words free to shrink before the caret does. */
const statusTriggerStyle = { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 } as const;
const statusMarksStyle = { flexDirection: 'row', alignItems: 'center', gap: 2 } as const;
const statusMarkStyle = { width: 4, height: 12, borderRadius: 2 } as const;
const statusWordsStyle = { flexShrink: 1 } as const;

/** Met reads as quiet ink and still-waiting as a faint slot; only trouble takes a colour. */
function resolveStatusMarkColor(tone: HappierTone, colors: ReturnType<typeof usePluginTheme>['colors']): string {
  if (tone === 'neutral' || tone === 'secondary') return colors.mutedText;
  if (tone === 'muted') return colors.divider;
  return colors[tone];
}

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
  triggerTextVariant = 'meta',
  triggerTextTone = 'neutral',
  triggerAppearance = 'text',
  triggerComposerStatus,
  triggerDisclosure = false,
  triggerIcon,
  triggerTaskStatus,
  triggerAccessibilityLabel,
  triggerDetail,
  triggerMarks,
  contentAccessibilityLabel: requestedContentAccessibilityLabel,
  floatingRole,
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
  sheet,
  triggerCount,
}: PopoverPresentationProps): ReactElement {
  // TypeScript callers cannot supply an element, and this keeps the same
  // one-owner contract for untyped/plugin-bundle callers before React Native
  // can mount nested interactive hosts.
  if (typeof trigger !== 'string') {
    throw new TypeError('Popover requires a plain text trigger because it owns the trigger interaction.');
  }
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
  // Only the plain-text and well appearances turn a glyph into an icon button; a labelled one keeps its words.
  const hasGlyph = triggerIcon !== undefined || triggerTaskStatus !== undefined;
  const iconOnly = hasGlyph && (triggerAppearance === 'text' || triggerAppearance === 'well');
  const well = iconOnly && triggerAppearance === 'well';
  // A labelled trigger is a Button's face, glyph and all: the view's primary, or the small secondary
  // of a toolbar's control row. Both hooks run on every render, whichever appearance draws.
  const primaryFace = useButtonFace('primary', 'normal', disabled === true);
  const controlFace = useButtonFace('secondary', 'small', disabled === true);
  const statusFace = useButtonFace('plain', 'small', disabled === true);
  const statusTrigger = !fieldTrigger && !iconOnly && triggerAppearance === 'status';
  const buttonFace = fieldTrigger ? null
    : triggerAppearance === 'primary' ? primaryFace
      : triggerAppearance === 'control' ? controlFace
        : statusTrigger ? statusFace : null;
  const iconChrome = (state: HappierPressableStyleState) => resolveHappierIconButtonChrome({
    size: well ? HAPPIER_ICON_BUTTON_WELL_SIZE : HAPPIER_ICON_BUTTON_SIZE, variant: well ? 'well' : 'plain',
    selected: state.selected,
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
    // The host's phone sheet is the surface: it titles, scrolls and pins the footer itself.
    if (controls.presentation === 'sheet') {
      return (
        <OverlayFieldTriggerContext.Provider value={null}>
          <HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL.Provider value={null}>
            <View style={sheetRowsInsetStyle}>{renderedChildren}</View>
          </HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL.Provider>
        </OverlayFieldTriggerContext.Provider>
      );
    }
    const contentBody = (
      <OverlayFieldTriggerContext.Provider value={null}>
        <FloatingScrollSurface maxHeight={controls.maxHeight} floatingRole={floatingRole}>
          {renderedChildren}
          {/* Anchored (a wide viewport, or a host without a sheet): the sheet's footer ends the same surface. */}
          {sheet?.footer == null ? null : <View style={anchoredSheetFooterStyle}>{sheet.footer}</View>}
        </FloatingScrollSurface>
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
  }, [children, contentAccessibilityLabel, floatingRole, isMenuPresentation, renderContent, sheet]);

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
        style={(state) => buttonFace ? buttonFace.style(state) : ({
          alignItems: 'center',
          justifyContent: 'center',
          // Like Happier's page field trigger: it hugs its choice beside a label, and under a label
          // on a narrow row it takes the row's width up to the field box's own maximum.
          // The field box inside draws the ring.
          ...(fieldTrigger ? { alignSelf: 'stretch', alignItems: 'stretch', ...HAPPIER_FOCUS_RING_DELEGATED_STYLE } : {}),
          ...(!fieldTrigger && iconOnly ? iconChrome(state).frame : {}),
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
              span="column"
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
        } : triggerAppearance === 'composerStatus' ? (
          <ComposerStatusBadge
            label={trigger}
            tone={triggerComposerStatus?.tone}
            emphasis={triggerComposerStatus?.emphasis}
            icon={triggerIcon}
            opensPopover
            expanded={open}
            testID={testID === undefined ? undefined : `${testID}:badge`}
          />
        ) : iconOnly ? (state) => (
          <View style={iconChrome(state).surface}>
            {triggerTaskStatus !== undefined
              ? <TaskStatusGlyph category={triggerTaskStatus} />
              : triggerIcon === undefined ? null : <Icon name={triggerIcon} size="medium" tone="neutral" />}
            {well && triggerCount !== undefined && triggerCount > 0 ? (
              <HappierBadge
                shape="capsule"
                color={theme.colors.onAccent}
                backgroundColor={theme.colors.accent}
                horizontalPadding={TRIGGER_COUNT_PADDING_X}
                verticalPadding={0}
                style={triggerCountStyle}
              >
                <HappierText accessible={false} variant="micro" tabularNumbers style={{ color: theme.colors.onAccent }}>
                  {String(triggerCount)}
                </HappierText>
              </HappierBadge>
            ) : null}
          </View>
        ) : statusTrigger ? (state) => statusFace.renderContent(state, {
          children: (
            <View style={statusTriggerStyle}>
              {triggerMarks === undefined || triggerMarks.length === 0 ? null : (
                <View style={statusMarksStyle}>
                  {triggerMarks.map((tone, index) => (
                    <View key={index} style={[statusMarkStyle, { backgroundColor: resolveStatusMarkColor(tone, theme.colors) }]} />
                  ))}
                </View>
              )}
              <HappierText accessible={false} variant={triggerTextVariant} tone={triggerTextTone} numberOfLines={1} style={statusWordsStyle}>
                {trigger}
                {triggerDetail === undefined || triggerDetail.length === 0 ? null : (
                  <HappierText accessible={false} variant={triggerTextVariant} tone="secondary">{`  ${triggerDetail}`}</HappierText>
                )}
              </HappierText>
              <HappierFieldBoxChevron open={open} color={theme.colors.secondaryText} />
            </View>
          ),
        }) : buttonFace ? (state) => buttonFace.renderContent(state, {
          // The glyph in the button's own ink, at a Button's leading-icon size.
          ...(triggerTaskStatus !== undefined ? { icon: <TaskStatusGlyph category={triggerTaskStatus} /> }
            : triggerIcon === undefined ? {} : {
              icon: <PluginUiIconGlyph name={triggerIcon} size={resolveHappierIconSize('small')} color={buttonFace.foreground} />,
            }),
          children: trigger,
        }) : triggerDisclosure && !iconOnly ? (
          <View style={disclosureTriggerStyle}>
            <HappierText accessible={false} variant={triggerTextVariant} tone={triggerTextTone} numberOfLines={1}>
              {trigger}
            </HappierText>
            <HappierFieldBoxChevron open={open} color={theme.colors.secondaryText} />
          </View>
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
            width: fieldTrigger ? 'anchor' : 'content',
            autoFocusOnOpen: shouldAutoFocusOnOpen,
            ...(sheet === undefined ? {} : { sheet }),
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

export type MenuProps = Omit<PopoverProps, 'children' | 'floatingRole'> & MenuContentProps & Readonly<{
  /** One controlled selected id per named radio group; radio rows never own checks locally. */
  radioGroups?: readonly MenuRadioGroup[];
  /** Draws each named group's heading above its rows (a Filters menu of labelled checkbox groups). */
  showGroupLabels?: boolean;
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
  /**
   * A touch sheet draws no resting highlight on the current choice (its check already says it); keyboard focus
   * still draws its ring.
   */
  restingHighlight?: boolean;
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
  restingHighlight = true,
}: MenuRowsProps): ReactElement {
  const theme = usePluginTheme();
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
  // The one menu row type (`HAPPIER_MENU_ROW_TEXT`), in the host's face, as core's own menus draw it.
  const typography = useOptionalHappierUiTypography();
  const labelTextStyle = useMemo(() => resolveHappierTextStepStyle(HAPPIER_MENU_ROW_TEXT.label, typography), [typography]);
  const subtitleTextStyle = useMemo(() => ({
    ...resolveHappierTextStepStyle(HAPPIER_MENU_ROW_TEXT.subtitle, typography),
    marginTop: HAPPIER_MENU_ROW_METRICS.subtitleGapPx,
  }), [typography]);
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
        highlighted={restingHighlight && index === selectedIndex}
        disabled={item.disabled}
        tabIndex={!item.disabled && index === selectedIndex ? 0 : -1}
        onKeyDown={(key) => onItemKey(key, index)}
        // Rows touch their neighbours and span the clipping menu surface: the row is its own hit area.
        hitReach={0}
        onPress={() => {
          if (item.disabled) return;
          setSelectedIndex(index);
          onSelect(item.id);
          if (item.kind !== 'checkbox') controls.requestClose('selection');
        }}
        style={(state) => ({
          minHeight: HAPPIER_MENU_ROW_METRICS.minHeightPx,
          paddingVertical: HAPPIER_MENU_ROW_METRICS.paddingVerticalPx,
          paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
          borderRadius: HAPPIER_MENU_ROW_METRICS.radiusPx,
          borderWidth: 0,
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
        {item.icon ? <Icon name={item.icon} size="small" tone={item.destructive ? 'danger' : 'secondary'} /> : null}
        <View style={{ flex: 1, flexShrink: 1 }}>
          <HappierText tone={item.destructive ? 'danger' : 'neutral'} style={labelTextStyle}>{item.label}</HappierText>
          {item.subtitle ? <HappierText tone="secondary" style={subtitleTextStyle}>{item.subtitle}</HappierText> : null}
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
          {showGroupLabels ? (
            <HappierText variant="micro" tone="secondary" style={groupLabelStyle}>{group.accessibilityLabel}</HappierText>
          ) : null}
          {renderEntries(createMenuRenderEntries(group.entries, resolvedRadioGroups))}
        </View>
      ))}
    </View>
  );
}

type MenuSheetProps = Readonly<{
  /** The phone sheet's title and its pinned footer; choices then apply in place and never close it. */
  sheet?: Readonly<{ title: string; footer?: ReactNode }>;
  /** How many choices are in force, drawn on a `well` trigger. */
  triggerCount?: number;
}>;

function MenuPresentation({
  items: ungroupedItems = [],
  groups = [],
  radioGroups = [],
  showGroupLabels = false,
  onSelect,
  onOpenChange,
  kind,
  sheet,
  triggerCount,
  ...popover
}: MenuProps & MenuSheetProps & Readonly<{ kind: MenuPresentationKind }>): ReactElement {
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
      {...(sheet === undefined ? {} : { sheet })}
      {...(triggerCount === undefined ? {} : { triggerCount })}
      renderContent={(controls) => (
        <MenuRows
          ungroupedItems={ungroupedItems}
          groups={groups}
          radioGroups={radioGroups}
          onSelect={onSelect}
          open={popover.open}
          triggerAccessibilityLabel={popover.triggerAccessibilityLabel}
          // A sheet of choices applies each one where it is touched: only Escape (or its own footer) closes it.
          controls={sheet === undefined ? controls : {
            ...controls,
            requestClose: (reason) => {
              if (reason === 'escape') controls.requestClose(reason);
            },
          }}
          initialFocusRef={initialFocusRef}
          showGroupLabels={showGroupLabels}
          restingHighlight={controls.presentation !== 'sheet'}
        />
      )}
    />
  );
}

const FLOATING_SURFACE_INSET = SURFACE_PADDING_BY_SIZE.small;
/** In the host's phone sheet, menu rows put their words on the sheet title's edge, the highlight inset from the sheet's. */
const sheetRowsInsetStyle = {
  paddingHorizontal: SURFACE_PADDING_BY_SIZE.medium.horizontal - HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
} as const;
/** An anchored sheet's footer sits on the menu rows' own edge, a row's rhythm below them. */
const anchoredSheetFooterStyle = {
  flexDirection: 'row',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 8,
  paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
  paddingTop: HAPPIER_MENU_ROW_METRICS.paddingVerticalPx,
} as const;
/** A count rides the round trigger's upper corner, clear of the glyph. */
const TRIGGER_COUNT_PADDING_X = 5;
const triggerCountStyle = {
  position: 'absolute',
  top: -3,
  right: -3,
  minWidth: 16,
  height: 16,
  justifyContent: 'center',
} as const;
const FLOATING_SURFACE_SCROLL_INSET = Object.freeze({
  paddingHorizontal: FLOATING_SURFACE_INSET.horizontal,
  paddingVertical: FLOATING_SURFACE_INSET.vertical,
});

/**
 * A floating layer's one surface: the rimmed Surface keeps its whole edge at the height cap and the
 * content scrolls inside it, so a long menu never ends in a flat cut. Floating content stands outside
 * the page column, so the page's sheet edge does not inset it either.
 */
function FloatingScrollSurface(props: Readonly<{ maxHeight: number; floatingRole?: HappierFloatingRole; children: ReactNode }>): ReactElement {
  // The Surface's 1px border on each side sits outside the scroller.
  const scrollMaxHeight = Math.max(0, props.maxHeight - 2);
  const theme = usePluginTheme();
  // It stands on the host's menu step, as core's floating menus do; a host without one floats it flat.
  const lift = (useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme)).menuLift;
  return (
    <HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL.Provider value={null}>
      <View style={[{ borderRadius: theme.radii.panel }, lift ?? null]}>
        <Surface padding="none" materialRole="floating" floatingRole={props.floatingRole}>
          <HappierScrollArea style={{ maxHeight: scrollMaxHeight }} contentContainerStyle={FLOATING_SURFACE_SCROLL_INSET}>
            <HappierStack gap={4}>{props.children}</HappierStack>
          </HappierScrollArea>
        </Surface>
      </View>
    </HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL.Provider>
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
      <FloatingScrollSurface maxHeight={maxHeight}>
        <MenuRows ungroupedItems={props.items} groups={props.groups} radioGroups={[]} onSelect={props.onSelect}
          open showGroupLabels triggerAccessibilityLabel={props.accessibilityLabel} controls={controls} initialFocusRef={initialFocusRef} />
      </FloatingScrollSurface>
    </OverlayFieldTriggerContext.Provider>
  </dialog>;
}

/** A bounded semantic menu over the shared Popover lifecycle. */
export function Menu(props: MenuProps): ReactElement {
  return <MenuPresentation {...props} kind="menu" />;
}

export type SheetMenuProps = MenuProps & Readonly<{
  /** The phone sheet's title and the controls pinned under its rows (a quiet Clear, one primary that closes). */
  sheet: Readonly<{ title: string; footer?: ReactNode }>;
  /** How many choices are in force, drawn as a count on a `well` trigger. */
  triggerCount?: number;
}>;

/**
 * A menu of several choices (checkbox and radio groups) that a phone presents as the host's bottom sheet —
 * titled, the rows applying as they are touched, the footer pinned under them — and a wider viewport anchors
 * like any menu, the footer ending its surface. `CollectionToolbar`'s folded Filters is one.
 */
export function SheetMenu(props: SheetMenuProps): ReactElement {
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
