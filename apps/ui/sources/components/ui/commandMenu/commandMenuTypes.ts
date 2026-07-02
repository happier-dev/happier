import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { PopoverAnchor, PopoverBackdropOptions, PopoverPlacement } from '@/components/ui/popover';

/** A single row in the menu. */
export type CommandMenuItem = Readonly<{
    id: string;
    label: string;
    description?: string;
    /** Joined with label into a substring-match haystack by filterCommandMenuItemsBySubstring. */
    aliases?: readonly string[];
    /** Optional section header. When consecutive items share a group, no divider between them. */
    group?: string;
    icon?: React.ReactNode;
    /** Static height override (defaults to a primitive-owned constant). */
    rowHeight?: number;
    /** Optional escape hatch: render the row contents yourself instead of icon+label+description. */
    renderRow?: () => React.ReactNode;
    /** Optional, host-owned data the primitive passes back unchanged via onSelect. */
    meta?: unknown;
}>;

/** Where the menu anchors. Reuse the canonical PopoverAnchor shape (D5). */
export type CommandMenuAnchor = PopoverAnchor;

export type CommandMenuProps = Readonly<{
    open: boolean;
    anchor: CommandMenuAnchor;
    /** Echo of the host-tracked query (e.g. '/foo' minus the slash, or '@bar'). The primitive uses this purely for accessibility/test ID building; it does NOT filter. */
    query: string;
    /** Pre-filtered, pre-sorted by host. */
    items: readonly CommandMenuItem[];
    /** Index into items (-1 if nothing selected). */
    selectedIndex: number;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onSelect: (item: CommandMenuItem, index: number) => void;
    onRequestClose: () => void;
    /** Hard caps (defaults applied by primitive). */
    maxHeight?: number;
    maxWidth?: number;
    /** Uses Popover placement. Defaults to auto-vertical/bottom depending on host. */
    placement?: PopoverPlacement;
    /** Uses Popover gap. Hosts must NOT pre-offset rect anchors (D42). */
    gap?: number;
    /** Optional explicit Popover boundary override. Passing null intentionally disables context boundary clamping. */
    boundaryRef?: React.RefObject<any> | null;
    /** Native keyboard occlusion supplied by the host when it already owns canonical keyboard metrics. */
    keyboardBottomInset?: number;
    /** Popover edge padding forwarded to the positioning primitive. */
    edgePadding?: number | Readonly<{ horizontal?: number; vertical?: number }>;
    /** Popover backdrop behavior forwarded for host-specific click/tap-through semantics. */
    backdrop?: PopoverBackdropOptions;
    /** Web outside-pointer behavior forwarded to Popover. */
    consumeOutsidePointerDown?: boolean;
    /** Extra styles applied to the Popover positioned container. */
    containerStyle?: StyleProp<ViewStyle>;
    /** Optional copy when items is empty (only rendered when open && items.length === 0). */
    emptyStateLabel?: string;
    testID?: string;
}>;
