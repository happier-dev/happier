import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { PermissionModePicker } from './PermissionModePicker';
import type { EffectivePermissionModeDescription } from '@/sync/domains/permissions/describeEffectivePermissionMode';


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

async function renderPicker(params: {
    selected: PermissionMode;
    onSelect?: ReturnType<typeof vi.fn<(mode: PermissionMode) => void>>;
    styles?: ReturnType<typeof buildStyles>;
    effectivePermissionPolicy?: EffectivePermissionModeDescription;
    effectivePermissionLabel?: string;
}) {
    const onSelect = params.onSelect ?? vi.fn<(mode: PermissionMode) => void>();
    const effectivePermissionPolicy: EffectivePermissionModeDescription =
        params.effectivePermissionPolicy ?? { effectiveMode: params.selected, reasons: [], notes: [] };
    const effectivePermissionLabel = params.effectivePermissionLabel ?? 'Effective';
    return {
        screen: await renderScreen(
            <PermissionModePicker
                title="PERMISSIONS"
                options={[
                    { value: 'default', label: 'Default', description: 'Ask each time' },
                    { value: 'yolo', label: 'YOLO', description: 'Skip prompts' },
                ]}
                selected={params.selected}
                onSelect={onSelect}
                styles={params.styles ?? buildStyles()}
                effectivePermissionLabel={effectivePermissionLabel}
                effectivePermissionPolicy={effectivePermissionPolicy}
            />,
        ),
        onSelect,
    };
}

describe('PermissionModePicker', () => {
    it('renders option descriptions', async () => {
        const { screen } = await renderPicker({ selected: 'default' });
        expect(screen.getTextContent()).toContain('Ask each time');
        expect(screen.getTextContent()).toContain('Skip prompts');
    });

    it('calls onSelect with the chosen mode', async () => {
        const onSelect = vi.fn<(mode: PermissionMode) => void>();
        const { screen } = await renderPicker({ selected: 'default', onSelect });

        expect(screen.findByTestId('permission-mode-default')).toBeTruthy();
        expect(screen.findByTestId('permission-mode-yolo')).toBeTruthy();

        screen.pressByTestId('permission-mode-yolo');

        expect(onSelect).toHaveBeenCalledWith('yolo');
    });

    it('fails closed when selected mode is not present in options', async () => {
        const radioInnerStyle = { marker: 'inner' };
        const { screen } = await renderPicker({
            selected: 'plan' as unknown as PermissionMode,
            styles: buildStyles({ overlayRadioInner: radioInnerStyle }),
        });

        expect(screen.findByTestId('permission-mode-default')).toBeTruthy();
        expect(screen.findAll((node) => node.props?.style === radioInnerStyle)).toHaveLength(1);
    });
});
