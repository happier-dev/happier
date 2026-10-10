import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';

import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

installAgentInputCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (value: any) => value.web ?? value.default ?? null,
        },
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    }),
    unistyles: () => createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#666',
            },
        },
    }),
    icons: () => ({
        Ionicons: 'Ionicons',
    }),
    text: () => createTextModuleMock({
        translate: (key: string) => key,
    }),
});

describe('AgentInputChipPickerTopSelector', () => {
    it('names every one-tap tab and keeps the last tab reachable in the shared horizontal scroll row', async () => {
        const { AgentInputChipPickerTopSelector } = await import('./AgentInputChipPickerTopSelector');
        const { AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE } = await import('./agentInputChipPickerOptionStyles');
        const { resolveMinimumInteractiveTargetSize } = await import('@/components/ui/interactiveTargetSize');
        const onFocusOption = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerTopSelector
                    sections={[
                        {
                            id: 'providers',
                            label: 'Providers',
                            options: [
                                { id: 'codex', label: 'Codex', subtitle: 'OpenAI', icon: React.createElement('EngineIcon', { testID: 'codex-icon', size: 24 }) },
                                { id: 'claude', label: 'Claude' },
                                { id: 'contributed-agent', label: 'A contributed coding Agent' },
                            ],
                        },
                    ]}
                    focusedOptionId="codex"
                    selectedOptionId="codex"
                    onFocusOption={onFocusOption}
                />);

        expect(screen.findByType(HorizontalScrollableRow).props).toEqual(expect.objectContaining({
            testID: 'agent-input-chip-picker.top-selector-scroll',
            contentTestID: 'agent-input-chip-picker.top-selector-content',
            fadeColor: expect.any(String),
            indicatorColor: expect.any(String),
        }));

        const codexButton = screen.findByTestId('agent-input-chip-picker.top-selector-option:codex');
        const claudeButton = screen.findByTestId('agent-input-chip-picker.top-selector-option:claude');

        expect(codexButton).toBeTruthy();
        expect(claudeButton).toBeTruthy();
        expect(codexButton?.findAll((node) => String(node.type) === 'Text').map(node => node.props.children)).toContain('Codex');
        expect(claudeButton?.findAll((node) => String(node.type) === 'Text').map(node => node.props.children)).toContain('Claude');
        expect(screen.findByTestId('agent-input-chip-picker.top-selector-option:contributed-agent')?.findAll((node) => String(node.type) === 'Text').map(node => node.props.children)).toContain('A contributed coding Agent');
        // The compact rail has no checkmark at all, so the selected row's name is the only
        // place its state can live — `accessibilityState.selected` is dropped on a button role.
        expect(codexButton?.props.accessibilityLabel).not.toBe('Codex');
        expect(claudeButton?.props.accessibilityLabel).toBe('Claude');

        const codexStyle = flattenStyle(codexButton?.props.style({ pressed: false }));
        const claudeStyle = flattenStyle(claudeButton?.props.style({ pressed: false }));
        expect(codexStyle.minWidth).toBe(resolveMinimumInteractiveTargetSize('web'));
        expect(codexStyle.minHeight).toBe(resolveMinimumInteractiveTargetSize('web'));
        // Content-sized tabs retain their full name and never shrink past the scroll end.
        expect(codexStyle.width).toBeUndefined();
        expect(codexStyle.flexShrink).toBe(0);
        expect(codexStyle.height).toBe(codexStyle.minHeight);
        expect(codexStyle.backgroundColor).toEqual(expect.any(String));
        expect(Boolean(codexStyle.boxShadow || codexStyle.elevation)).toBe(true);
        expect(claudeStyle.backgroundColor).toBe('transparent');

        // Located by identity rather than by child position: a chip renders its
        // icon plus any state marker, so a positional reach breaks the moment a
        // second child exists without telling us anything about the icon.
        const codexIcon = screen.findByTestId('codex-icon');
        expect(codexIcon?.props.size).toBe(AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE);

        await screen.pressByTestIdAsync('agent-input-chip-picker.top-selector-option:contributed-agent');
        expect(onFocusOption).toHaveBeenCalledWith('contributed-agent');
    });

    it('separates a labelled group with a divider and badges its rows with their state mark unless selected', async () => {
        const { AgentInputChipPickerTopSelector } = await import('./AgentInputChipPickerTopSelector');
        const screen = await renderScreen(<AgentInputChipPickerTopSelector
                    sections={[
                        { id: '__default__', options: [{ id: 'claude', label: 'Claude' }] },
                        {
                            id: 'notOnMachine',
                            label: 'Not on devbox yet',
                            options: [
                                { id: 'antigravity', label: 'Antigravity', sectionId: 'notOnMachine', muted: true, statusMarker: React.createElement('Marker', { testID: 'marker-antigravity' }) },
                                { id: 'gemini', label: 'Gemini', sectionId: 'notOnMachine', muted: true, statusMarker: React.createElement('Marker', { testID: 'marker-gemini' }) },
                            ],
                        },
                    ]}
                    focusedOptionId="gemini"
                    selectedOptionId="gemini"
                    onFocusOption={vi.fn()}
                />);

        expect(screen.findByTestId('agent-input-chip-picker.top-selector-divider:notOnMachine')).toBeTruthy();
        expect(screen.findByTestId('marker-antigravity')).toBeTruthy();
        // The selection shows as the selection, not as "not installed".
        expect(screen.findByTestId('marker-gemini')).toBeFalsy();
    });
});
