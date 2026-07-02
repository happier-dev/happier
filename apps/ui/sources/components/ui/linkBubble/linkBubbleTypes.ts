import type { PopoverAnchor } from '@/components/ui/popover';

/**
 * Props for the `<LinkBubble>` primitive (Lane H, D4).
 *
 * Renders a floating bubble when the caret is inside a link in the markdown
 * editor. Two internal states: "display" (URL + Open/Edit/Unlink buttons) and
 * "edit" (TextInput pre-filled with the current href + Cancel/Save).
 *
 * The primitive is stateless regarding mode toggling — the host decides when
 * to open/close via `open`. Internal display↔edit toggling is self-managed.
 */
export type LinkBubbleProps = Readonly<{
    open: boolean;
    anchor: Extract<PopoverAnchor, { kind: 'rect' }>;
    href: string;
    onOpenLink: () => void;
    onUnlink: () => void;
    onSetLink: (nextHref: string) => void;
    onRequestClose: () => void;
    testID?: string;
}>;
