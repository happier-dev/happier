import { useCallback, useEffect, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { PluginUiMenuSelection } from '../../presentationHost/context.js';

export type HappierItemOverflowAction = Readonly<{
  id: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
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
  onSelect(id: string, selection?: PluginUiMenuSelection): void;
}>;

export type HappierItemOverflowProps = Readonly<{
  actions: readonly HappierItemOverflowAction[];
  /** Canonical row-behavior admission; omitted for non-row consumers. */
  secondaryActionsEnabled?: boolean;
  accessibilityLabel: string;
  onSelect(id: string, selection?: PluginUiMenuSelection): void;
  /** Composite rows control this state so their own keyboard target can open it. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** Composite rows restore focus to their roving target rather than the trailing trigger. */
  focusReturnRef?: RefObject<unknown>;
  renderMenu(input: HappierItemOverflowRenderInput): ReactElement;
  testID?: string;
}>;

/** Shared overflow-open state; host menu adapters retain their portal and action admission. */
export function useHappierItemOverflowState(
  props: Pick<HappierItemOverflowProps, 'open' | 'onOpenChange'>,
  enabled = true,
) {
  const [ownedOpen, setOwnedOpen] = useState(false);
  const open = props.open ?? ownedOpen;
  useEffect(() => {
    if (!enabled) {
      setOwnedOpen(false);
      props.onOpenChange?.(false);
    }
  }, [enabled, props.onOpenChange]);
  const setOpen = useCallback((nextOpen: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof nextOpen === 'function' ? nextOpen(open) : nextOpen;
    if (props.open === undefined) setOwnedOpen(resolved);
    props.onOpenChange?.(resolved);
  }, [props.onOpenChange, props.open, open]);
  return { open, setOpen };
}

/** Shared trailing-overflow identity/state; adapters retain portal/focus/back. */
export function HappierItemOverflow(props: HappierItemOverflowProps): ReactElement | null {
  const enabledIds = props.actions.filter((action) => !action.disabled).map((action) => action.id);
  const enabled = props.secondaryActionsEnabled !== false && enabledIds.length > 0;
  const { open, setOpen } = useHappierItemOverflowState(props, enabled);
  const onSelect = useCallback((id: string, selection?: PluginUiMenuSelection) => {
    if (!enabled || !enabledIds.includes(id)) return;
    props.onSelect(id, selection);
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
