import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { SidebarCollapseIcon, SidebarExpandIcon } from './SidebarIcons';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A sidebar toggle has to say which way it goes.
 *
 * It used to say it with a `scaleX: -1` on a wrapper View at one of the two call sites, which meant
 * the glyph the seam resolved and the glyph the user saw were different drawings — and the open and
 * closed states were left rendering the same icon name, distinguished only by that transform. So the
 * contract worth pinning is not "an icon appears" but "these four states resolve four names".
 */
async function glyphName(node: React.ReactElement): Promise<string | undefined> {
    const screen = await renderScreen(node);
    const icon = screen.findByType('Icon' as unknown as React.ComponentType) as ReactTestInstance | null;
    return icon?.props.name as string | undefined;
}

describe('SidebarIcons', () => {
    it('draws the left sidebar with the panel on the left while it is open', async () => {
        expect(await glyphName(<SidebarCollapseIcon />)).toBe('sidebar-left-close');
    });

    it('draws the left sidebar with the panel on the right while it is closed', async () => {
        expect(await glyphName(<SidebarExpandIcon />)).toBe('sidebar-left-open');
    });

    it('draws the right panel on its own edge in both states', async () => {
        expect(await glyphName(<SidebarCollapseIcon edge="right" />)).toBe('sidebar-right-close');
        expect(await glyphName(<SidebarExpandIcon edge="right" />)).toBe('sidebar-right-open');
    });

    it('never answers one edge with the other edge glyph', async () => {
        const [leftOpen, leftClosed, rightOpen, rightClosed] = await Promise.all([
            glyphName(<SidebarCollapseIcon />),
            glyphName(<SidebarExpandIcon />),
            glyphName(<SidebarCollapseIcon edge="right" />),
            glyphName(<SidebarExpandIcon edge="right" />),
        ]);

        expect(new Set([leftOpen, leftClosed, rightOpen, rightClosed]).size).toBe(4);
    });
});
