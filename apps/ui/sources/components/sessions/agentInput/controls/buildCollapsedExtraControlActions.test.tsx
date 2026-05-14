import { describe, expect, it, vi } from 'vitest';

import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { buildCollapsedExtraControlActions } from './buildCollapsedExtraControlActions';

describe('buildCollapsedExtraControlActions', () => {
    it('does not surface malformed picker collapsed option popovers that only provide a list root step', () => {
        // Boundary fixture: models a dynamic descriptor that bypassed the
        // discriminated union before reaching collapsed action construction.
        const malformedPickerChip = {
            key: 'malformed-picker',
            controlId: 'recipient',
            collapsedOptionsPopover: {
                presentation: 'picker',
                title: 'Recipient',
                rootStep: {
                    id: 'recipient-root',
                    title: 'Recipient',
                    sections: [],
                },
                onSelect: () => undefined,
            },
            render: () => null,
        } as unknown as AgentInputExtraActionChip;

        const actions = buildCollapsedExtraControlActions({
            chips: [malformedPickerChip],
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedOptionsPopover: vi.fn(),
        });

        expect(actions.recipient).toBeUndefined();
    });
});
