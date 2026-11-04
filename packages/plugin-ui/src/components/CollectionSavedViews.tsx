import * as React from 'react';

import { Button } from './Button.js';
import { TextField } from './Form.js';
import { Row, Stack } from './Layout.js';
import { Dropdown, type MenuItem, type MenuRadioGroup } from './Overlay.js';
import { Status } from './Status.js';

/** Admitted display identity; the caller retains the saved filter and its storage. */
export type CollectionSavedViewItem = Readonly<{ id: string; label: string }>;

export type CollectionSavedViewsLabels = Readonly<{
  title: string;
  /** Omit when the collection always selects a saved/default item. */
  unselected?: string;
  actions: string;
  create: string;
  rename: string;
  update: string;
  delete: string;
  modified: string;
  name: string;
  confirm: string;
  cancel: string;
}>;

export type CollectionSavedViewsControlProps<T extends CollectionSavedViewItem> = CollectionSavedViewsSelectionProps<T> & Readonly<{
  modified: boolean;
  labels: CollectionSavedViewsLabels;
  busy?: boolean;
  /** Domain-owned notices follow the naming row in the same details stack. */
  notices?: React.ReactNode;
  /** Resolve true only when the caller's authoritative mutation accepted the name. */
  onCreate: (label: string) => Promise<boolean>;
  onRename: (item: T, label: string) => Promise<boolean>;
  onUpdate: (item: T) => void;
  onDelete: (item: T) => void;
}>;

/** Selection-only composition for domains that provide their own editing Actions. */
export type CollectionSavedViewsSelectionProps<T extends CollectionSavedViewItem> = Readonly<{
  /** Stable captured Account authority key, or its bound host facade. */
  scope: string | object;
  items: readonly T[];
  selectedId: string | null;
  labels: Pick<CollectionSavedViewsLabels, 'title' | 'unselected'>;
  disabled?: boolean;
  onSelect: (id: string | null) => void;
}>;

type NameDraft =
  | Readonly<{ kind: 'create'; label: string }>
  | Readonly<{ kind: 'rename'; id: string; label: string }>;

type ControlState = Readonly<{
  scope: CollectionSavedViewsControlProps<CollectionSavedViewItem>['scope'];
  draft: NameDraft | null;
}>;

const VIEW_ITEM_PREFIX = 'view:';
const VIEWS_RADIO_GROUP = 'views';
const OPERATION_CREATE = 'operation:create';
const OPERATION_RENAME = 'operation:rename';
const OPERATION_UPDATE = 'operation:update';
const OPERATION_DELETE = 'operation:delete';

/**
 * The shared controlled picker owner. Catalogs, selection persistence and any
 * membership/editing Actions remain with the caller; no writer is required.
 */
export function useCollectionSavedViewsSelection<T extends CollectionSavedViewItem>(
  props: CollectionSavedViewsSelectionProps<T>,
): Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: T | null;
  items: readonly MenuItem[];
  radioGroups: readonly MenuRadioGroup[];
  /** Returns false for a domain-owned action item. */
  selectItem: (id: string) => boolean;
}> {
  const { scope, items, selectedId, labels, disabled, onSelect } = props;
  const [state, setState] = React.useState(() => ({ scope, open: false }));
  if (state.scope !== scope) setState({ scope, open: false });
  const onOpenChange = React.useCallback((open: boolean) => {
    setState((current) => current.scope !== scope ? current : { ...current, open });
  }, [scope]);
  const selected = React.useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const menuItems = React.useMemo((): MenuItem[] => [
    ...(labels.unselected === undefined ? [] : [{
      id: VIEW_ITEM_PREFIX, label: labels.unselected, kind: 'radio' as const,
      radioGroupId: VIEWS_RADIO_GROUP, disabled,
    }]),
    ...items.map((item): MenuItem => ({
      id: VIEW_ITEM_PREFIX + item.id, label: item.label, kind: 'radio',
      radioGroupId: VIEWS_RADIO_GROUP, disabled,
    })),
  ], [disabled, items, labels.unselected]);
  const selectedMenuId = selected !== null ? VIEW_ITEM_PREFIX + selected.id
    : labels.unselected !== undefined ? VIEW_ITEM_PREFIX : null;
  const radioGroups = React.useMemo((): MenuRadioGroup[] => menuItems.length === 0 ? [] : [{
    id: VIEWS_RADIO_GROUP, accessibilityLabel: labels.title,
    selectedId: selectedMenuId,
  }], [labels.title, menuItems.length, selectedMenuId]);
  const selectItem = React.useCallback((id: string) => {
    if (!id.startsWith(VIEW_ITEM_PREFIX)) return false;
    onOpenChange(false);
    onSelect(id.slice(VIEW_ITEM_PREFIX.length) || null);
    return true;
  }, [onOpenChange, onSelect]);
  return { open: state.open, onOpenChange, selected, items: menuItems, radioGroups, selectItem };
}

/**
 * Controlled saved-view picker and naming presentation for CollectionToolbar.lens.
 * The caller owns selection, filter comparison, mutation acceptance and notices;
 * Dropdown retains menu focus/dismissal. Only the temporary name draft lives here.
 * The captured scope keys local presentation state, withdrawing private drafts
 * and an open menu before another Account's items or callbacks can be displayed.
 */
export function useCollectionSavedViewsControl<T extends CollectionSavedViewItem>(
  props: CollectionSavedViewsControlProps<T>,
): Readonly<{ control: React.ReactElement; details: React.ReactElement | null }> {
  const { scope, items, selectedId, modified, labels, disabled, busy, notices,
    onSelect, onCreate, onRename, onUpdate, onDelete } = props;
  const [state, setState] = React.useState<ControlState>(() => ({ scope, draft: null }));
  // As with PluginUiProvider's bound-host state, retire during render so an old
  // Account's private name is never painted for the next authority, even once.
  if (state.scope !== scope) setState({ scope, draft: null });
  const { draft } = state;
  const setDraft = React.useCallback((next: React.SetStateAction<NameDraft | null>) => {
    setState((current) => current.scope !== scope ? current : {
      ...current, draft: typeof next === 'function' ? next(current.draft) : next,
    });
  }, [scope]);
  const writable = !disabled && !busy;
  const selection = useCollectionSavedViewsSelection({ scope, items, selectedId, labels, disabled: !writable, onSelect });
  const { selected } = selection;
  const cancelDraft = React.useCallback(() => { setDraft(null); }, [setDraft]);
  const changeDraft = React.useCallback((label: string) => {
    setDraft((current) => current === null ? current : { ...current, label });
  }, [setDraft]);
  const commitDraft = React.useCallback(async () => {
    if (draft === null || busy) return;
    // A rename receives the latest admitted item, preserving a concurrent lens edit.
    const target = draft.kind === 'rename' ? items.find((item) => item.id === draft.id) : undefined;
    const applied = draft.kind === 'create'
      ? await onCreate(draft.label)
      : target !== undefined && await onRename(target, draft.label);
    // Editing or cancelling during settlement is a newer intent.
    if (applied) setDraft((current) => current === draft ? null : current);
  }, [busy, draft, items, onCreate, onRename, setDraft]);

  const operations = React.useMemo((): MenuItem[] => [
    { id: OPERATION_CREATE, label: labels.create, disabled: !writable || draft !== null },
    ...(selected === null ? [] : [
      { id: OPERATION_RENAME, label: labels.rename, disabled: !writable || draft !== null },
      { id: OPERATION_UPDATE, label: labels.update, disabled: !writable || !modified },
      { id: OPERATION_DELETE, label: labels.delete, disabled: !writable },
    ]),
  ], [draft, labels, modified, selected, writable]);
  const onSelectItem = React.useCallback((id: string) => {
    if (selection.selectItem(id)) {
      setDraft(null);
    } else if (id === OPERATION_CREATE) {
      setDraft({ kind: 'create', label: '' });
    } else if (selected !== null) {
      if (id === OPERATION_RENAME) setDraft({ kind: 'rename', id: selected.id, label: selected.label });
      else if (id === OPERATION_UPDATE) onUpdate(selected);
      else if (id === OPERATION_DELETE) onDelete(selected);
    }
  }, [onDelete, onUpdate, selected, selection.selectItem, setDraft]);
  const currentLabel = selected?.label ?? labels.unselected ?? labels.title;
  const control = <>
    <Dropdown
      open={selection.open}
      onOpenChange={selection.onOpenChange}
      trigger={selected?.label ?? labels.title}
      triggerAppearance="text"
      triggerDisclosure
      triggerAccessibilityLabel={`${labels.title}: ${currentLabel}`}
      radioGroups={selection.radioGroups}
      items={selection.items}
      groups={[{ id: 'operations', accessibilityLabel: labels.actions, items: operations }]}
      onSelect={onSelectItem}
    />
    {!modified ? null : <Status tone="muted" label={labels.modified} />}
  </>;
  const details = draft === null && notices == null ? null : <Stack gap="small">
    {draft === null ? null : <Row gap="small" wrap align="center">
      <TextField label={labels.name} value={draft.label} onChange={changeDraft} />
      <Button title={labels.confirm} variant="secondary" disabled={!writable || draft.label.trim().length === 0} onPress={commitDraft} />
      <Button title={labels.cancel} variant="plain" onPress={cancelDraft} />
    </Row>}
    {notices}
  </Stack>;
  return { control, details };
}
