import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { DigitField } from './VoiceLight';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('DigitField accessibility', () => {
    it('hides its decorative digits from the accessibility tree', () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<DigitField color="#ffffff" />);
        });

        const field = tree!.root.findByType(View);
        expect(field.props['aria-hidden']).toBe(true);
        expect(field.props.accessibilityElementsHidden).toBe(true);
        expect(field.props.importantForAccessibility).toBe('no-hide-descendants');

        act(() => {
            tree!.unmount();
        });
    });
});
