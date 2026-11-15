import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { PopoverAnchor, PopoverBackdropOptions, PopoverPlacement } from '@/components/ui/popover';

/** A preview pane beside the list and the split geometry the host's content needs. */
export type CommandMenuPreview = Readonly<{
    /**
     * `null` shows the list alone. A preview that comes and goes (with the window width) keeps this object and
     * passes `null`: dropping it swaps the split for a plain list and remounts every row.
     */
    content: React.ReactNode | null;
    /** The device-local width preference's key (`useCollectionRailWidth`). */
    resizeKey: string;
    /** Readable minima for each pane; the divider never takes a pane below its own. */
    minListWidthPx: number;
    minPreviewWidthPx: number;
    /** The list's share of the width before anyone drags the divider. */
    preferredListRatio: number;
}>;

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
    /** Shown with its description as the reason, announced disabled, and never selectable. */
    disabled?: true;
    /** Static height override (defaults to a primitive-owned constant). */
    rowHeight?: number;
    /** Optional escape hatch: render the row contents yourself instead of icon+label+description. */
    renderRow?: () => React.ReactNode;
    /** Pointer highlight updates the host selection and preview without activating the row. */
    onHighlight?: () => void;
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
    /** Keep an explicitly requested side when the host's presentation requires it. */
    flip?: boolean;
    /** Uses Popover gap. Hosts must NOT pre-offset rect anchors (D42). */
    gap?: number;
    /** Optional explicit Popover boundary override. Passing null intentionally disables context boundary clamping. */
    boundaryRef?: React.RefObject<any> | null;
    /** A view the menu never covers (see `Popover.clearanceRef`). */
    clearanceRef?: React.RefObject<any>;
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
    /** Optional richer empty state (an inline action such as Clear); takes precedence over `emptyStateLabel`. */
    emptyState?: React.ReactNode;
    /** A non-selectable invitation in a leading empty group, inside the list. */
    leadingEmptyGroup?: Readonly<{ title: string; hint: string }>;
    /** Optional editable search and supplemental content, inside the same menu surface. */
    header?: React.ReactNode;
    /**
     * The highlighted row in full, beside the list: the two share one resizable split whose list width is
     * remembered on this device under `resizeKey`. `content: null` leaves the list alone in the frame.
     */
    preview?: CommandMenuPreview;
    footer?: React.ReactNode;
    /** Searchable menus allow their field/buttons to receive pointer focus. */
    preserveHostFocus?: boolean;
    /** Take the anchor's (composer's) width rather than the compact menu width. */
    matchAnchorWidth?: boolean;
    /** This wide, centred on the anchor; the window's edges still bound it. */
    centerOnAnchorMaxWidth?: number;
    /** Hold the full available height so the surface never resizes while its query narrows the rows. */
    fillHeight?: boolean;
    /** Where a held frame (`fillHeight`) seats its `emptyState`: a pane centres, a one-line state sits under the header. */
    emptyStateAlign?: 'center' | 'start';
    /** On a phone the menu is presented in the shared bottom sheet (Popover's phone presentation) under this title. */
    phoneSheetTitle?: string;
    testID?: string;
}>;
