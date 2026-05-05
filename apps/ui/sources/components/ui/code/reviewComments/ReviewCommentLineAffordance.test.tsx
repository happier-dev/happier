import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import {
    ReviewCommentLineAffordance,
    REVIEW_COMMENT_LINE_AFFORDANCE_TEST_ID,
} from './ReviewCommentLineAffordance';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ReviewCommentLineAffordance', () => {
    it('renders a hidden affordance as an inert accessibility-hidden spacer', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <ReviewCommentLineAffordance
                color="currentColor"
                onPress={onPress}
                visible={false}
            />,
        );

        const affordance = screen.findByTestId(REVIEW_COMMENT_LINE_AFFORDANCE_TEST_ID);
        expect(affordance?.props.onPress).toBeUndefined();
        expect(affordance?.props.accessibilityRole).toBeUndefined();
        expect(affordance?.props.accessible).toBe(false);
        expect(affordance?.props.focusable).toBe(false);
        expect(affordance?.props.accessibilityElementsHidden).toBe(true);
        expect(affordance?.props.importantForAccessibility).toBe('no-hide-descendants');
    });
});
