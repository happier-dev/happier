import { useCallback, useEffect, useState, type ReactElement, type ReactNode, type RefObject } from 'react';

export type HappierItemOverflowAction = Readonly<{
  id: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
}>;

export type HappierItemOverflowRenderInput = Readonly<{
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Plain label for the Menu-owned interactive trigger. */
  trigger: string;
  /** Accessible name for the Menu-owned interactive trigger. */
  triggerAccessibilityLabel: string;
  /** Stable identity for that single interactive trigger. */
  testID?: string;
  disabled: boolean;
  triggerTabIndex?: -1 | 0;
  focusReturnRef?: RefObject<unknown>;
  actions: readonly HappierItemOverflowAction[];
  onSelect(id: string): void;
}>;

export type HappierItemOverflowProps = Readonly<{
  actions: readonly HappierItemOverflowAction[];
  /** Canonical row-behavior admission; omitted for non-row consumers. */
  secondaryActionsEnabled?: boolean;
  accessibilityLabel: string;
  onSelect(id: string): void;
  /** Composite rows control this state so their own keyboard target can open it. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** Composite rows restore focus to their roving target rather than the trailing trigger. */
  focusReturnRef?: RefObject<unknown>;
  renderMenu(input: HappierItemOverflowRenderInput): ReactElement;
  testID?: string;
}>;

/** Shared trailing-overflow identity/state; adapters retain portal/focus/back. */
export function HappierItemOverflow(props: HappierItemOverflowProps): ReactElement | null {
  const [ownedOpen, setOwnedOpen] = useState(false);
  const open = props.open ?? ownedOpen;
  const enabledIds = props.actions.filter((action) => !action.disabled).map((action) => action.id);
  const enabled = props.secondaryActionsEnabled !== false && enabledIds.length > 0;
  useEffect(() => {
    if (!enabled) {
      setOwnedOpen(false);
      props.onOpenChange?.(false);
    }
  }, [enabled, props.onOpenChange]);
  const setOpen = useCallback((nextOpen: boolean) => {
    if (props.open === undefined) setOwnedOpen(nextOpen);
    props.onOpenChange?.(nextOpen);
  }, [props.onOpenChange, props.open]);
  const onSelect = useCallback((id: string) => {
    if (!enabled || !enabledIds.includes(id)) return;
    props.onSelect(id);
    setOpen(false);
  }, [enabled, enabledIds, props]);
  const onOpenChange = useCallback((nextOpen: boolean) => {
    if (!enabled) return;
    setOpen(nextOpen);
  }, [enabled, setOpen]);
  if (props.actions.length === 0) return null;
  const trigger = '•••';
  return props.renderMenu({
    open: enabled && open,
    onOpenChange,
    trigger,
    triggerAccessibilityLabel: props.accessibilityLabel,
    testID: props.testID,
    disabled: !enabled,
    ...(props.focusReturnRef === undefined ? {} : {
      triggerTabIndex: -1,
      focusReturnRef: props.focusReturnRef,
    }),
    actions: props.actions,
    onSelect,
  });
}
