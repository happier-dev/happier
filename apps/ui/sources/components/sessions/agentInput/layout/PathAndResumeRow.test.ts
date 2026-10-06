import * as React from 'react';
import type { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { PathAndResumeRowProps } from './PathAndResumeRow';

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            // Forward actual native anchor refs; node identity is supplied by the renderer's SDK port.
            Pressable: React.forwardRef<View, React.ComponentProps<typeof import('react-native')['Pressable']>>(
                (props, ref) => React.createElement('Pressable', { ...props, ref }, props.children),
            ),
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
const styles = { pathRow: {}, actionButtonsLeft: {}, actionChip: {}, actionChipIconOnly: {}, actionChipPressed: {}, actionChipText: {} };
const baseProps = {
    styles, showChipLabels: true, iconColor: '#000',
    folderChipState: { kind: 'folder', path: '/workspace/long-folder-name' },
    resumeSessionId: 'session-1', resumeLabelTitle: 'Resume session', resumeLabelOptional: 'Resume: Optional',
} satisfies Omit<PathAndResumeRowProps, 'onPathClick' | 'onResumeClick'>;

async function renderRow(props: Partial<PathAndResumeRowProps> = {}) {
    const { PathAndResumeRow } = await import('./PathAndResumeRow');
    return renderScreen(React.createElement(runtime.Wrapper, null,
        React.createElement(PathAndResumeRow, { ...baseProps, ...props }),
    ));
}

describe('PathAndResumeRow', () => {
    it('keeps both actual folder and resume controls usable beside a leading machine control on phone', async () => {
        const onPathClick = vi.fn();
        const onResumeClick = vi.fn();
        const screen = await renderRow({
            onPathClick, onResumeClick,
            leadingControls: [React.createElement('Pressable', { key: 'machine', testID: 'agent-input-machine-chip' })],
        });
        const controls = screen.findAll(node => typeof node.type === 'string' && [
            'agent-input-machine-chip', 'agent-input-path-chip', 'agent-input-resume-chip',
        ].includes(node.props.testID));
        expect(controls.map(node => node.props.testID)).toEqual([
            'agent-input-machine-chip', 'agent-input-path-chip', 'agent-input-resume-chip',
        ]);
        expect(screen.getTextContent()).toContain(baseProps.folderChipState.path);
        await screen.pressByTestIdAsync('agent-input-path-chip');
        expect(onPathClick).toHaveBeenCalledOnce();
        expect(onResumeClick).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('agent-input-resume-chip');
        expect(onResumeClick).toHaveBeenCalledOnce();
    });

    it('keeps the canonical folder control mounted while the folder is resolving', async () => {
        const onPathClick = vi.fn();
        const screen = await renderRow({ folderChipState: { kind: 'resolving', lastKnownPath: null }, onPathClick });
        expect(screen.findHostByTestId('agent-input-path-chip')).not.toBeNull();
        expect(screen.findHostByTestId('agent-input-resume-chip')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-path-chip');
        expect(onPathClick).toHaveBeenCalledOnce();
    });

    it('publishes the mounted native anchors and clears them when the row unmounts', async () => {
        const { PathAndResumeRow } = await import('./PathAndResumeRow');
        const pathChipAnchorRef = React.createRef<View>();
        const resumeChipAnchorRef = React.createRef<View>();
        const nativeNodes = new Map<string, object>();
        const screen = await renderScreen(React.createElement(runtime.Wrapper, null,
            React.createElement(PathAndResumeRow, {
                ...baseProps, onPathClick: () => {}, onResumeClick: () => {}, pathChipAnchorRef, resumeChipAnchorRef,
            }),
        ), { createNodeMock: element => {
            const node = { focus: vi.fn(), measure: vi.fn() };
            if (typeof element.props.testID === 'string') nativeNodes.set(element.props.testID, node);
            return node;
        } });
        expect(pathChipAnchorRef.current).toBe(nativeNodes.get('agent-input-path-chip'));
        expect(resumeChipAnchorRef.current).toBe(nativeNodes.get('agent-input-resume-chip'));
        expect(pathChipAnchorRef.current).not.toBe(resumeChipAnchorRef.current);
        await screen.unmount();
        expect(pathChipAnchorRef.current).toBeNull();
        expect(resumeChipAnchorRef.current).toBeNull();
    });

    it('does not publish an empty control row when no control can be opened', async () => {
        const screen = await renderRow();
        expect(screen.findHostByTestId('agentInput-pathResumeRow')).toBeNull();
    });
});
