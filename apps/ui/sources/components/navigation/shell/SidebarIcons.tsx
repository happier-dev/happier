import * as React from 'react';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

type SidebarIconProps = {
    size?: number;
    color?: string;
    /**
     * Which edge the sidebar being controlled lives on.
     *
     * The concept, not the drawing: HugeIcons has dedicated right-edge panel glyphs, while Phosphor
     * only draws the left-edge one and reaches the right by mirroring. Naming the edge lets each
     * family answer it the way it can — the alternative, mirroring everywhere, would flip HugeIcons'
     * purpose-built glyph into a left-facing one.
     */
    edge?: 'left' | 'right';
};

/**
 * The four states of a sidebar toggle, one glyph each.
 *
 * The names are edge × action on purpose. They used to be `sidebar` and `sidebar-simple` for the left
 * pair — Phosphor's own drawing names, which say nothing about which panel or which direction — and
 * because neither name claimed a state, the left sidebar ended up rendering the SAME glyph open and
 * closed, with a `scaleX: -1` on a wrapper View at one call site doing the actual work. That put the
 * glyph the seam resolved and the glyph on screen out of sync, and it was invisible here.
 *
 * Under HugeIcons the pair is directional — the panel moves to the side it will end up on and an
 * arrow points the way. Under Phosphor, which draws no arrows, the panel simply stays on its own
 * edge, because side is the only thing that family can say. Each answers with what it has; that is
 * what the seam is for.
 */
export const SidebarExpandIcon = React.memo(({ size = ICON_SIZE.md, color, edge = 'left' }: SidebarIconProps) => {
    return edge === 'right'
        ? <Icon name="sidebar-right-open" size={size} color={color} mirrored />
        : <Icon name="sidebar-left-open" size={size} color={color} />;
});

export const SidebarCollapseIcon = React.memo(({ size = ICON_SIZE.md, color, edge = 'left' }: SidebarIconProps) => {
    return edge === 'right'
        ? <Icon name="sidebar-right-close" size={size} color={color} mirrored />
        : <Icon name="sidebar-left-close" size={size} color={color} />;
});
