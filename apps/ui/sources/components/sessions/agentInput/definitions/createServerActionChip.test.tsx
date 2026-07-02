import { describe, expect, it } from 'vitest';

import { createServerActionChip } from './createServerActionChip';

describe('createServerActionChip', () => {
    it('lets the shared popover surface own native scrolling for dynamic server content height', () => {
        const chip = createServerActionChip({
            label: 'Server',
            popoverContent: null,
        });

        expect(chip.collapsedContentPopover?.scrollEnabled).toBe(true);
    });
});
