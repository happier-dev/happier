import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

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
  actions: readonly HappierItemOverflowAction[];
  onSelect(id: string): void;
}>;

export type HappierItemOverflowProps = Readonly<{
  actions: readonly HappierItemOverflowAction[];
  /** Canonical row-behavior admission; omitted for non-row consumers. */
  secondaryActionsEnabled?: boolean;
  accessibilityLabel: string;
  onSelect(id: string): void;
  renderMenu(input: HappierItemOverflowRenderInput): ReactElement;
  testID?: string;
}>;

/** Shared trailing-overflow identity/state; adapters retain portal/focus/back. */
export function HappierItemOverflow(props: HappierItemOverflowProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const enabledIds = props.actions.filter((action) => !action.disabled).map((action) => action.id);
  const enabled = props.secondaryActionsEnabled !== false && enabledIds.length > 0;
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  const onSelect = useCallback((id: string) => {
    if (!enabled || !enabledIds.includes(id)) return;
    props.onSelect(id);
    setOpen(false);
  }, [enabled, enabledIds, props]);
  const onOpenChange = useCallback((nextOpen: boolean) => {
    if (!enabled) return;
    setOpen(nextOpen);
  }, [enabled]);
  if (props.actions.length === 0) return null;
  const trigger = '•••';
  return props.renderMenu({
    open: enabled && open,
    onOpenChange,
    trigger,
    triggerAccessibilityLabel: props.accessibilityLabel,
    testID: props.testID,
    disabled: !enabled,
    actions: props.actions,
    onSelect,
  });
}
