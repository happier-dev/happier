import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useEventCallback } from './useEventCallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useEventCallback', () => {
    it('returns a STABLE identity across renders (memo-stable callback prop)', () => {
        const identities: Array<() => void> = [];
        let forceRender: (() => void) | null = null;

        function Host() {
            const [, setTick] = React.useState(0);
            forceRender = () => setTick((value) => value + 1);
            const handler = useEventCallback(() => {});
            identities.push(handler);
            return null;
        }

        act(() => {
            create(<Host />);
        });
        act(() => forceRender?.());
        act(() => forceRender?.());

        expect(identities.length).toBeGreaterThanOrEqual(3);
        // A single stable reference across every render — this is what lets a
        // React.memo child skip re-rendering when only the parent re-rendered.
        expect(new Set(identities).size).toBe(1);
    });

    it('always invokes the LATEST closure (no stale capture)', () => {
        const observed: number[] = [];
        let stableHandler: (() => void) | null = null;
        let bump: (() => void) | null = null;

        function Host() {
            const [value, setValue] = React.useState(0);
            bump = () => setValue((current) => current + 1);
            stableHandler = useEventCallback(() => observed.push(value));
            return null;
        }

        act(() => {
            create(<Host />);
        });
        act(() => stableHandler?.()); // sees 0
        act(() => bump?.());
        act(() => stableHandler?.()); // must see 1, not the stale 0
        act(() => bump?.());
        act(() => stableHandler?.()); // must see 2

        expect(observed).toEqual([0, 1, 2]);
    });

    it('forwards arguments and return values to the latest closure', () => {
        const holder: { fn: ((a: number, b: number) => number) | null } = { fn: null };

        function Host() {
            holder.fn = useEventCallback((a: number, b: number) => a + b);
            return null;
        }

        act(() => {
            create(<Host />);
        });

        expect(holder.fn).not.toBeNull();
        expect(holder.fn?.(2, 3)).toBe(5);
    });
});
