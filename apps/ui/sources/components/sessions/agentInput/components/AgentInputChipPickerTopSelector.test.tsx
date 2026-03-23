import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedDropdownMenuProps: Record<string, unknown> | null = null;
const boundaryRef = { current: { nodeType: 'Boundary' } } as React.RefObject<any>;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Platform: {
                                    OS: 'web',
                                    select: (value: any) => value.web ?? value.default ?? null,
                                },
                                    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('Pressable', props, props.children),
                                    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('View', props, props.children),
                                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        capturedDropdownMenuProps = props;
        return React.createElement('DropdownMenu', props);
    },
}));

vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => boundaryRef,
    usePopoverPortalTarget: () => ({ rootRef: { current: null }, layout: { width: 0, height: 0 } }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('AgentInputChipPickerTopSelector', () => {
    it('forwards the surrounding popover boundary and body portal to the nested dropdown menu', async () => {
        const { AgentInputChipPickerTopSelector } = await import('./AgentInputChipPickerTopSelector');
        capturedDropdownMenuProps = null;

        await renderScreen(<AgentInputChipPickerTopSelector
                    sections={[
                        {
                            id: 'providers',
                            label: 'Providers',
                            options: [
                                { id: 'codex', label: 'Codex' },
                                { id: 'claude', label: 'Claude' },
                            ],
                        },
                    ]}
                    focusedOptionId="codex"
                    selectedOptionId="codex"
                    onFocusOption={() => undefined}
                />);

        expect(capturedDropdownMenuProps).toEqual(expect.objectContaining({
            popoverBoundaryRef: boundaryRef,
            popoverPortalWebTarget: 'body',
        }));
    });
});
