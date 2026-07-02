import * as React from 'react';

import type { PopoverAnchor } from '@/components/ui/popover';

import type {
    EditorViewportWindowRect,
    LinkBubbleState,
    MarkdownEditorController,
} from '../markdownEditorTypes';

/**
 * Host-side hook for the LinkBubble (Lane H).
 *
 * Subscribes to the markdown editor controller's `subscribeLinkBubble` state
 * and, on native, also subscribes to `subscribeEditorViewportLayout` so the
 * caret rect emitted in WebView viewport coordinates is translated to screen
 * coordinates by adding the editor viewport's window offset (D20, D40).
 *
 * Returns props ready to spread onto `<LinkBubble>`:
 * - `open`: whether the bubble should render (true iff a link state is active).
 * - `anchor`: rect-anchor at the caret in screen/window coordinates.
 * - `href`: current href under the caret.
 * - `onOpenLink` / `onUnlink` / `onSetLink`: dispatch the corresponding
 *   `MarkdownEditorCommand` through the controller.
 * - `onRequestClose`: explicit dismissal — clears local state so the bubble
 *   hides until the caret leaves and re-enters a link.
 *
 * Mirror of `useMarkdownSlashMenu` (Lane G): the controller is the single
 * integration point and the host owns no editor state of its own.
 */
export type MarkdownLinkBubbleState = Readonly<{
    open: boolean;
    anchor: Extract<PopoverAnchor, { kind: 'rect' }>;
    href: string;
    onOpenLink: () => void;
    onUnlink: () => void;
    onSetLink: (nextHref: string) => void;
    onRequestClose: () => void;
}>;

const CLOSED_ANCHOR: Extract<PopoverAnchor, { kind: 'rect' }> = {
    kind: 'rect',
    rect: { left: 0, top: 0, height: 0 },
};

export function useMarkdownLinkBubble(
    controller: MarkdownEditorController | null,
): MarkdownLinkBubbleState {
    // -----------------------------------------------------------------------
    // Link bubble subscription
    // -----------------------------------------------------------------------

    const [bubble, setBubble] = React.useState<LinkBubbleState | null>(null);
    // Explicit user dismissal — keeps the bubble closed until the caret leaves
    // the current link and re-enters one (we reset it when href changes).
    const [dismissed, setDismissed] = React.useState(false);

    React.useEffect(() => {
        if (!controller?.subscribeLinkBubble) {
            setBubble(null);
            return;
        }
        const unsubscribe = controller.subscribeLinkBubble(setBubble);
        return () => {
            unsubscribe();
            setBubble(null);
        };
    }, [controller]);

    // Reset dismissed-state whenever the href changes (caret moved to a
    // different link) or the bubble state goes from null → present.
    const lastHrefRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const nextHref = bubble?.href ?? null;
        if (nextHref !== lastHrefRef.current) {
            lastHrefRef.current = nextHref;
            setDismissed(false);
        }
    }, [bubble]);

    // -----------------------------------------------------------------------
    // Editor viewport layout (D40) — only matters on native (WebView)
    // -----------------------------------------------------------------------

    const [viewportRect, setViewportRect] = React.useState<EditorViewportWindowRect | null>(null);

    React.useEffect(() => {
        if (!controller?.subscribeEditorViewportLayout) {
            return;
        }
        const unsubscribe = controller.subscribeEditorViewportLayout(setViewportRect);
        return () => {
            unsubscribe();
        };
    }, [controller]);

    React.useEffect(() => {
        if (viewportRect !== null) return;
        controller?.measureEditorViewportInWindow?.().then((rect) => {
            if (rect) setViewportRect(rect);
        });
    }, [controller, viewportRect]);

    // -----------------------------------------------------------------------
    // Command callbacks
    // -----------------------------------------------------------------------

    const onOpenLink = React.useCallback(() => {
        controller?.runCommand({ kind: 'openLink' });
    }, [controller]);

    const onUnlink = React.useCallback(() => {
        controller?.runCommand({ kind: 'unlink' });
    }, [controller]);

    const onSetLink = React.useCallback(
        (nextHref: string) => {
            const trimmed = nextHref.trim();
            if (trimmed.length === 0) {
                // Empty href: treat as unlink rather than write an empty mark.
                controller?.runCommand({ kind: 'unlink' });
                return;
            }
            controller?.runCommand({ kind: 'setLink', href: trimmed });
        },
        [controller],
    );

    const onRequestClose = React.useCallback(() => {
        setDismissed(true);
    }, []);

    // -----------------------------------------------------------------------
    // Anchor: translate caret rect with viewport offset on native (D20, D40)
    // -----------------------------------------------------------------------

    const anchor: Extract<PopoverAnchor, { kind: 'rect' }> = React.useMemo(() => {
        if (!bubble) return CLOSED_ANCHOR;
        const { caretRect } = bubble;
        const offsetLeft = viewportRect?.left ?? 0;
        const offsetTop = viewportRect?.top ?? 0;
        return {
            kind: 'rect',
            rect: {
                left: caretRect.left + offsetLeft,
                top: caretRect.top + offsetTop,
                height: caretRect.height,
            },
        };
    }, [bubble, viewportRect]);

    const open = bubble !== null && !dismissed;
    const href = bubble?.href ?? '';

    return {
        open,
        anchor,
        href,
        onOpenLink,
        onUnlink,
        onSetLink,
        onRequestClose,
    };
}
