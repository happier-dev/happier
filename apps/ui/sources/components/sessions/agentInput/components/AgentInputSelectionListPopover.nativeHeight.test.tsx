import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { SelectionListStep } from '@/components/ui/selectionList';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capturedSelectionLists = vi.hoisted(() => [] as Array<Record<string, unknown>>);

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
        });
    },
});

vi.mock('../selection/AgentInputSelectionPopover', () => ({
    AgentInputSelectionPopover: (props: Record<string, unknown> & {
        children?: (args: { maxHeight: number }) => React.ReactNode;
    }) => React.createElement(
        'AgentInputSelectionPopover',
        props,
        typeof props.children === 'function' ? props.children({ maxHeight: 312 }) : null,
    ),
}));

vi.mock('./AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('AgentInputPopoverSurface', props, props.children),
}));

vi.mock('@/components/ui/selectionList', () => ({
    SelectionList: (props: Record<string, unknown>) => {
        capturedSelectionLists.push(props);
        return React.createElement('SelectionList', props);
    },
    resolvePopoverSelectionListHeightBehavior: () => 'measuredToMaxHeight',
}));

const rootStep: SelectionListStep = {
    id: 'root',
    sections: [{ kind: 'static', id: 'main', options: [{ id: 'a', label: 'A' }] }],
};

describe('AgentInputSelectionListPopover native height', () => {
    it('uses measured SelectionList height under the computed popover height cap on native', async () => {
        capturedSelectionLists.length = 0;
        const { AgentInputSelectionListPopover } = await import('./AgentInputSelectionListPopover');

        await renderScreen(
            <AgentInputSelectionListPopover
                open
                anchorRef={{ current: {} }}
                rootStep={rootStep}
                onSelect={() => {}}
                onRequestClose={() => {}}
            />,
        );

        expect(capturedSelectionLists[0]?.heightBehavior).toBe('measuredToMaxHeight');
    });
});
