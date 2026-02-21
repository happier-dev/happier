import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useMountedShouldContinue } from './useMountedShouldContinue';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMountedShouldContinue', () => {
    it('returns true while mounted and false after unmount', async () => {
        let shouldContinue: (() => boolean) | null = null;
        let root: renderer.ReactTestRenderer | null = null;

        function Test() {
            shouldContinue = useMountedShouldContinue();
            return null;
        }

        await act(async () => {
            root = renderer.create(React.createElement(Test));
            await Promise.resolve();
        });

        expect(shouldContinue?.()).toBe(true);

        await act(async () => {
            root?.unmount();
            await Promise.resolve();
        });

        expect(shouldContinue?.()).toBe(false);
    });
});

