import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * RUX-10 — Layered-mirror ghost positioning.
 *
 * RUX-2's "shrink-fit" approach attempted to keep the ghost flush to the
 * TextInput by setting `flex: 0; flex-shrink: 1` on the input. In practice
 * (browser QA on the path picker) the rn-web `<input>` element still claims
 * its container width, so the ghost continued to render at the FAR RIGHT of
 * the row, next to the browse-folder suffix.
 *
 * The correct approach (used by GitHub's command palette and VS Code's
 * quick-open) is a layered mirror:
 *
 *   - A mirror `<View>` ("input-cell") contains:
 *     - A `<SelectionListInputMirror>` that paints the typed value + ghost
 *       inline as `<Text>` spans (bottom layer).
 *     - A `<TextInput>` painted on top with `position: absolute; inset: 0;`
 *       and `color: 'transparent'; caretColor: <theme color>;` so the caret
 *       remains visible while the typed text comes from the mirror.
 *
 * Because the mirror's typed-text width is identical to the TextInput's
 * transparent-text width (same font metrics), the ghost suffix lands exactly
 * after the caret — producing the inline "typed text + ghost" continuity the
 * user expects.
 *
 * This file asserts the layout structure (web only). On native we fall back
 * to the prior shrink-fit + sibling-ghost approach because `caretColor` is a
 * web-only CSS property.
 */
describe('SelectionListSearchHeader — layered-mirror ghost positioning (RUX-10, web)', () => {
    it('renders an input-cell relative container hosting both the mirror and the TextInput', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="/Users/leeroy/Documents/Development/hap"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix="pier-dev/"
                testID="hdr"
            />,
        );
        const cell = screen.findByTestId('hdr:input-cell');
        expect(cell).not.toBeNull();
        const cellInputs = cell!.findAll((n) => n.props?.testID === 'hdr:input');
        const cellMirrors = cell!.findAll((n) => n.props?.testID === 'hdr:input:mirror');
        expect(cellInputs.length).toBeGreaterThan(0);
        expect(cellMirrors.length).toBeGreaterThan(0);
    });

    it('positions the TextInput absolutely on top of the mirror, with a transparent text color', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="~/Doc"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix="uments/"
                testID="hdr"
            />,
        );
        const input = screen.findByTestId('hdr:input');
        expect(input).not.toBeNull();
        const flat = Object.assign(
            {},
            ...(Array.isArray(input!.props.style)
                ? (input!.props.style as unknown[]).flat(Infinity)
                : [input!.props.style as unknown]
            ).filter(Boolean) as object[],
        ) as { position?: string; color?: string; caretColor?: string };
        expect(flat.position).toBe('absolute');
        expect(flat.color).toBe('transparent');
        // The caretColor must remain explicit so the cursor stays visible.
        expect(typeof flat.caretColor).toBe('string');
        expect((flat.caretColor as string).length).toBeGreaterThan(0);
        expect(flat.caretColor).not.toBe('transparent');
    });

    it('mirror sits BEFORE the TextInput in document order (so the input paints on top)', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="~/Doc"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix="uments/"
                testID="hdr"
            />,
        );
        const cell = screen.findByTestId('hdr:input-cell');
        expect(cell).not.toBeNull();
        const order: ('mirror' | 'input')[] = [];
        const walk = (node: { props?: Record<string, unknown>; children?: unknown }) => {
            const tid = (node.props as { testID?: string } | undefined)?.testID;
            if (tid === 'hdr:input:mirror') order.push('mirror');
            if (tid === 'hdr:input') order.push('input');
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) {
                if (child && typeof child === 'object') {
                    walk(child as { props?: Record<string, unknown>; children?: unknown });
                }
            }
        };
        walk(cell as unknown as { props?: Record<string, unknown>; children?: unknown });
        const mirrorIdx = order.indexOf('mirror');
        const inputIdx = order.indexOf('input');
        expect(mirrorIdx).toBeGreaterThanOrEqual(0);
        expect(inputIdx).toBeGreaterThan(mirrorIdx);
    });

    it('mirror prints the typed value AND the ghost suffix together (inline continuity)', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="/Users/leeroy/Documents/Development/hap"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix="pier-dev/"
                testID="hdr"
            />,
        );
        const mirror = screen.findByTestId('hdr:input:mirror');
        expect(mirror).not.toBeNull();
        // Limit the search to descendants of the mirror so we don't pick up
        // the TextInput's `value` prop (which contains the typed text too).
        const collectText = (node: { props?: Record<string, unknown>; children?: unknown }): string[] => {
            const out: string[] = [];
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) {
                if (typeof child === 'string') out.push(child);
                else if (child && typeof child === 'object') {
                    out.push(...collectText(child as { props?: Record<string, unknown>; children?: unknown }));
                }
            }
            return out;
        };
        const mirrorText = collectText(mirror as unknown as {
            props?: Record<string, unknown>;
            children?: unknown;
        }).join('');
        expect(mirrorText).toContain('/Users/leeroy/Documents/Development/hap');
        expect(mirrorText).toContain('pier-dev/');
    });

    it('inputSuffix remains outside the input-cell so the browse button stays anchored to the far right', async () => {
        const { Pressable, Text } = await import('react-native');
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="~/Doc"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix="uments/"
                inputSuffix={(
                    <Pressable testID="hdr:browse-btn"><Text>Browse</Text></Pressable>
                )}
                testID="hdr"
            />,
        );
        const cell = screen.findByTestId('hdr:input-cell');
        expect(cell).not.toBeNull();
        const ghostInsideCell = cell!.findAll((n) => n.props?.testID === 'hdr:browse-btn');
        expect(ghostInsideCell).toEqual([]);
        const suffix = screen.findByTestId('hdr:input-suffix');
        expect(suffix).not.toBeNull();
    });

    it('omits the mirror entirely when ghostSuffix is empty (no overlap, no overdraw)', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="~/Documents"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix=""
                testID="hdr"
            />,
        );
        const hostMatches = screen.findAllByTestId('hdr:input:mirror').filter((n) => typeof n.type === 'string');
        expect(hostMatches).toEqual([]);
        // When the mirror is absent the input must be visually opaque again
        // (not transparent), otherwise the typed text would disappear.
        const input = screen.findByTestId('hdr:input');
        const flat = Object.assign(
            {},
            ...(Array.isArray(input!.props.style)
                ? (input!.props.style as unknown[]).flat(Infinity)
                : [input!.props.style as unknown]
            ).filter(Boolean) as object[],
        ) as { color?: string; position?: string };
        expect(flat.color).not.toBe('transparent');
        // The absolute-overlay positioning is also dropped when there is no mirror.
        expect(flat.position).not.toBe('absolute');
    });
});
