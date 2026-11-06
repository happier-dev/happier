import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Platform, View } from 'react-native';
import type { HappierTextSelection } from '../presentation/portableTypes.js';
import { HappierTextField } from '../presentation/form/Fields.js';
import { resolveHappierUiPalette, useOptionalHappierUiPalette } from '../environment/context.js';
import { HAPPIER_RADIUS_V1 } from '../environment/radius.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../presentation/interaction/pressFeedback.js';
import { happierFocusRingStyle } from '../presentation/interaction/focusVisible.js';
import { HappierText } from '../presentation/text/Text.js';
import { useHappierPrecisePointer } from '../presentation/interaction/precisePointer.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Row, Stack } from './Layout.js';
import { usePluginUiFocusTarget, usePluginUiFocusTargetBindingInternal } from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { useListMultiSelectionStoreSnapshot, type ListMultiSelectionStore } from './ListMultiSelection.js';

/**
 * One narrowing that is in force, said inside the search field before the text ("is open", "view My work"):
 * `qualifier` is the quiet word naming what it constrains. Pressing the token removes the narrowing.
 */
export type ListCollectionSearchToken = Readonly<{
  key: string;
  qualifier?: string;
  label: string;
  onRemove: () => void;
}>;

/** Package-private chrome shared by List and every Collection presentation. Filtering stays with the data owner. */
export type ListCollectionSearch = Readonly<{
  label: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onComposingValueChange?: (value: string | null) => void;
  placeholder?: string;
  /** The narrowings in force, as removable tokens inside the field. */
  tokens?: readonly ListCollectionSearchToken[];
  testID?: string;
}>;

/** The `/` key focuses the field (web, with focus inside the list); the field says so as a key cap. */
const SEARCH_FOCUS_KEY = '/';

export function useListCollectionSearch(
  search: ListCollectionSearch | undefined,
  rootRef: RefObject<unknown>,
  /** The toolbar folded (a phone, a list beside a pane): tokens say only what tells them apart. */
  compact = false,
) {
  const [uncontrolledQuery, setUncontrolledQuery] = useState(search?.defaultValue ?? '');
  const query = search?.value ?? uncontrolledQuery;
  const [composingQuery, setComposingQuery] = useState<string | null>(null);
  const composingRef = useRef(composingQuery);
  composingRef.current = composingQuery;
  const [selection, setSelection] = useState<HappierTextSelection>({ start: query.length, end: query.length });
  const target = usePluginUiFocusTarget();
  const controlRef = usePluginUiFocusTargetBindingInternal(target);
  const theme = usePluginTheme();
  const displayed = composingQuery ?? query;
  const settle = (next: string) => {
    if (search?.value === undefined) setUncontrolledQuery(next);
    search?.onValueChange?.(next);
  };
  const change = (next: string) => {
    if (composingRef.current !== null) {
      composingRef.current = next;
      setComposingQuery(next);
      search?.onComposingValueChange?.(next);
    } else if (next !== query) settle(next);
  };
  const composition = (active: boolean) => {
    const next = active ? displayed : null;
    const settled = composingRef.current;
    composingRef.current = next;
    setComposingQuery(next);
    search?.onComposingValueChange?.(next);
    if (!active && settled !== null) settle(settled);
  };
  const clear = () => {
    if (displayed === '') return false;
    composingRef.current = null;
    setComposingQuery(null);
    search?.onComposingValueChange?.(null);
    settle('');
    return true;
  };
  useEffect(() => {
    if (composingRef.current !== null) return;
    setSelection(current => {
      const start = Math.min(current.start, query.length);
      const end = Math.min(current.end, query.length);
      return start === current.start && end === current.end ? current : { start, end };
    });
  }, [query]);
  const enabled = search !== undefined;
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const listener = (event: KeyboardEvent) => {
      if (event.key !== SEARCH_FOCUS_KEY || event.isComposing || event.defaultPrevented) return;
      const root = rootRef.current as unknown as { contains?: (node: Node) => boolean } | null;
      if (!document.activeElement || !root?.contains?.(document.activeElement)) return;
      const element = event.target;
      if (element instanceof HTMLElement && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))) return;
      if (target.focus()) event.preventDefault();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [enabled, rootRef, target]);
  const tokens = search?.tokens ?? [];
  const control = search === undefined ? null : <HappierTextField
    appearance="search" label={search.label} placeholder={search.placeholder ?? search.label} value={displayed}
    onChangeText={change} onCompositionChange={composition} onEscape={clear}
    autoCapitalize="none" autoCorrect={false} selection={selection} onSelectionChange={setSelection}
    controlRef={controlRef} leading={<Icon name="search" size="small" tone="muted" />} theme={theme} testID={search.testID}
    {...(tokens.length === 0 ? {} : { inline: <SearchTokens tokens={tokens} compact={compact} /> })}
    // The shortcut is a hardware-keyboard fact; touch platforms have no `/` to press.
    {...(Platform.OS !== 'web' ? {} : {
      trailing: <SearchShortcut {...(search.testID === undefined ? {} : { testID: `${search.testID}:shortcut` })} />,
    })}
  />;
  return { query, control };
}

/** The narrowings in force, each one press to remove (lab `.tok`: an inset chip, its qualifier quiet). */
function SearchTokens(props: Readonly<{ tokens: readonly ListCollectionSearchToken[]; compact: boolean }>) {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const translate = usePluginTranslation();
  return (
    <Row gap="xsmall" align="center" style={searchTokensStyle}>
      {props.tokens.map((token) => {
        const words = token.qualifier === undefined ? token.label : `${token.qualifier} ${token.label}`;
        return (
          <HappierPressable
            key={token.key}
            accessibilityRole="button"
            accessibilityLabel={translate('happier.plugin-ui.collection.search.removeToken', 'Remove {token}').replace('{token}', words)}
            onPress={token.onRemove}
            style={(state) => [searchTokenStyle, {
              backgroundColor: palette.fieldBackground,
              borderColor: palette.controlBorder,
              opacity: state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
              ...happierFocusRingStyle({ visible: state.focused, color: theme.colors.focus }),
            }]}
          >
            {/* Folded, the quiet qualifier gives its room to the label that tells tokens apart; the name keeps it. */}
            {token.qualifier === undefined || props.compact ? null : <HappierText variant="meta" tone="secondary" numberOfLines={1}>{token.qualifier}</HappierText>}
            <HappierText variant="meta" tone="neutral" numberOfLines={1} style={searchTokenLabelStyle}>{token.label}</HappierText>
          </HappierPressable>
        );
      })}
    </Row>
  );
}

/** The field's focus key, said the way the list footer says its keys. */
function SearchShortcut(props: Readonly<{ testID?: string }>) {
  return <CollectionKeyCap label={SEARCH_FOCUS_KEY} {...(props.testID === undefined ? {} : { testID: props.testID })} />;
}

/** One key, as a bordered control face (lab `.kbd`): the outline and field of the host's controls. */
export function CollectionKeyCap(props: Readonly<{ label: string; testID?: string }>) {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  return (
    <View testID={props.testID} style={[keyCapStyle, {
      // A caption-line square, plus its two border edges, keeps a single key legible.
      minWidth: theme.typography.caption.lineHeight + 2,
      paddingHorizontal: theme.spacing.xsmall,
      borderRadius: theme.radii.small,
      borderColor: palette.controlBorder,
      backgroundColor: palette.fieldBackground,
    }]}>
      <HappierText variant="meta" tone="muted">{props.label}</HappierText>
    </View>
  );
}

// The tokens stay inside the field: a narrow field truncates their labels and clips the rest rather than drawing
// them over the controls beside it (Views, Filters).
const searchTokensStyle = { flexShrink: 1, minWidth: 0, overflow: 'hidden' } as const;
const searchTokenLabelStyle = { flexShrink: 1, minWidth: 0 } as const;
const searchTokenStyle = {
  flexShrink: 1,
  minWidth: 0,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 4,
  paddingHorizontal: 7,
  borderRadius: HAPPIER_RADIUS_V1.sm,
  borderWidth: 1,
} as const;
const keyCapStyle = { borderWidth: 1, alignItems: 'center' } as const;

/**
 * The control that enters and leaves multi-selection: a touch-sized plain button ("Select" / "Done"). It ends a
 * phone's search row, so its words stay short.
 * Every row's own menu and Space also enter selection; this is the visible way in on touch. On a hover-capable
 * pointer, modifier-click, Space and the row menu already select, so the list draws no "Select" there, only
 * "Done" while a selection is open. `null` when the list cannot select.
 */
export function useListSelectionModeControl(store: ListMultiSelectionStore | null, selectable: boolean): ReactNode {
  const snapshot = useListMultiSelectionStoreSnapshot(store);
  const translate = usePluginTranslation();
  const precisePointer = useHappierPrecisePointer();
  if (store === null || !selectable) return null;
  if (!snapshot.isSelectionMode && precisePointer) return null;
  return (
    <Button title={snapshot.isSelectionMode
      ? translate('happier.plugin-ui.list.finishSelection', 'Done')
      : translate('happier.plugin-ui.list.selectItems', 'Select')}
      variant="plain" testID="happier-list-selection-mode"
      onPress={() => { if (snapshot.isSelectionMode) store.exit(); else store.enter(); }} />
  );
}

export function ListCollectionHeader(props: Readonly<{
  search: ReactNode;
  /** The selection-mode control (`useListSelectionModeControl`), or `null` when the page's own row places it. */
  selectionMode: ReactNode;
  children?: ReactNode;
  /** Space above the controls when they open a page's content under its page header (a page-sized list). */
  leadingGapPx?: number;
}>) {
  const mode = props.selectionMode;
  if (!props.search && !mode && !props.children) return null;
  // One row: the field takes the width, the selection control ends it. Never a row of its own for one button.
  const lead = props.search && mode
    ? <Row gap="small" align="center"><View style={searchFillStyle}>{props.search}</View>{mode}</Row>
    : props.search ?? mode;
  const controls = props.children ? <Stack gap="small">{lead}{props.children}</Stack> : lead;
  return props.leadingGapPx === undefined ? controls : <View style={{ paddingTop: props.leadingGapPx }}>{controls}</View>;
}

const searchFillStyle = { flex: 1, minWidth: 0 } as const;
