import { describe, expect, it } from 'vitest';

import {
    classifyPositionViewNode,
    deriveShippedNativeTreeFacts,
    findShippedNativeRuntimeViolations,
    NATIVE_SCROLL_ADJUST_BIAS_PX,
    readShippedNativeModuleFacts,
    type RenderedHostNode,
    type ShippedNativeModuleFacts,
} from './shippedNativeLegendRuntime';

/**
 * Proves the shipped-native guard has teeth.
 *
 * The guard's whole value is that it says NO when the lane silently degrades. A guard that has only
 * ever been observed saying yes is indistinguishable from `expect(true).toBe(true)` - and this
 * program has already shipped a harness that pinned the wrong renderer while reporting green. So
 * each degraded configuration is reconstructed here and the guard is required to reject it by name.
 */

const HEALTHY_MODULE: ShippedNativeModuleFacts = {
    fabricUIManagerInstalled: true,
    isNewArchitecture: true,
    platformOS: 'ios',
};

// The exact shapes observed in a real shipped-native mount.
const NATIVE_SCROLL_ADJUST_NODE: RenderedHostNode = {
    props: { style: { height: 0, left: 0, position: 'absolute', top: NATIVE_SCROLL_ADJUST_BIAS_PX + 500, width: 0 } },
    type: 'View',
};
const FABRIC_ROW_NODE: RenderedHostNode = {
    props: { style: [{ left: 0, position: 'absolute', right: 0, top: 0 }, { top: 200 }] },
    type: 'View',
};
// The shape old architecture produces instead: `PositionViewAnimated` renders an `Animated.View`
// whose `top` is an Animated value rather than a number (react-native.mjs:5189-5201).
const LEGACY_ROW_NODE: RenderedHostNode = {
    props: { style: [{ left: 0, position: 'absolute', right: 0, top: 0 }, { top: { _value: 200 } }] },
    type: 'Animated.View',
};
const CONTENT_CONTAINER_NODE: RenderedHostNode = {
    props: { style: { height: { _value: 600 }, minWidth: 0, opacity: 1 } },
    type: 'Animated.View',
};
const SCROLLER_NODE: RenderedHostNode = { props: { style: {} }, type: 'ScrollView' };

const HEALTHY_TREE = [SCROLLER_NODE, NATIVE_SCROLL_ADJUST_NODE, CONTENT_CONTAINER_NODE, FABRIC_ROW_NODE];

function violationCodes(nodes: readonly RenderedHostNode[], module: ShippedNativeModuleFacts = HEALTHY_MODULE) {
    return findShippedNativeRuntimeViolations(module, deriveShippedNativeTreeFacts(nodes)).map((v) => v.code);
}

describe('shipped native Legend runtime guard', () => {
    it('accepts a real shipped-native tree', () => {
        const facts = deriveShippedNativeTreeFacts(HEALTHY_TREE);

        expect({
            codes: violationCodes(HEALTHY_TREE),
            rowFlavors: facts.positionViews.map((view) => view.flavor),
            scrollAdjustPx: facts.scrollAdjustPx,
        }).toEqual({
            codes: [],
            // The content container is an `Animated.View` too, but its style is not an array with a
            // positioning entry, so it must not be counted as a row carrier.
            rowFlavors: ['fabric-state'],
            scrollAdjustPx: 500,
        });
    });

    it('rejects an old-architecture tree even when the module claims new architecture', () => {
        // The dangerous case: something sets the Fabric marker but the Legend build was already
        // evaluated, so rows still render through PositionViewAnimated. Only the tree can tell.
        expect(violationCodes([SCROLLER_NODE, NATIVE_SCROLL_ADJUST_NODE, LEGACY_ROW_NODE]))
            .toEqual(['legacy_position_views']);
    });

    it('rejects a tree rendered by the web build', () => {
        const webTree: RenderedHostNode[] = [
            { props: { style: {} }, type: 'div' },
            { props: { style: [{ position: 'absolute' }, { top: 200 }] }, type: 'div' },
        ];

        expect(violationCodes(webTree)).toEqual(['web_build_resolved', 'native_scroll_adjust_absent']);
    });

    it('rejects the pre-existing native lane configuration', () => {
        // Native build, but `Platform.OS = 'node'` and no Fabric marker: what
        // `*.native.real.integration.test.tsx` runs today.
        expect(violationCodes([SCROLLER_NODE, NATIVE_SCROLL_ADJUST_NODE, LEGACY_ROW_NODE], {
            fabricUIManagerInstalled: false,
            isNewArchitecture: false,
            platformOS: 'node',
        })).toEqual([
            'fabric_marker_missing',
            'old_architecture',
            'non_mobile_platform',
            'legacy_position_views',
        ]);
    });

    it('rejects a tree with no native scroll-adjust carrier', () => {
        expect(violationCodes([SCROLLER_NODE, FABRIC_ROW_NODE])).toEqual(['native_scroll_adjust_absent']);
    });

    it('refuses to guess the architecture when the vendored package stops exposing it', () => {
        // `internal.IsNewArchitecture` is an undeclared runtime export. If a package upgrade drops
        // it, a structural read returns `undefined`, which is falsy and would report OLD
        // architecture - inverting every conclusion drawn from this lane while staying green.
        expect(() => readShippedNativeModuleFacts({ LegendList: () => null }, { OS: 'ios' }))
            .toThrow(/no longer exposes/);
    });

    it('classifies row carriers by architecture', () => {
        expect({
            fabric: classifyPositionViewNode(FABRIC_ROW_NODE),
            legacy: classifyPositionViewNode(LEGACY_ROW_NODE),
            // An Animated value that reached a plain `View` is still an old-architecture carrier.
            legacyOnPlainView: classifyPositionViewNode({
                props: { style: [{ position: 'absolute' }, { top: { _value: 8 } }] },
                type: 'View',
            }),
        }).toEqual({
            fabric: { flavor: 'fabric-state', top: 200 },
            legacy: { flavor: 'legacy-animated', top: null },
            legacyOnPlainView: { flavor: 'legacy-animated', top: null },
        });
    });
});
