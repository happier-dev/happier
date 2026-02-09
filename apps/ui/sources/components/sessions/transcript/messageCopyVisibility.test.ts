import { describe, expect, it } from 'vitest';

import { shouldShowMessageCopyButton } from './messageCopyVisibility';

describe('shouldShowMessageCopyButton', () => {
    it.each([
        { platformOS: 'web' as const, isHovered: false, expected: false },
        { platformOS: 'web' as const, isHovered: true, expected: true },
        { platformOS: 'ios' as const, isHovered: false, expected: true },
        { platformOS: 'android' as const, isHovered: true, expected: true },
        { platformOS: 'windows' as const, isHovered: false, expected: true },
    ])('returns $expected for platform=$platformOS hovered=$isHovered', ({ platformOS, isHovered, expected }) => {
        expect(shouldShowMessageCopyButton({ platformOS, isHovered })).toBe(expected);
    });
});
