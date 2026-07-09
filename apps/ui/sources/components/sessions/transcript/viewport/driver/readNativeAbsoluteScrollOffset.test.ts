import { describe, expect, it } from 'vitest';

import { readNativeAbsoluteScrollOffset } from './readNativeAbsoluteScrollOffset';

describe('readNativeAbsoluteScrollOffset — guarded native raw-offset read', () => {
    it('returns the finite offset the list reports', () => {
        expect(readNativeAbsoluteScrollOffset({ getAbsoluteLastScrollOffset: () => 1480 } as never)).toBe(1480);
        expect(readNativeAbsoluteScrollOffset({ getAbsoluteLastScrollOffset: () => 0 } as never)).toBe(0);
    });

    it('returns null when the node or method is absent', () => {
        expect(readNativeAbsoluteScrollOffset(null)).toBeNull();
        expect(readNativeAbsoluteScrollOffset(undefined)).toBeNull();
        expect(readNativeAbsoluteScrollOffset({} as never)).toBeNull();
    });

    it('returns null for a non-finite reading (NaN/Infinity)', () => {
        expect(readNativeAbsoluteScrollOffset({ getAbsoluteLastScrollOffset: () => Number.NaN } as never)).toBeNull();
        expect(readNativeAbsoluteScrollOffset({ getAbsoluteLastScrollOffset: () => Infinity } as never)).toBeNull();
    });

    it('returns null (never throws) when the native read throws', () => {
        expect(
            readNativeAbsoluteScrollOffset({
                getAbsoluteLastScrollOffset: () => {
                    throw new Error('recycle in progress');
                },
            } as never),
        ).toBeNull();
    });
});
