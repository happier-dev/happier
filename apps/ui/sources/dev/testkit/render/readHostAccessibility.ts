import type { ReactTestInstance } from 'react-test-renderer';

import { flattenTestStyle } from '../harness/popoverHarness';

/** Read effective host ancestry, including hidden retained panes above a control. */
export function readHostAccessibility(node: ReactTestInstance) {
    let inert = false;
    let hidden = false;
    let pointerBlocked = false;
    for (let current: ReactTestInstance | null = node; current; current = current.parent) {
        if (typeof current.type !== 'string') continue;
        const props = current.props;
        inert ||= props.inert === true || props.inert === '';
        hidden ||= props['aria-hidden'] === true || props['aria-hidden'] === 'true'
            || props.accessibilityElementsHidden === true || props.importantForAccessibility === 'no-hide-descendants';
        pointerBlocked ||= props.pointerEvents === 'none' || flattenTestStyle(props.style).pointerEvents === 'none';
    }
    return { inert, hidden, pointerBlocked };
}
