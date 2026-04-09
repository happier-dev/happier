import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { isRenderableElementType } from './isRenderableElementType';

describe('isRenderableElementType', () => {
    it('rejects already-instantiated React elements', () => {
        expect(isRenderableElementType(React.createElement('View'))).toBe(false);
    });

    it('accepts fragment element types', () => {
        expect(isRenderableElementType(React.Fragment)).toBe(true);
    });

    it('accepts memoized component types', () => {
        const MemoComponent = React.memo(function MemoComponent() {
            return null;
        });

        expect(isRenderableElementType(MemoComponent)).toBe(true);
    });

    it('accepts forwardRef component types', () => {
        const ForwardRefComponent = React.forwardRef(function ForwardRefComponent(_props: {}, _ref: React.ForwardedRef<unknown>) {
            return null;
        });

        expect(isRenderableElementType(ForwardRefComponent)).toBe(true);
    });
});
