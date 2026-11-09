import { describe, expect, it } from 'vitest';
import { mergeOptionPickerProbes } from './mergeOptionPickerProbes';

describe('mergeOptionPickerProbes', () => {
    it('retains a failed probe alongside another successful probe and preserves retry', () => {
        let refreshed = false;
        const merged = mergeOptionPickerProbes([
            { phase: 'idle', failed: true, refreshErrorMessage: ' Run fx login. ', onRefresh: () => { refreshed = true; } },
            { phase: 'idle', failed: false },
        ]);
        expect(merged?.failed).toBe(true);
        expect(merged?.refreshErrorMessage).toBe(' Run fx login. ');
        merged?.onRefresh?.();
        expect(refreshed).toBe(true);
    });

    it('keeps terminal failure visible even when no refresh callback is available', () => {
        expect(mergeOptionPickerProbes([{ phase: 'idle', failed: true }])?.failed).toBe(true);
        expect(mergeOptionPickerProbes([{ phase: 'idle', failed: false }])).toBeUndefined();
    });
});
