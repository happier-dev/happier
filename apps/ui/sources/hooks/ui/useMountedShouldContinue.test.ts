import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useMountedShouldContinue } from './useMountedShouldContinue';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMountedShouldContinue', () => {
    it('returns true while mounted and false after unmount', async () => {
        let shouldContinue: () => boolean = () => {
            throw new Error('expected shouldContinue to be set');
        };
        let root: renderer.ReactTestRenderer | null = null;

        function Test() {
            shouldContinue = useMountedShouldContinue();
            return null;
        }

        root = (await renderScreen(React.createElement(Test))).tree;

        expect(shouldContinue()).toBe(true);

        await act(async () => {
            root?.unmount();
            await Promise.resolve();
        });

        expect(shouldContinue()).toBe(false);
    });
});
