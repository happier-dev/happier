import { isValidElement } from 'react';
import { MotionConfig } from 'framer-motion';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
    it('respects the user reduced-motion preference for website motion components', () => {
        const tree = App();

        expect(isValidElement(tree)).toBe(true);
        if (!isValidElement(tree)) {
            throw new Error('App should return a React element');
        }

        expect(tree.type).toBe(MotionConfig);
        expect(
            (tree.props as { reducedMotion?: string }).reducedMotion,
        ).toBe('user');
    });
});
