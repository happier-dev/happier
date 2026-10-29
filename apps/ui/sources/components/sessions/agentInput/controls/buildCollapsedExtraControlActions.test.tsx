import { describe, expect, it, vi } from 'vitest';

import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { buildCollapsedExtraControlActions } from './buildCollapsedExtraControlActions';

describe('buildCollapsedExtraControlActions', () => {
    it('signals chip intent before opening content from the collapsed action menu', () => {
        const onIntent = vi.fn();
        const openCollapsedOptionsPopover = vi.fn();
        const chip: AgentInputExtraActionChip = {
            key: 'mcp',
            controlId: 'mcp',
            onIntent,
            collapsedContentPopover: {
                title: 'MCP',
                renderContent: () => null,
            },
            render: () => null,
        };

        const actions = buildCollapsedExtraControlActions({
            chips: [chip],
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedOptionsPopover,
        });

        actions.mcp?.[0]?.onPress?.();

        expect(onIntent).toHaveBeenCalledTimes(1);
        expect(openCollapsedOptionsPopover).toHaveBeenCalledWith('mcp');
    });

    it('signals chip intent before opening options from the collapsed action menu', () => {
        const onIntent = vi.fn();
        const openCollapsedOptionsPopover = vi.fn();
        const chip: AgentInputExtraActionChip = {
            key: 'recipient',
            controlId: 'recipient',
            onIntent,
            collapsedOptionsPopover: {
                title: 'Recipient',
                options: [{ id: 'lead', label: 'Lead agent' }],
                onSelect: vi.fn(),
            },
            render: () => null,
        };

        const actions = buildCollapsedExtraControlActions({
            chips: [chip],
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedOptionsPopover,
        });

        actions.recipient?.[0]?.onPress?.();

        expect(onIntent).toHaveBeenCalledTimes(1);
        expect(openCollapsedOptionsPopover).toHaveBeenCalledWith('recipient');
    });

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

    it('keeps every collapsed entry of a disabled chip disabled', () => {
        const chips: AgentInputExtraActionChip[] = [
            {
                key: 'content',
                controlId: 'mcp',
                disabled: true,
                collapsedContentPopover: { title: 'MCP', renderContent: () => null },
                render: () => null,
            },
            {
                key: 'options',
                controlId: 'recipient',
                disabled: true,
                collapsedOptionsPopover: {
                    title: 'Recipient',
                    options: [{ id: 'lead', label: 'Lead agent' }],
                    onSelect: vi.fn(),
                },
                render: () => null,
            },
            {
                key: 'direct',
                controlId: 'reviewComments',
                disabled: true,
                collapsedAction: () => ({ id: 'review-comments', label: 'Review', onPress: vi.fn() }),
                render: () => null,
            },
        ];

        const actions = buildCollapsedExtraControlActions({
            chips,
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedOptionsPopover: vi.fn(),
        });

        expect(Object.values(actions).flat().map((action) => action?.disabled)).toEqual([true, true, true]);
    });
});
