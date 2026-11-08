import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { View } from 'react-native';

import {
  resolveHappierUiPalette,
  useOptionalHappierUiLocalization,
  useOptionalHappierUiPalette,
} from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { settleHappierRaisedEdge } from '../layout/raisedEdge.js';
import { HappierScrollArea } from '../layout/Layout.js';
import { HappierSurface } from '../layout/Surface.js';
import { HAPPIER_MENU_ROW_METRICS, matchesHappierMenuQuery } from '../interaction/Menu.js';
import {
  useOptionalPluginUiPopoverScrollSource,
  useOptionalPluginUiPresentationHost,
} from '../../presentationHost/context.js';
import { HappierText } from '../text/Text.js';
import { useHappierTypeRoleStyle } from '../text/typeRole.js';
import {
  HappierFieldBoxChevron,
  HappierFieldBoxTrigger,
  resolveHappierFieldBoxLabel,
} from './FieldBox.js';
import {
  HAPPIER_FIELD_DISABLED_OPACITY,
  HappierTextField,
  planHappierSelectOptions,
  type HappierSelectOption,
} from './Fields.js';

/**
 * About seven rows: a Home with dozens of machines keeps its open field inside the step instead of
 * pushing the preview and the footer away; the rows scroll in place.
 */
const CHOICE_LIST_MAX_HEIGHT = 224;

/** The choice rows' own inset and the gap between the trigger and its rows. */
const CHOICE_ROW_PADDING = Object.freeze({ horizontal: 10, vertical: 6 });

/** More choices than fit the list's height without scrolling get a search line above them. */
const CHOICE_SEARCH_MIN_OPTIONS = 8;

/**
 * One fixed choice that is not a few short options: a field box that names the current reading
 * ("All agents", "Claude", "3 selected") and opens its choices. The same plan as `HappierSelect`
 * decides what is selected, disabled and what a press emits; only the presentation differs, so a
 * long or multiple choice stays one calm row until it is opened.
 *
 * Under a presentation host (Happier core and mounted plugin surfaces) the choices float in the
 * host's anchored popover at the field's width, so opening them never grows the row or moves the
 * form around it; a long list gets a search line, and choices that can be picked come before
 * disabled ones. Without a host (a bare render) the rows open in place beneath the field.
 */
export function HappierChoiceField<Value = string>(
  props: Readonly<{
    label: string;
    options: readonly HappierSelectOption<Value>[];
    value: Value | readonly Value[] | undefined;
    multiple?: boolean;
    maxSelections?: number;
    minimumSelections?: number;
    required?: boolean;
    disabled?: boolean;
    /** The reading while nothing is chosen ("All agents"); the shared "Choose…" when absent. */
    placeholder?: string;
    /**
     * A value the options cannot name (a period, a date range) is read here by the host. With
     * `onOpen` the field is a plain trigger for the type's own picker and draws no rows of its own.
     */
    reading?: string;
    onOpen?: () => void;
    /** Each new positive value shows the rows now; a host's repair or keyboard hand-off. */
    openRequest?: number;
    /** Bind the field's own visibility and search controls to a host's presentation commands. */
    renderControls?: (controls: Readonly<{
      open: boolean;
      disabled: boolean;
      query: string;
      searchable: boolean;
      onOpenChange: (open: boolean) => void;
      onQueryChange: (query: string) => void;
      render: (handlers: Readonly<{ onOpenChange: (open: boolean) => void; onQueryChange: (query: string) => void }>) => ReactNode;
    }>) => ReactNode;
    isEqual?: (left: Value, right: Value) => boolean;
    keyForOption?: (
      option: HappierSelectOption<Value>,
      index: number,
    ) => string;
    onChange: (value: Value | readonly Value[]) => void;
    theme: HappierUiTheme;
    testID?: string;
  }>,
) {
  const { theme } = props;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (props.openRequest) setOpen(true);
  }, [props.openRequest]);
  const palette =
    useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const localization = useOptionalHappierUiLocalization();
  const labelStyle = useHappierTypeRoleStyle('label', theme);
  const captionStyle = useHappierTypeRoleStyle('micro', theme);
  const plan = planHappierSelectOptions(props);
  const chosen = plan.options.filter((entry) => entry.selected);
  // One choice is named; several are counted, so the trigger stays one line.
  // The host's own reading names a value the choices cannot (a period; a picker's value) and keeps a
  // chosen value named while its choices are read again, so the field never flashes back to "Choose…".
  const hostReading = props.reading !== undefined && props.reading !== '' ? props.reading : null;
  const summary =
    hostReading !== null && (props.onOpen !== undefined || chosen.length === 0)
      ? hostReading
      : chosen.length === 0
        ? null
        : chosen.length === 1
          ? chosen[0]!.option.label
          : (localization?.translate(
              'happier.plugin-ui.select.count',
              `${chosen.length} selected`,
              { count: chosen.length },
            ) ?? `${chosen.length} selected`);
  const placeholder =
    props.placeholder ??
    localization?.translate('happier.plugin-ui.select.choose', 'Choose…') ??
    'Choose…';
  const reading = resolveHappierFieldBoxLabel({
    // A declared empty reading ("All agents") is a valid answer, not an unmade choice, so it keeps value ink.
    value:
      summary ?? (props.placeholder === undefined ? null : props.placeholder),
    placeholder,
    colors: {
      valueColor: theme.colors.text,
      placeholderColor: palette.placeholder,
    },
  });
  const disabled = props.disabled === true;
  const host = useOptionalPluginUiPresentationHost();
  const followScrollRef = useOptionalPluginUiPopoverScrollSource();
  const anchorRef = useRef<View | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  const floating = host !== null && props.onOpen === undefined;
  const searchable = floating && plan.options.length >= CHOICE_SEARCH_MIN_OPTIONS;
  // Choices that can be picked lead; disabled ones keep their relative order after them.
  const ordered = [
    ...plan.options.filter((entry) => !entry.disabled),
    ...plan.options.filter((entry) => entry.disabled),
  ];
  const visible = searchable
    ? ordered.filter((entry) => matchesHappierMenuQuery({
        label: entry.option.label,
        ...(entry.option.description === undefined ? {} : { description: entry.option.description }),
        query,
      }))
    : ordered;
  const rows = (style: 'floating' | 'inline', onOpenChange: (open: boolean) => void): ReactNode => visible.map((entry) => (
    <HappierPressable
      key={entry.key}
      testID={entry.option.testID}
      accessibilityRole={props.multiple ? 'checkbox' : 'radio'}
      accessibilityLabel={
        entry.option.accessibilityLabel ??
        (entry.option.description
          ? `${entry.option.label}: ${entry.option.description}`
          : entry.option.label)
      }
      checked={entry.selected}
      disabled={entry.disabled}
      onPress={() => {
        props.onChange(entry.nextValue());
        // A single choice settles the field; several stay open for the next pick.
        if (!props.multiple) onOpenChange(false);
      }}
      style={(state) => ({
        ...(style === 'floating'
          ? {
              minHeight: HAPPIER_MENU_ROW_METRICS.minHeightPx,
              justifyContent: 'center',
              paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
              paddingVertical: HAPPIER_MENU_ROW_METRICS.paddingVerticalPx,
            }
          : {
              paddingHorizontal: CHOICE_ROW_PADDING.horizontal,
              paddingVertical: CHOICE_ROW_PADDING.vertical,
              borderRadius: theme.radii.control,
            }),
        backgroundColor:
          entry.selected || state.hovered || state.focused
            ? palette.fieldBackground
            : 'transparent',
        opacity: entry.disabled ? 0.4 : 1,
      })}
    >
      <HappierText
        numberOfLines={1}
        style={{
          ...labelStyle,
          color: entry.selected
            ? theme.colors.text
            : theme.colors.secondaryText,
        }}
      >
        {entry.option.label}
      </HappierText>
      {entry.option.description ? (
        <HappierText
          // A floating row reads its whole description (a path tells two same-named checkouts apart): it wraps, never clips.
          {...(style === 'floating' ? {} : { numberOfLines: 1 })}
          style={{ ...captionStyle, color: theme.colors.secondaryText }}
        >
          {entry.option.description}
        </HappierText>
      ) : null}
    </HappierPressable>
  ));
  const noMatches = localization?.translate('happier.plugin-ui.select.noMatches', 'No matches') ?? 'No matches';
  const searchLabel = localization?.translate('happier.plugin-ui.select.search', 'Search') ?? 'Search';
  const render = ({ onOpenChange, onQueryChange }: Readonly<{
    onOpenChange: (open: boolean) => void; onQueryChange: (query: string) => void;
  }>) => (
    <View style={{ gap: theme.spacing.small, alignSelf: 'stretch' }}>
      <HappierPressable
        testID={
          props.testID === undefined
            ? undefined
            : props.onOpen
              ? props.testID
              : `${props.testID}.trigger`
        }
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${summary ?? placeholder}`}
        disabled={disabled}
        expanded={props.onOpen === undefined ? open : undefined}
        onPress={() => {
          if (props.onOpen) props.onOpen();
          else onOpenChange(!open);
        }}
        // A field box that cannot open yet (its choices are loading or failed) reads as unavailable, not as a
        // field that ignores the press.
        style={{ alignSelf: 'stretch', ...HAPPIER_FOCUS_RING_DELEGATED_STYLE, opacity: disabled ? HAPPIER_FIELD_DISABLED_OPACITY : 1 }}
      >
        {(state) => (
          <HappierFieldBoxTrigger
            // The choices hang from the drawn box at its width, not from the wider press row.
            boxRef={anchorRef}
            span="column"
            colors={{
              borderColor: palette.controlBorder,
              focusRing: state.focused ? theme.colors.focus : null,
              backgroundColor: palette.fieldBackground,
              edge: settleHappierRaisedEdge(palette.controlEdge, {
                focused: state.focused,
              }),
            }}
            trailing={
              <HappierFieldBoxChevron
                open={open}
                color={theme.colors.secondaryText}
              />
            }
          >
            <HappierText
              accessible={false}
              numberOfLines={1}
              style={reading.style}
            >
              {reading.text}
            </HappierText>
          </HappierFieldBoxTrigger>
        )}
      </HappierPressable>
      {open && floating && host
        ? host.renderPopover({
            open,
            anchorRef: anchorRef as RefObject<unknown>,
            ...(followScrollRef ? { followScrollRef } : {}),
            // A field's choices drop beneath it (or above, near the window's foot), never beside it.
            placement: 'bottom',
            presentation: 'dropdown',
            // Choices that tell themselves apart by a description (a checkout's path) open at the width that
            // reads it; plain labels keep the field's width.
            width: plan.options.some((entry) => entry.option.description !== undefined) ? 'content' : 'anchor',
            autoFocusOnOpen: true,
            onRequestClose: () => onOpenChange(false),
            content: (controls) => (
              // The choices stand on the host's menu step, like every anchored menu (absent, they float flat).
              <View style={[{ borderRadius: theme.radii.panel }, palette.menuLift ?? null]}>
              <HappierSurface
                materialRole="floating"
                nested
                style={{
                  borderRadius: theme.radii.panel,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface,
                  paddingVertical: HAPPIER_MENU_ROW_METRICS.sectionPaddingVerticalPx,
                }}
              >
                {searchable ? (
                  <HappierTextField
                    label={searchLabel}
                    placeholder={searchLabel}
                    value={query}
                    onChangeText={onQueryChange}
                    appearance="search"
                    autoCapitalize="none"
                    autoCorrect={false}
                    theme={theme}
                    {...(props.testID === undefined ? {} : { testID: `${props.testID}.search` })}
                  />
                ) : null}
                <View
                  role={props.multiple ? 'group' : 'radiogroup'}
                  accessibilityLabel={props.label}
                  testID={props.testID}
                >
                  <HappierScrollArea style={{ maxHeight: Math.max(0, Math.min(controls.maxHeight, CHOICE_LIST_MAX_HEIGHT * 1.5)) }}>
                    {visible.length === 0 ? (
                      <HappierText
                        style={{
                          ...captionStyle,
                          color: theme.colors.secondaryText,
                          paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
                          paddingVertical: HAPPIER_MENU_ROW_METRICS.paddingVerticalPx,
                        }}
                      >
                        {noMatches}
                      </HappierText>
                    ) : rows('floating', onOpenChange)}
                  </HappierScrollArea>
                </View>
              </HappierSurface>
              </View>
            ),
          })
        : null}
      {open && !floating && props.onOpen === undefined ? (
        <View
          role={props.multiple ? 'group' : 'radiogroup'}
          accessibilityLabel={props.label}
          testID={props.testID}
          style={{ gap: 2 }}
        >
          <HappierScrollArea style={{ maxHeight: CHOICE_LIST_MAX_HEIGHT }}>
            {rows('inline', onOpenChange)}
          </HappierScrollArea>
        </View>
      ) : null}
    </View>
  );
  return props.renderControls ? props.renderControls({ open, disabled, query, searchable, onOpenChange: setOpen, onQueryChange: setQuery, render })
    : render({ onOpenChange: setOpen, onQueryChange: setQuery });
}
