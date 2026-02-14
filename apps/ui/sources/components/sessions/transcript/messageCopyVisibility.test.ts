import { describe, expect, it } from 'vitest';

import { shouldShowMessageCopyButton } from './messageCopyVisibility';

describe('shouldShowMessageCopyButton', () => {
    it.each([
        { platformOS: 'web' as const, isMessageHovered: false, isCopyButtonHovered: false, expected: false },
        { platformOS: 'web' as const, isMessageHovered: true, isCopyButtonHovered: false, expected: true },
        { platformOS: 'web' as const, isMessageHovered: false, isCopyButtonHovered: true, expected: true },
        { platformOS: 'web' as const, isMessageHovered: true, isCopyButtonHovered: true, expected: true },
        { platformOS: 'ios' as const, isMessageHovered: false, isCopyButtonHovered: false, expected: true },
        { platformOS: 'android' as const, isMessageHovered: true, isCopyButtonHovered: false, expected: true },
        { platformOS: 'windows' as const, isMessageHovered: false, isCopyButtonHovered: true, expected: true },
    ])(
        'returns $expected for platform=$platformOS messageHovered=$isMessageHovered copyHovered=$isCopyButtonHovered',
        ({ platformOS, isMessageHovered, isCopyButtonHovered, expected }) => {
            expect(shouldShowMessageCopyButton({ platformOS, isMessageHovered, isCopyButtonHovered })).toBe(expected);
        },
    );
});
