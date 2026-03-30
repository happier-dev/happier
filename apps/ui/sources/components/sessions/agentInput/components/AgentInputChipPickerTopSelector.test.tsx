import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';

import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedDropdownMenuProps: Record<string, unknown> | null = null;
const boundaryRef = { current: { nodeType: 'Boundary' } } as React.RefObject<any>;

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

vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => boundaryRef,
    usePopoverPortalTarget: () => ({ rootRef: { current: null }, layout: { width: 0, height: 0 } }),
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        capturedDropdownMenuProps = props;
        return React.createElement('DropdownMenu', props);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('AgentInputChipPickerTopSelector', () => {
    it('uses the shared item trigger while forwarding the surrounding popover boundary', async () => {
        const { AgentInputChipPickerTopSelector } = await import('./AgentInputChipPickerTopSelector');
        capturedDropdownMenuProps = null;

        await renderScreen(<AgentInputChipPickerTopSelector
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
                    onFocusOption={() => undefined}
                />);

        const dropdownMenuProps = capturedDropdownMenuProps as any;

        expect(dropdownMenuProps).toEqual(expect.objectContaining({
            popoverBoundaryRef: boundaryRef,
        }));
        expect(dropdownMenuProps.trigger).toBeUndefined();
        expect(dropdownMenuProps.itemTrigger).toEqual(expect.objectContaining({
            title: 'Codex',
            icon: expect.any(Object),
            subtitleFormatter: expect.any(Function),
            showSelectedDetail: false,
            itemProps: expect.objectContaining({
                testID: 'agent-input-chip-picker.top-selector-trigger',
                style: expect.objectContaining({
                    paddingHorizontal: 0,
                }),
            }),
        }));
        expect(dropdownMenuProps.itemTrigger.subtitleFormatter()).toBe('OpenAI');
        expect(dropdownMenuProps.items[0]).toEqual(expect.objectContaining({
            icon: expect.any(Object),
        }));

        const triggerIconChild = (dropdownMenuProps.itemTrigger.icon as any).props.children;
        expect(triggerIconChild.props.size).toBe(18);
        const menuIconChild = (dropdownMenuProps.items[0].icon as any).props.children;
        expect(menuIconChild.props.size).toBe(18);
    });
});
