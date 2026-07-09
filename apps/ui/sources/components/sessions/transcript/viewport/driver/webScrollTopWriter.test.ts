import { describe, expect, it } from 'vitest';

import { writeWebScrollTopAndObserve } from './webScrollTopWriter';

function ref<T>(value: T): { current: T } {
    return { current: value };
}

describe('writeWebScrollTopAndObserve — centralized web programmatic write + self-write observation', () => {
    it('writes the target and records the LANDED scrollTop/scrollHeight into the observation refs', () => {
        const element = { scrollTop: 100, scrollHeight: 2000 };
        const observedTop = ref<number | null>(null);
        const observedHeight = ref<number | null>(null);

        const result = writeWebScrollTopAndObserve({
            element,
            targetScrollTop: 1500,
            observedScrollTopRef: observedTop,
            observedScrollHeightRef: observedHeight,
        });

        expect(result).toEqual({ ok: true, landedScrollTop: 1500, landedScrollHeight: 2000 });
        expect(element.scrollTop).toBe(1500);
        // The observation refs hold the landed value so the echo onScroll is recognized as the app's own write.
        expect(observedTop.current).toBe(1500);
        expect(observedHeight.current).toBe(2000);
    });

    it('records the CLAMPED landed value, not the requested target (the under-shoot the self-write match keys on)', () => {
        // A scroller whose setter clamps the assignment to a max (e.g. the browser clamping past the bottom).
        const element = {
            scrollHeight: 2000,
            _top: 0,
            get scrollTop() {
                return this._top;
            },
            set scrollTop(v: number) {
                this._top = Math.min(v, 1480); // clamp / under-shoot
            },
        };
        const observedTop = ref<number | null>(null);
        const observedHeight = ref<number | null>(null);

        const result = writeWebScrollTopAndObserve({
            element,
            targetScrollTop: 1500,
            observedScrollTopRef: observedTop,
            observedScrollHeightRef: observedHeight,
        });

        expect(result.ok).toBe(true);
        expect(observedTop.current).toBe(1480); // landed, not the requested 1500
    });

    it('retries once and succeeds when the first assignment transiently throws', () => {
        let throwsLeft = 1;
        const element = {
            scrollHeight: 2000,
            _top: 0,
            get scrollTop() {
                return this._top;
            },
            set scrollTop(v: number) {
                if (throwsLeft > 0) {
                    throwsLeft -= 1;
                    throw new Error('transient reflow');
                }
                this._top = v;
            },
        };
        const observedTop = ref<number | null>(null);
        const observedHeight = ref<number | null>(null);

        const result = writeWebScrollTopAndObserve({
            element,
            targetScrollTop: 900,
            observedScrollTopRef: observedTop,
            observedScrollHeightRef: observedHeight,
        });

        expect(result.ok).toBe(true);
        expect(element.scrollTop).toBe(900);
        expect(observedTop.current).toBe(900);
    });

    it('returns ok:false and does NOT touch the observation refs when both attempts throw', () => {
        const element = {
            scrollHeight: 2000,
            get scrollTop() {
                return 0;
            },
            set scrollTop(_v: number) {
                throw new Error('always throws');
            },
        };
        const observedTop = ref<number | null>(777);
        const observedHeight = ref<number | null>(888);

        const result = writeWebScrollTopAndObserve({
            element,
            targetScrollTop: 900,
            observedScrollTopRef: observedTop,
            observedScrollHeightRef: observedHeight,
        });

        expect(result).toEqual({ ok: false });
        // Prior observation is left intact — a failed write must not corrupt the self-write baseline.
        expect(observedTop.current).toBe(777);
        expect(observedHeight.current).toBe(888);
    });
});
