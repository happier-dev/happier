import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Platform, View } from 'react-native';
import type { HappierTextSelection } from '../presentation/portableTypes.js';
import { HappierTextField } from '../presentation/form/Fields.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Row, Stack } from './Layout.js';
import { usePluginUiFocusTarget, usePluginUiFocusTargetBindingInternal } from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { useListMultiSelectionStoreSnapshot, type ListMultiSelectionStore } from './ListMultiSelection.js';

/** Package-private chrome shared by List and every Collection presentation. Filtering stays with the data owner. */
export type ListCollectionSearch = Readonly<{
  label: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onComposingValueChange?: (value: string | null) => void;
  placeholder?: string;
  testID?: string;
}>;

export function useListCollectionSearch(search: ListCollectionSearch | undefined, rootRef: RefObject<View | null>) {
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
      if (event.key !== '/' || event.isComposing || event.defaultPrevented) return;
      const root = rootRef.current as unknown as { contains?: (node: Node) => boolean } | null;
      if (!document.activeElement || !root?.contains?.(document.activeElement)) return;
      const element = event.target;
      if (element instanceof HTMLElement && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))) return;
      if (target.focus()) event.preventDefault();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [enabled, rootRef, target]);
  const control = search === undefined ? null : <HappierTextField
    label={search.label} placeholder={search.placeholder ?? search.label} value={displayed}
    onChangeText={change} onCompositionChange={composition} onEscape={clear}
    autoCapitalize="none" autoCorrect={false} selection={selection} onSelectionChange={setSelection}
    controlRef={controlRef} leading={<Icon name="search" size="small" tone="muted" />} theme={theme} testID={search.testID}
  />;
  return { query, control };
}

export function ListCollectionHeader(props: Readonly<{
  search: ReactNode;
  store: ListMultiSelectionStore | null;
  selectable: boolean;
  children?: ReactNode;
}>) {
  const snapshot = useListMultiSelectionStoreSnapshot(props.store);
  const translate = usePluginTranslation();
  const mode = props.store === null || !props.selectable ? null : <Row gap="small" align="center">
    <Button title={snapshot.isSelectionMode
      ? translate('happier.plugin-ui.list.finishSelection', 'Done selecting')
      : translate('happier.plugin-ui.list.selectItems', 'Select')}
      variant="plain" testID="happier-list-selection-mode"
      onPress={() => { if (snapshot.isSelectionMode) props.store?.exit(); else props.store?.enter(); }} />
  </Row>;
  return !props.search && !mode && !props.children ? null : <Stack gap="small">{props.search}{mode}{props.children}</Stack>;
}
