import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '../cleanup/standardCleanup';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    });
});

vi.mock('@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView', () => ({
    ToolCallsGroupView: (props: { expanded: boolean; setExpanded: (expanded: boolean) => void }) => (
        <React.Fragment>
            {React.createElement('Pressable', {
                testID: 'transcript-tool-calls-header',
                onPress: () => props.setExpanded(!props.expanded),
            })}
            {React.createElement('View', {
                testID: `tool-calls-expanded:${String(props.expanded)}`,
            })}
        </React.Fragment>
    ),
}));

describe('toolCallsGroupHarness', () => {
    afterEach(standardCleanup);

    it('renders a stateful ToolCallsGroupView harness that toggles expanded state from the canonical header testID', async () => {
        const harnessModule = await import('./toolCallsGroupHarness');

        const renderStatefulToolCallsGroupView = Reflect.get(harnessModule, 'renderStatefulToolCallsGroupView');

        expect(typeof renderStatefulToolCallsGroupView).toBe('function');

        if (typeof renderStatefulToolCallsGroupView !== 'function') {
            return;
        }

        const screen = await renderStatefulToolCallsGroupView({
            toolMessages: [],
        });

        expect(screen.findByTestId('tool-calls-expanded:false')).not.toBeNull();

        await screen.pressByTestIdAsync('transcript-tool-calls-header');

        expect(screen.findByTestId('tool-calls-expanded:true')).not.toBeNull();
    });
});
