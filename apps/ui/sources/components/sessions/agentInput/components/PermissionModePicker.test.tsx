import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { PermissionModePicker } from './PermissionModePicker';
import type { EffectivePermissionModeDescription } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { describeEffectivePermissionMode } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { t } from '@/text';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function buildStyles(overrides?: Partial<{
    overlaySection: object;
    overlaySectionTitle: object;
    overlayOptionRow: object;
    overlayOptionRowPressed: object;
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
        overlayOptionLabel: {},
        overlayOptionLabelSelected: {},
        overlayOptionLabelUnselected: {},
        overlayOptionDescription: {},
        ...overrides,
    };
}

async function renderPicker(params: {
    selected: PermissionMode | null;
    onSelect?: ReturnType<typeof vi.fn<(mode: PermissionMode) => void>>;
    styles?: ReturnType<typeof buildStyles>;
    effectivePermissionPolicy?: EffectivePermissionModeDescription;
    effectivePermissionLabel?: string;
    options?: ReadonlyArray<{ value: PermissionMode; label: string; description: string; icon: string }>;
}) {
    const onSelect = params.onSelect ?? vi.fn<(mode: PermissionMode) => void>();
    const effectivePermissionPolicy: EffectivePermissionModeDescription =
        params.effectivePermissionPolicy ?? { effectiveMode: params.selected ?? 'default', reasons: [], notes: [] };
    const effectivePermissionLabel = params.effectivePermissionLabel ?? 'Effective';
    return {
        screen: await renderScreen(
            <PermissionModePicker
                title="PERMISSIONS"
                options={params.options ?? [
                    { value: 'default', label: 'Default', description: 'Ask each time', icon: 'shield' },
                    { value: 'yolo', label: 'YOLO', description: 'Skip prompts', icon: 'lightning' },
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
    it('shows the resolved unavailable sandbox reason while retaining the selected approval option', async () => {
        const { screen } = await renderPicker({
            selected: 'default',
            effectivePermissionPolicy: describeEffectivePermissionMode({
                agentType: 'codex', selectedMode: 'default', metadata: null, applyTiming: 'immediate',
                nativeSandbox: { value: 'on', source: 'machine', availability: {
                    status: 'unavailable', reason: 'not_available_in_sandbox_type',
                } },
            }),
        });
        expect(screen.getTextContent()).toContain(t('agentInput.permissionMode.nativeSandboxUnavailable'));
        expect(screen.findByTestId('permission-mode-default')?.props.accessibilityState).toEqual({ checked: true });
    });
    it('chooses no row while several targets differ (Mixed) and still applies a choice', async () => {
        const { screen, onSelect } = await renderPicker({ selected: null, effectivePermissionLabel: 'Mixed' });
        expect(screen.findByTestId('permission-mode-default')?.props.accessibilityState).toEqual({ checked: false });
        expect(screen.findByTestId('permission-mode-yolo')?.props.accessibilityState).toEqual({ checked: false });
        screen.pressByTestId('permission-mode-yolo');
        expect(onSelect).toHaveBeenCalledWith('yolo');
    });
    it('renders option descriptions', async () => {
        const { screen } = await renderPicker({ selected: 'default' });
        expect(screen.getTextContent()).toContain('Ask each time');
        expect(screen.getTextContent()).toContain('Skip prompts');
    });

    it('omits the description line of an option that has none', async () => {
        const descriptionStyle = { marker: 'description' };
        const { screen } = await renderPicker({
            selected: 'default',
            styles: buildStyles({ overlayOptionDescription: descriptionStyle }),
            options: [
                { value: 'default', label: 'Default', description: '', icon: 'shield' },
                { value: 'yolo', label: 'YOLO', description: 'Skip prompts', icon: 'lightning' },
            ],
        });

        // The effective-mode line plus the one described option; the empty one renders no line.
        expect(screen.findAll((node) => node.props?.style === descriptionStyle)).toHaveLength(2);
    });

    it('calls onSelect with the chosen mode', async () => {
        const onSelect = vi.fn<(mode: PermissionMode) => void>();
        const { screen } = await renderPicker({ selected: 'default', onSelect });

        const selected = screen.findByTestId('permission-mode-default');
        const unselected = screen.findByTestId('permission-mode-yolo');
        expect(selected).toBeTruthy();
        expect(unselected).toBeTruthy();
        expect(selected?.props.accessibilityRole).toBe('radio');
        expect(selected?.props.accessibilityLabel).toBe('Default');
        expect(selected?.props.accessibilityState).toEqual({ checked: true });
        expect(unselected?.props.accessibilityState).toEqual({ checked: false });

        screen.pressByTestId('permission-mode-yolo');

        expect(onSelect).toHaveBeenCalledWith('yolo');
    });

    it('fails closed when selected mode is not present in options', async () => {
        const { screen } = await renderPicker({ selected: 'plan' as unknown as PermissionMode });

        // The first option stands in for an unknown mode: exactly one radio reads as chosen.
        const checked = ['default', 'yolo'].map((mode) => screen.findByTestId(`permission-mode-${mode}`)?.props.accessibilityState?.checked);
        expect(checked).toEqual([true, false]);
    });
});
