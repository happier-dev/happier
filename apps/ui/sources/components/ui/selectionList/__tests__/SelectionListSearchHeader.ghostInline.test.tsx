import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * RUX-2 Issue 9 → RUX-10 — inline ghost positioning.
 *
 * Bug (RUX-2): the ghost suffix used to be rendered as a flex-row sibling
 * AFTER the `flex: 1` TextInput, so it visually landed at the FAR RIGHT of
 * the input row (next to the browse-folder suffix slot).
 *
 * Initial fix (RUX-2): shrink-fit the TextInput (`flex: 0`) so the ghost
 * could sit flush to its right. Browser QA confirmed this did NOT work —
 * the rn-web `<input>` element still claimed the container width so the
 * ghost remained at the far right of the row.
 *
 * Final fix (RUX-10): layered-mirror approach. A new `input-cell` View hosts
 * a `<SelectionListInputMirror>` (typed text + ghost as inline `<Text>`
 * spans) AND the editable `<TextInput>` painted on top with
 * `position: absolute; inset: 0; color: transparent; caretColor: <theme>`.
 * Because the mirror's typed-text width is identical to the TextInput's
 * transparent-text width, the ghost lands EXACTLY where the caret sits.
 *
 * The render-position invariants below survive layout changes because they
 * assert ORDER + STYLE properties, not pixel measurements. The contract is
 * intentionally weaker than RUX-2's (which pinned ghost-after-input in
 * document order — a contract incompatible with the layered approach):
 * we only assert the ghost is inside the wrap, NOT in the suffix slot.
 */

function findIndexInChildren(parent: { children?: unknown }, predicate: (child: unknown) => boolean): number {
    const children = Array.isArray(parent.children) ? parent.children : [];
    return children.findIndex(predicate);
}

describe('SelectionListSearchHeader — inline ghost positioning (RUX-2 Issue 9)', () => {
    it('renders the ghost (mirror or sibling) inside the input-wrap (NOT in the suffix slot)', async () => {
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
        const wrap = screen.findByTestId('hdr:input-wrap');
        expect(wrap).not.toBeNull();
        // Both the input AND a ghost-rendering surface (mirror on web,
        // sibling ghost on native) are descendants of the input-wrap.
        const wrapInputs = wrap!.findAll((n) => n.props?.testID === 'hdr:input');
        expect(wrapInputs.length).toBeGreaterThan(0);
        const wrapMirrors = wrap!.findAll((n) => n.props?.testID === 'hdr:input:mirror');
        const wrapGhosts = wrap!.findAll((n) => n.props?.testID === 'hdr:input:ghost');
        // Either the layered mirror (web) or the sibling ghost (native) lives
        // inside the wrap — exactly one path renders for any given platform.
        expect(wrapMirrors.length + wrapGhosts.length).toBeGreaterThan(0);
    });

    it('inputSuffix never contains the ghost (ghost never lands next to the suffix slot)', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="/Users/leeroy/Documents/Development/hap"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix="pier-dev/"
                inputSuffix={(
                    <Pressable testID="hdr:browse-btn"><Text>Browse</Text></Pressable>
                )}
                testID="hdr"
            />,
        );
        const suffix = screen.findByTestId('hdr:input-suffix');
        expect(suffix).not.toBeNull();
        const ghostsInsideSuffix = suffix!.findAll((n) => n.props?.testID === 'hdr:input:ghost');
        const mirrorsInsideSuffix = suffix!.findAll((n) => n.props?.testID === 'hdr:input:mirror');
        expect(ghostsInsideSuffix).toEqual([]);
        expect(mirrorsInsideSuffix).toEqual([]);
    });

    it('does NOT render the ghost or mirror when ghostSuffix is empty', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="/Users/leeroy/Documents"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix=""
                testID="hdr"
            />,
        );
        const ghostHostMatches = screen
            .findAllByTestId('hdr:input:ghost')
            .filter((n) => typeof n.type === 'string');
        const mirrorHostMatches = screen
            .findAllByTestId('hdr:input:mirror')
            .filter((n) => typeof n.type === 'string');
        expect(ghostHostMatches).toEqual([]);
        expect(mirrorHostMatches).toEqual([]);
    });

    it('input-wrap absorbs the remaining width (flex:1, flexDirection:row)', async () => {
        // The wrap is the row-level container for the input layers. The
        // suffix slot remains a sibling of the wrap, so the browse button
        // stays anchored to the far right of the header.
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
        const wrap = screen.findByTestId('hdr:input-wrap');
        const wrapStyle = Object.assign(
            {},
            ...(Array.isArray(wrap!.props.style)
                ? (wrap!.props.style as unknown[]).flat(Infinity)
                : [wrap!.props.style as unknown]
            ).filter(Boolean) as object[],
        ) as { flex?: number; flexDirection?: string };
        expect(wrapStyle.flex).toBe(1);
        expect(wrapStyle.flexDirection).toBe('row');
    });
});

// Silence unused-import warnings if the order helper isn't used in some envs.
void findIndexInChildren;
void View;
