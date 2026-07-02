import { describe, expect, it } from 'vitest';

import { shouldShowMessageCopyButton, shouldShowMessageSelectButton } from './messageCopyVisibility';

const visibilityCases = [
    { platformOS: 'web' as const, isMessageHovered: false, isCopyButtonHovered: false, expected: false },
    { platformOS: 'web' as const, isMessageHovered: true, isCopyButtonHovered: false, expected: true },
    { platformOS: 'web' as const, isMessageHovered: false, isCopyButtonHovered: true, expected: true },
    { platformOS: 'web' as const, isMessageHovered: true, isCopyButtonHovered: true, expected: true },
    { platformOS: 'ios' as const, isMessageHovered: false, isCopyButtonHovered: false, expected: true },
    { platformOS: 'android' as const, isMessageHovered: true, isCopyButtonHovered: false, expected: true },
    { platformOS: 'windows' as const, isMessageHovered: false, isCopyButtonHovered: true, expected: true },
];

describe('message action visibility', () => {
    it.each(visibilityCases)(
        'shows copy=$expected for platform=$platformOS messageHovered=$isMessageHovered copyHovered=$isCopyButtonHovered',
        ({ platformOS, isMessageHovered, isCopyButtonHovered, expected }) => {
            expect(shouldShowMessageCopyButton({ platformOS, isMessageHovered, isCopyButtonHovered })).toBe(expected);
        },
    );

    it.each(visibilityCases)(
        'shows select=$expected for platform=$platformOS messageHovered=$isMessageHovered copyHovered=$isCopyButtonHovered',
        ({ platformOS, isMessageHovered, isCopyButtonHovered, expected }) => {
            expect(shouldShowMessageSelectButton({ platformOS, isMessageHovered, isCopyButtonHovered })).toBe(expected);
        },
    );

    it.each(visibilityCases)('keeps select and copy visibility in sync', (input) => {
        expect(shouldShowMessageSelectButton(input)).toBe(shouldShowMessageCopyButton(input));
    });

    it('shows copy and select actions on web while transcript selection mode is active', () => {
        const input = {
            platformOS: 'web' as const,
            isMessageHovered: false,
            isCopyButtonHovered: false,
            selectionModeActive: true,
        };

        expect(shouldShowMessageCopyButton(input)).toBe(true);
        expect(shouldShowMessageSelectButton(input)).toBe(true);
    });
});
