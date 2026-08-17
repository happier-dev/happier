import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from './agentInputChipIconMetrics';

const DEFINITIONS_DIR = join(__dirname);
const SESSION_ACTIONS_DIR = join(__dirname, '..', 'sessionActions');

/**
 * A chip file writes glyphs for three different surfaces, and the surface decides the size:
 *
 *   - the chip's own glyph, in the composer chip row      -> the chip anchor
 *   - a glyph handed to the collapsed action menu         -> the menu step
 *   - a glyph handed to a small badge                     -> the badge step
 *
 * Getting that wrong is not theoretical: the Phosphor migration once bumped ten collapsed-menu
 * glyphs to the chip size, because the menu LOOKS like it should normalise what it is given.
 * It does not - `ActionListSection` wraps each contributed icon in a plain `<View>`, which is not
 * icon-like, so `SelectableRow` skips it and the declared number ships. This test encodes which
 * surface each call site is writing for, so the next sweep cannot quietly conflate them.
 */
function classifySurface(source: string, index: number): 'chip' | 'menu' | 'badge' {
    const preceding = [
        'collapsedAction',
        'collapsedContentPopover',
        'collapsedOptionsPopover',
        'attachmentRowItem',
        'render:',
        'render(',
    ]
        .map((key) => [source.lastIndexOf(key, index), key] as const)
        .filter(([at]) => at >= 0);

    if (preceding.length === 0) return 'chip';
    const [, nearest] = preceding.reduce((a, b) => (a[0] >= b[0] ? a : b));
    if (nearest.startsWith('collapsed')) return 'menu';
    if (nearest === 'attachmentRowItem') return 'badge';
    return 'chip';
}

const EXPECTED_CONSTANT = {
    chip: 'AGENT_INPUT_CHIP_ICON_SIZE_PX',
    menu: 'AGENT_INPUT_MENU_ICON_SIZE_PX',
    badge: 'AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX',
} as const;

function chipFiles(dir: string): ReadonlyArray<readonly [string, string]> {
    return readdirSync(dir)
        .filter((f) => f.endsWith('ActionChip.tsx') || f.endsWith('TriggerChip.tsx'))
        .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);
}

describe('composer chip icon sizes', () => {
    it('keeps the chip anchor above the menu step, and the badge below it', () => {
        expect(AGENT_INPUT_CHIP_ICON_SIZE_PX).toBeGreaterThan(AGENT_INPUT_MENU_ICON_SIZE_PX);
        expect(AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX).toBeLessThan(AGENT_INPUT_MENU_ICON_SIZE_PX);
    });

    it('sizes every chip glyph by the surface it renders on', () => {
        const offenders: string[] = [];

        for (const dir of [DEFINITIONS_DIR, SESSION_ACTIONS_DIR]) {
            for (const [file, source] of chipFiles(dir)) {
                for (const match of source.matchAll(/<Icon\b[^>]*?size=\{([^}]+)\}/gs)) {
                    const actual = match[1].trim();
                    // A local helper that forwards its own `size` argument is not a size decision -
                    // its callers make that, and they are checked like any other call site.
                    if (actual === 'size') continue;
                    const expected = EXPECTED_CONSTANT[classifySurface(source, match.index ?? 0)];
                    if (actual !== expected) offenders.push(`${file}: size={${actual}}, expected ${expected}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});
