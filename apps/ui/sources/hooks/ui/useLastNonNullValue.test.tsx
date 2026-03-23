import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useLastNonNullValue } from './useLastNonNullValue';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useLastNonNullValue', () => {
    it('keeps the last non-null value when the input becomes null', async () => {
        let current: any = null;

        function Probe(props: Readonly<{ value: string | null; resetKey?: string }>) {
            current = useLastNonNullValue(props.value, { resetKey: props.resetKey ?? null });
            return React.createElement('View');
        }

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(Probe, { value: 'a', resetKey: 'k1' }))).tree;

        expect(current).toBe('a');

        await act(async () => {
            tree.update(React.createElement(Probe, { value: null, resetKey: 'k1' }));
        });

        expect(current).toBe('a');
    });

    it('resets the stored value when resetKey changes', async () => {
        let current: any = null;

        function Probe(props: Readonly<{ value: string | null; resetKey?: string }>) {
            current = useLastNonNullValue(props.value, { resetKey: props.resetKey ?? null });
            return React.createElement('View');
        }

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(Probe, { value: 'a', resetKey: 'k1' }))).tree;

        expect(current).toBe('a');

        await act(async () => {
            tree.update(React.createElement(Probe, { value: null, resetKey: 'k2' }));
        });

        expect(current).toBe(null);
    });
});
