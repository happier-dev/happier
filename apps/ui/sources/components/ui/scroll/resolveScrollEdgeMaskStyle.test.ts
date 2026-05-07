import { describe, expect, it } from 'vitest';

import { resolveVerticalScrollEdgeMaskStyle } from './resolveScrollEdgeMaskStyle';

describe('resolveVerticalScrollEdgeMaskStyle', () => {
    it('does not apply a mask when no vertical edge is visible', () => {
        expect(resolveVerticalScrollEdgeMaskStyle({
            top: false,
            bottom: false,
            left: false,
            right: false,
        })).toBeNull();
    });

    it('fades only the bottom edge when more content is below', () => {
        const style = resolveVerticalScrollEdgeMaskStyle({
            top: false,
            bottom: true,
            left: false,
            right: false,
        }, { fadeSize: 14 });

        expect(style?.maskImage).toContain('black 0px');
        expect(style?.maskImage).toContain('black calc(100% - 14px)');
        expect(style?.maskImage).toContain('transparent 100%');
        expect(style?.WebkitMaskImage).toBe(style?.maskImage);
    });

    it('fades only the top edge when content exists above', () => {
        const style = resolveVerticalScrollEdgeMaskStyle({
            top: true,
            bottom: false,
            left: false,
            right: false,
        }, { fadeSize: 14 });

        expect(style?.maskImage).toContain('transparent 0px');
        expect(style?.maskImage).toContain('black 14px');
        expect(style?.maskImage).toContain('black 100%');
    });

    it('fades both vertical edges when content exists above and below', () => {
        const style = resolveVerticalScrollEdgeMaskStyle({
            top: true,
            bottom: true,
            left: false,
            right: false,
        }, { fadeSize: 14 });

        expect(style?.maskImage).toBe(
            'linear-gradient(to bottom, transparent 0px, black 14px, black calc(100% - 14px), transparent 100%)',
        );
    });
});
