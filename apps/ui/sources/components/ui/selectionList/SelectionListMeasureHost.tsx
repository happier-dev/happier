import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { selectionListTestId } from './_shared';

type SelectionListMeasureHostProps = Readonly<{
    rootTestID?: string;
    children: React.ReactNode;
    measureChildren?: React.ReactNode;
    measureMaxHeight?: number;
    onMeasureLayout: (event: LayoutChangeEvent) => void;
}>;

export function SelectionListMeasureHost(props: SelectionListMeasureHostProps): React.ReactElement {
    const measureSubtree = React.useMemo(
        () => stripIdentityProps(props.measureChildren ?? props.children),
        [props.measureChildren, props.children],
    );

    const measureStyle: StyleProp<ViewStyle> = props.measureMaxHeight !== undefined
        ? [hiddenMeasureStyle, { maxHeight: props.measureMaxHeight }]
        : hiddenMeasureStyle;

    return (
        <View
            testID={selectionListTestId(props.rootTestID, 'measure')}
            onLayout={props.onMeasureLayout}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={measureStyle}
            {...({ 'aria-hidden': true } as Record<string, unknown>)}
        >
            {measureSubtree}
        </View>
    );
}

/**
 * Hidden measure host. Positioned absolutely so it never participates in
 * the visible flex layout. We bound its width by the parent (left:0,
 * right:0) and its height grows up to the dynamic `maxHeight` cap injected
 * by the wrapper's own onLayout — so the reported height matches what the
 * popover surface will actually paint.
 */
const hiddenMeasureStyle: ViewStyle = {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
    zIndex: -1,
    overflow: 'hidden',
};

/**
 * RV-8 / FRESH-1 — props removed from every cloned element in the
 * measure-host mirror. These are the identity-bearing / accessibility
 * surface props whose duplication would (a) violate HTML id-uniqueness on
 * web (`id` / `nativeID`), (b) produce duplicate testIDs that break
 * `findByTestId` selectors, or (c) leak into the a11y tree even under an
 * `aria-hidden` parent (some screen readers still expose labelled
 * descendants). The mirror is render-only and does not need ANY of these.
 *
 * `key` and `ref` are intentionally not in this list — they are NOT cloned
 * onto the new element by `React.cloneElement` unless explicitly passed,
 * and stripping `key` would break React's reconciliation when the mirror
 * subtree contains lists.
 */
const STRIPPED_IDENTITY_PROPS: ReadonlyArray<string> = [
    'id',
    'nativeID',
    'testID',
    'role',
    'accessibilityRole',
    'accessibilityLabel',
    'accessibilityHint',
    'accessibilityValue',
    'accessibilityState',
    'accessibilityActions',
    'accessibilityLiveRegion',
    'accessibilityViewIsModal',
    'accessibilityElementsHidden',
    'importantForAccessibility',
    'htmlFor',
    'name',
];

function stripIdentityProps(node: React.ReactNode): React.ReactNode {
    if (node === null || node === undefined || typeof node === 'boolean') return node;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) {
        return node.map((child, idx) => {
            const stripped = stripIdentityProps(child);
            // Preserve keys for list reconciliation; React will warn about
            // missing keys in the mirror otherwise.
            if (React.isValidElement(stripped) && stripped.key == null) {
                return React.cloneElement(stripped, { key: `m-${idx}` });
            }
            return stripped;
        });
    }
    if (!React.isValidElement(node)) return node;

    const element = node as React.ReactElement<Record<string, unknown>>;
    const oldProps = element.props ?? {};
    const replacementProps: Record<string, unknown> = {};
    for (const key of Object.keys(oldProps)) {
        if (key === 'children') continue;
        if (
            STRIPPED_IDENTITY_PROPS.includes(key)
            || key.startsWith('aria-')
            || key.startsWith('data-')
        ) {
            replacementProps[key] = undefined;
        }
    }
    const strippedChildren = stripIdentityProps(oldProps.children as React.ReactNode);
    return React.cloneElement(element, replacementProps, strippedChildren);
}
