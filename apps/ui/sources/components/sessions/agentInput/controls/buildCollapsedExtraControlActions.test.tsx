import { describe, expect, it, vi } from 'vitest';

import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { buildCollapsedExtraControlActions } from './buildCollapsedExtraControlActions';

describe('buildCollapsedExtraControlActions', () => {
    it('signals chip intent before opening content from the collapsed action menu', () => {
        const onIntent = vi.fn();
        const openCollapsedOptionsPopover = vi.fn();
        const chip: AgentInputExtraActionChip = {
            key: 'mcp',
            controlId: 'plugin:fixture/mcp',
            placement: { id: 'plugin:fixture/mcp', title: 'MCP' },
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

        actions['plugin:fixture/mcp']?.[0]?.onPress?.();

        expect(onIntent).toHaveBeenCalledTimes(1);
        expect(openCollapsedOptionsPopover).toHaveBeenCalledWith('mcp');
    });

    it('preserves an authored accessibility name for a collapsed content control', () => {
        const actions = buildCollapsedExtraControlActions({
            chips: [{
                key: 'accessible-content',
                controlId: 'plugin:acme.channels/source',
                placement: { id: 'plugin:acme.channels/source', title: 'Source' },
                collapsedContentPopover: {
                    title: 'Choose source',
                    label: 'Visible source label',
                    accessibilityLabel: 'Open source chooser',
                    renderContent: null,
                },
                render: () => null,
            } satisfies AgentInputExtraActionChip],
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedOptionsPopover: vi.fn(),
        });

        expect(actions['plugin:acme.channels/source']?.[0]).toEqual(expect.objectContaining({
            label: 'Visible source label',
            accessibilityLabel: 'Open source chooser',
        }));
    });

    it('gives each chip of a shared control its own menu item', () => {
        const optionsChip = (key: string) => ({
            key,
            controlId: 'organization',
            placement: { id: `organization:${key}`, title: key },
            collapsedOptionsPopover: { presentation: 'list', title: key, rootStep: { id: key, title: key, sections: [] }, selectedOptionId: null, onSelect: () => {} },
            render: () => null,
        }) as unknown as AgentInputExtraActionChip;

        const actions = buildCollapsedExtraControlActions({
            chips: [optionsChip('organization-folder'), optionsChip('organization-tags')],
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedOptionsPopover: vi.fn(),
        });

        expect(actions['organization:organization-folder']?.map((action) => action.id)).toEqual(['organization-folder']);
        expect(actions['organization:organization-tags']?.map((action) => action.id)).toEqual(['organization-tags']);
    });

    it('keeps a disabled content-popover control disabled after responsive collapse', () => {
        const disabledContentChip = {
            key: 'disabled-content',
            controlId: 'plugin:acme.channels/source',
            placement: { id: 'plugin:acme.channels/source', title: 'Source' },
            collapsedContentPopover: {
                title: 'Choose source',
                disabled: true,
                renderContent: null,
            },
            render: () => null,
        } as unknown as AgentInputExtraActionChip;

        const actions = buildCollapsedExtraControlActions({
            chips: [disabledContentChip],
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedOptionsPopover: vi.fn(),
        });

        expect(actions['plugin:acme.channels/source']?.[0]?.disabled).toBe(true);
    });

    it('rechecks a collapsed content control before opening after its mount retires', () => {
        let current = true;
        const dismiss = vi.fn();
        const openCollapsedOptionsPopover = vi.fn();
        const staleContentChip = {
            key: 'stale-content',
            controlId: 'plugin:acme.channels/source',
            placement: { id: 'plugin:acme.channels/source', title: 'Source' },
            collapsedContentPopover: {
                title: 'Choose source',
                isEnabled: () => current,
                renderContent: null,
            },
            render: () => null,
        } as unknown as AgentInputExtraActionChip;

        const actions = buildCollapsedExtraControlActions({
            chips: [staleContentChip],
            tint: 'currentColor',
            dismiss,
            blurInput: vi.fn(),
            openCollapsedOptionsPopover,
        });

        current = false;
        actions['plugin:acme.channels/source']?.[0]?.onPress?.();

        expect(dismiss).not.toHaveBeenCalled();
        expect(openCollapsedOptionsPopover).not.toHaveBeenCalled();
    });

    it('does not surface malformed picker collapsed option popovers that only provide a list root step', () => {
        // Boundary fixture: models a dynamic descriptor that bypassed the
        // discriminated union before reaching collapsed action construction.
        const malformedPickerChip = {
            key: 'malformed-picker',
            controlId: 'recipient',
            placement: { id: 'recipient', title: 'Recipient' },
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
