import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { PermissionModePicker } from './PermissionModePicker';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function buildStyles(overrides?: Partial<{
    overlaySection: object;
    overlaySectionTitle: object;
    overlayOptionRow: object;
    overlayOptionRowPressed: object;
    overlayRadioOuter: object;
    overlayRadioOuterSelected: object;
    overlayRadioOuterUnselected: object;
    overlayRadioInner: object;
    overlayOptionLabel: object;
    overlayOptionLabelSelected: object;
    overlayOptionLabelUnselected: object;
    overlayOptionDescription: object;
}>) {
    return {
        overlaySection: {},
        overlaySectionTitle: {},
        overlayOptionRow: {},
        overlayOptionRowPressed: {},
        overlayRadioOuter: {},
        overlayRadioOuterSelected: {},
        overlayRadioOuterUnselected: {},
        overlayRadioInner: {},
        overlayOptionLabel: {},
        overlayOptionLabelSelected: {},
        overlayOptionLabelUnselected: {},
        overlayOptionDescription: {},
        ...overrides,
    };
}

function renderPicker(params: {
    selected: PermissionMode;
    onSelect?: ReturnType<typeof vi.fn<(mode: PermissionMode) => void>>;
    styles?: ReturnType<typeof buildStyles>;
}) {
    const onSelect = params.onSelect ?? vi.fn<(mode: PermissionMode) => void>();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(
            <PermissionModePicker
                title="PERMISSIONS"
                options={[
                    { value: 'default', label: 'Default', description: 'Ask each time' },
                    { value: 'yolo', label: 'YOLO', description: 'Skip prompts' },
                ]}
                selected={params.selected}
                onSelect={onSelect}
                styles={params.styles ?? buildStyles()}
            />,
        );
    });
    return { tree: tree!, onSelect };
}

function findTextNodes(tree: renderer.ReactTestRenderer, text: string): ReactTestInstance[] {
    return tree.root.findAll((node) => node.type === 'Text' && node.props.children === text);
}

describe('PermissionModePicker', () => {
    it('renders option descriptions', () => {
        const { tree } = renderPicker({ selected: 'default' });
        expect(findTextNodes(tree, 'Ask each time').length).toBeGreaterThan(0);
        expect(findTextNodes(tree, 'Skip prompts').length).toBeGreaterThan(0);
    });

    it('calls onSelect with the chosen mode', () => {
        const onSelect = vi.fn<(mode: PermissionMode) => void>();
        const { tree } = renderPicker({ selected: 'default', onSelect });

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables).toHaveLength(2);

        act(() => {
            pressables[1]?.props.onPress?.();
        });

        expect(onSelect).toHaveBeenCalledWith('yolo');
    });

    it('fails closed when selected mode is not present in options', () => {
        const radioInnerStyle = { marker: 'inner' };
        const { tree } = renderPicker({
            selected: 'plan' as unknown as PermissionMode,
            styles: buildStyles({ overlayRadioInner: radioInnerStyle }),
        });

        expect(tree.root.findAllByProps({ style: radioInnerStyle })).toHaveLength(1);
    });
});
