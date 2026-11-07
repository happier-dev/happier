import { useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

/** Already-held display facts. Opening or choosing never acquires or creates an entity. */
export type CollectionAddMenuItem = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
  category?: string;
  icon?: ReactNode;
  rightElement?: ReactNode;
  accessibilityLabel?: string;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
  checked?: boolean;
  testID?: string;
}>;

export type HappierCollectionAddMenuHost<Selection = unknown> = Readonly<{
  /** The incumbent dropdown owns search, groups, keyboard, focus, portal and phone presentation. */
  Menu: ComponentType<Readonly<{
    testID: string;
    open: boolean;
    onOpenChange(open: boolean): void;
    items: readonly CollectionAddMenuItem[];
    onSelect(id: string, selection?: Selection): void;
    header?: ReactNode;
    search: boolean;
    searchPlaceholder?: string;
    placement: 'bottom';
    popoverAnchorAlign: 'end';
    matchTriggerWidth: false;
    maxWidthCap: number;
    showCategoryTitles: boolean;
    popoverPortalWebTarget: 'body';
    trigger(input: Readonly<{ toggle(): void }>): ReactNode;
  }>>;
  /** Return the actual trigger element so the dropdown can attach its expanded state. */
  renderTrigger(input: Readonly<{
    testID?: string;
    label: string;
    open: boolean;
    disabled?: boolean;
    onPress(): void;
  }>): ReactNode;
  /** With `action`, the notice is a failed read the menu's choices depend on, recovered in place. */
  Notice: ComponentType<Readonly<{ testID: string; children: string; action?: CollectionAddMenuNoticeAction }>>;
}>;

/** The notice's one recovery, such as Retry of the read that supplies the choices. */
export type CollectionAddMenuNoticeAction = Readonly<{ label: string; onPress(): void }>;

/** One quiet line above the entries; a recoverable failure carries its action. */
export type CollectionAddMenuNotice = Readonly<{ text: string; action: CollectionAddMenuNoticeAction }>;

export type HappierCollectionAddMenuProps<Selection = unknown> = Readonly<{
  host: HappierCollectionAddMenuHost<Selection>;
  testID: string;
  items: readonly CollectionAddMenuItem[];
  onSelect(id: string, selection?: Selection): void;
  /** The plus trigger's accessible name and tooltip, localized by the caller. */
  label: string;
  searchPlaceholder?: string;
  showCategoryTitles?: boolean;
  disabled?: boolean;
  maxWidthCap?: number;
  /** Replaces the plus with the caller's invitation or group action. */
  renderTrigger?: (toggle: () => void) => ReactNode;
  triggerTestID?: string;
  /** One quiet line explaining unavailable choices, above the entries, or a failed read with its recovery. */
  notice?: string | CollectionAddMenuNotice | null;
}>;

/** The menu searches once its list no longer fits at a glance. */
export const COLLECTION_ADD_MENU_SEARCH_THRESHOLD = 8;

/** One add-menu composition for core collections and installed authors. No inventory or mutation owner. */
export function HappierCollectionAddMenu<Selection = unknown>(props: HappierCollectionAddMenuProps<Selection>): ReactElement {
  const [open, setOpen] = useState(false);
  const { Menu, Notice } = props.host;
  const notice = typeof props.notice === 'string' ? { text: props.notice, action: undefined } : props.notice ?? null;
  return <Menu
    testID={props.testID}
    open={open}
    onOpenChange={setOpen}
    items={props.items}
    header={notice?.text ? <Notice testID={`${props.testID}:notice`} action={notice.action}>{notice.text}</Notice> : undefined}
    onSelect={(id, selection) => {
      setOpen(false);
      props.onSelect(id, selection);
    }}
    search={props.items.length > COLLECTION_ADD_MENU_SEARCH_THRESHOLD}
    searchPlaceholder={props.searchPlaceholder}
    placement="bottom"
    popoverAnchorAlign="end"
    matchTriggerWidth={false}
    maxWidthCap={props.maxWidthCap ?? 340}
    showCategoryTitles={props.showCategoryTitles ?? true}
    popoverPortalWebTarget="body"
    trigger={({ toggle }) => props.renderTrigger ? props.renderTrigger(toggle) : props.host.renderTrigger({
      testID: props.triggerTestID,
      label: props.label,
      open,
      disabled: props.disabled,
      onPress: toggle,
    })}
  />;
}
