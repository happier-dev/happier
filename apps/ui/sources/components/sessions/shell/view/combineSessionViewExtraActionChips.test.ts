import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { describe, expect, it } from 'vitest';

import { combineSessionViewExtraActionChips } from './combineSessionViewExtraActionChips';

function createChip(key: string): AgentInputExtraActionChip {
    return {
        key,
        render: () => null,
    };
}

describe('combineSessionViewExtraActionChips', () => {
    it('reuses the right-side chips when the left side is absent', () => {
        const right = [createChip('right')];

        expect(combineSessionViewExtraActionChips(undefined, right)).toBe(right);
    });

    it('reuses the left-side chips when the right side is absent', () => {
        const left = [createChip('left')];

        expect(combineSessionViewExtraActionChips(left, undefined)).toBe(left);
    });

    it('returns undefined when both sides are absent', () => {
        expect(combineSessionViewExtraActionChips(undefined, undefined)).toBeUndefined();
    });

    it('allocates only when both sides have chips', () => {
        const left = [createChip('left')];
        const right = [createChip('right')];

        const combined = combineSessionViewExtraActionChips(left, right);

        expect(combined).toEqual([left[0], right[0]]);
        expect(combined).not.toBe(left);
        expect(combined).not.toBe(right);
    });

    it('reuses the combined chips for repeated identical inputs', () => {
        const left = [createChip('left')];
        const right = [createChip('right')];

        const first = combineSessionViewExtraActionChips(left, right);
        const second = combineSessionViewExtraActionChips(left, right);

        expect(first).toEqual([left[0], right[0]]);
        expect(second).toBe(first);
    });
});
