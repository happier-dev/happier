import { describe, expect, it } from 'vitest';

import { getCurrentReactOwnerHint, getUnexpectedPrimitiveViewChildInfo } from '@/utils/system/debugUnexpectedTextNodeCapture';

describe('getUnexpectedPrimitiveViewChildInfo', () => {
    it('returns debug info for primitive string children under View', () => {
        const result = getUnexpectedPrimitiveViewChildInfo({
            type: { displayName: 'View' },
            props: { testID: 'voice-row', accessibilityLabel: 'Voice row' },
            flatChildren: [''],
        });

        expect(result).toEqual({
            typeName: 'View',
            isViewLike: true,
            primitiveChildCount: 1,
            primitiveSamples: ['"" (U+F518)'],
            signature: 'View|voice-row|Voice row|',
            testID: 'voice-row',
            accessibilityLabel: 'Voice row',
        });
    });

    it('returns null for non-view-like types', () => {
        const result = getUnexpectedPrimitiveViewChildInfo({
            type: { displayName: 'Text' },
            props: { testID: 'voice-row' },
            flatChildren: ['.'],
        });

        expect(result).toBeNull();
    });

    it('captures whitespace-only strings so RNW blank text-node crashes can be diagnosed', () => {
        const result = getUnexpectedPrimitiveViewChildInfo({
            type: { displayName: 'View' },
            props: null,
            flatChildren: ['', '   ', null, false],
        });

        expect(result).toEqual({
            typeName: 'View',
            isViewLike: true,
            primitiveChildCount: 1,
            primitiveSamples: ['"   " (U+0020 U+0020 U+0020)'],
            signature: 'View|||   ',
            testID: null,
            accessibilityLabel: null,
        });
    });

    it('returns the current react owner hint when available', () => {
        const reactValue = {
            __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
                ReactCurrentOwner: {
                    current: {
                        type: { displayName: 'DropdownMenu' },
                        _debugSource: { fileName: 'DropdownMenu.tsx', lineNumber: 42 },
                    },
                },
            },
        };

        expect(getCurrentReactOwnerHint(reactValue)).toEqual({
            ownerName: 'DropdownMenu',
            source: { fileName: 'DropdownMenu.tsx', lineNumber: 42 },
        });
    });
});
