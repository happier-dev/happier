import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';

import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedDropdownMenuProps: Record<string, unknown> | null = null;
let capturedHorizontalRowProps: Record<string, unknown> | null = null;

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

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        capturedDropdownMenuProps = props;
        return React.createElement('DropdownMenu', props);
    },
}));

vi.mock('@/components/ui/scroll/HorizontalScrollableRow', () => ({
    HorizontalScrollableRow: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        capturedHorizontalRowProps = props;
        return React.createElement('HorizontalScrollableRow', props, props.children);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('AgentInputChipPickerTopSelector', () => {
    it('renders a one-tap icon rail using the shared horizontal scroll row', async () => {
        const { AgentInputChipPickerTopSelector } = await import('./AgentInputChipPickerTopSelector');
        const { AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE } = await import('./agentInputChipPickerOptionStyles');
        capturedDropdownMenuProps = null;
        capturedHorizontalRowProps = null;
        const onFocusOption = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerTopSelector
                    sections={[
                        {
                            id: 'providers',
                            label: 'Providers',
                            options: [
                                { id: 'codex', label: 'Codex', subtitle: 'OpenAI', icon: React.createElement('EngineIcon', { size: 24 }) },
                                { id: 'claude', label: 'Claude' },
                            ],
                        },
                    ]}
                    focusedOptionId="codex"
                    selectedOptionId="codex"
                    onFocusOption={onFocusOption}
                />);

        expect(capturedDropdownMenuProps).toBeNull();
        expect(capturedHorizontalRowProps).toEqual(expect.objectContaining({
            testID: 'agent-input-chip-picker.top-selector-scroll',
            contentTestID: 'agent-input-chip-picker.top-selector-content',
            fadeColor: expect.any(String),
            indicatorColor: expect.any(String),
        }));

        const codexButton = screen.findByTestId('agent-input-chip-picker.top-selector-option:codex');
        const claudeButton = screen.findByTestId('agent-input-chip-picker.top-selector-option:claude');

        expect(codexButton).toBeTruthy();
        expect(claudeButton).toBeTruthy();
        expect(codexButton?.props.accessibilityLabel).toBe('Codex');
        expect(claudeButton?.props.accessibilityLabel).toBe('Claude');

        const codexStyle = flattenStyle(codexButton?.props.style({ pressed: false }));
        const claudeStyle = flattenStyle(claudeButton?.props.style({ pressed: false }));
        expect(codexStyle.width).toBe(36);
        expect(codexStyle.height).toBe(36);
        expect(codexStyle.backgroundColor).toEqual(expect.any(String));
        expect(Boolean(codexStyle.boxShadow || codexStyle.elevation)).toBe(true);
        expect(claudeStyle.backgroundColor).toBe('transparent');

        const codexIconChild = codexButton?.props.children.props.children;
        expect(codexIconChild.props.size).toBe(AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE);

        await screen.pressByTestIdAsync('agent-input-chip-picker.top-selector-option:claude');
        expect(onFocusOption).toHaveBeenCalledWith('claude');
    });
});
