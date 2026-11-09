import * as React from 'react';
import type { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { PathAndResumeRow } from './PathAndResumeRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const styles = { pathRow: {}, actionButtonsLeft: {} };

describe('PathAndResumeRow', () => {
    it('keeps supplied ordered controls usable without constructing location controls', async () => {
        const onPathClick = vi.fn();
        const onResumeClick = vi.fn();
        const control = (id: string, onPress?: () => void) => React.createElement('Pressable', { key: id, testID: id, onPress });
        const screen = await renderScreen(React.createElement(PathAndResumeRow, {
            styles,
            leadingControls: [control('machine'), control('resume', onResumeClick), control('path', onPathClick)],
        }));
        const controls = screen.findAll(node => typeof node.type === 'string' && ['machine', 'resume', 'path'].includes(node.props.testID));
        expect(controls.map(node => node.props.testID)).toEqual(['machine', 'resume', 'path']);
        await screen.pressByTestIdAsync('path');
        expect(onPathClick).toHaveBeenCalledOnce();
        expect(onResumeClick).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('resume');
        expect(onResumeClick).toHaveBeenCalledOnce();
    });

    it('publishes supplied native anchors and clears them when the row unmounts', async () => {
        const ref = React.createRef<View>();
        const nativeNode = { focus: vi.fn(), measure: vi.fn() };
        const screen = await renderScreen(React.createElement(PathAndResumeRow, {
            styles, leadingControls: [React.createElement('Pressable', { key: 'path', testID: 'path', ref })],
        }), { createNodeMock: () => nativeNode });
        expect(ref.current).toBe(nativeNode);
        await screen.unmount();
        expect(ref.current).toBeNull();
    });

    it('does not publish an empty control row when the resolved secondary list is empty', async () => {
        const screen = await renderScreen(React.createElement(PathAndResumeRow, { styles }));
        expect(screen.findHostByTestId('agentInput-pathResumeRow')).toBeNull();
    });
});
