import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                Pressable: React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref) =>
                                    React.createElement('Pressable', { ...props, __ref: ref }, props.children)),
                                Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                    React.createElement('Text', props, props.children),
                                View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                    React.createElement('View', props, props.children),
                            }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('./ResumeChip', () => ({
    ResumeChip: (props: Record<string, unknown>) => React.createElement('ResumeChip', props, null),
}));

function hasFlexGrowOne(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    return (value as { flexGrow?: number }).flexGrow === 1;
}

describe('PathAndResumeRow', () => {
    let PathAndResumeRow: (typeof import('./PathAndResumeRow'))['PathAndResumeRow'];

    beforeAll(async () => {
        ({ PathAndResumeRow } = await import('./PathAndResumeRow'));
    }, 60_000);

    it('does not let the path chip flex-grow (keeps chips left-aligned)', async () => {
        const styles = {
            pathRow: {},
            actionButtonsLeft: {},
            actionChip: {},
            actionChipIconOnly: {},
            actionChipPressed: {},
            actionChipText: {},
        };

        const screen = await renderScreen(React.createElement(PathAndResumeRow, {
                    styles,
                    showChipLabels: true,
                    iconColor: '#000',
                    currentPath: '/Users/leeroy/Development/happy-local',
                    onPathClick: () => {},
                    emptyPathLabel: 'Select Path',
                    resumeSessionId: null,
                    onResumeClick: () => {},
                    resumeLabelTitle: 'Resume session',
                    resumeLabelOptional: 'Resume: Optional',
                }));

        const row = screen.findByTestId('agentInput-pathResumeRow');
        expect(row).toBeTruthy();

        const pathChipPressable = row?.findAllByType('Pressable')?.[0] as ReactTestInstance | undefined;
        expect(pathChipPressable).toBeTruthy();

        const styleFn = pathChipPressable?.props.style as ((input: { pressed: boolean }) => unknown) | undefined;
        expect(typeof styleFn).toBe('function');

        const computed = styleFn?.({ pressed: false });
        const styleParts = Array.isArray(computed) ? computed : [computed];
        expect(styleParts.some(hasFlexGrowOne)).toBe(false);
    });

    it('exposes the canonical path chip testID for new-session automation and routing flows', async () => {
        const styles = {
            pathRow: {},
            actionButtonsLeft: {},
            actionChip: {},
            actionChipIconOnly: {},
            actionChipPressed: {},
            actionChipText: {},
        };

        const screen = await renderScreen(React.createElement(PathAndResumeRow, {
                    styles,
                    showChipLabels: true,
                    iconColor: '#000',
                    currentPath: '',
                    onPathClick: () => {},
                    emptyPathLabel: 'Select Path',
                    resumeSessionId: null,
                    onResumeClick: undefined,
                    resumeLabelTitle: 'Resume session',
                    resumeLabelOptional: 'Resume: Optional',
                }));

        const pathChip = screen.findByTestId('agent-input-path-chip');
        expect(pathChip?.props?.testID).toBe('agent-input-path-chip');
    });

    it('renders leading secondary controls before the path and resume chips', async () => {
        const styles = {
            pathRow: {},
            actionButtonsLeft: {},
            actionChip: {},
            actionChipIconOnly: {},
            actionChipPressed: {},
            actionChipText: {},
        };

        const screen = await renderScreen(React.createElement(PathAndResumeRow, {
                    styles,
                    leadingControls: [
                        React.createElement('Pressable', { key: 'machine', testID: 'agent-input-machine-chip' }),
                    ],
                    showChipLabels: true,
                    iconColor: '#000',
                    currentPath: '/Users/leeroy/Development/happy-local',
                    onPathClick: () => {},
                    emptyPathLabel: 'Select Path',
                    resumeSessionId: 'session-1',
                    onResumeClick: () => {},
                    resumeLabelTitle: 'Resume session',
                    resumeLabelOptional: 'Resume: Optional',
                }));

        const row = screen.findByTestId('agentInput-pathResumeRow');
        const pressables = row?.findAllByType('Pressable') ?? [];
        const testIds = pressables.map((node) => node.props.testID).filter(Boolean);

        expect(testIds.slice(0, 2)).toEqual(['agent-input-machine-chip', 'agent-input-path-chip']);
    });

    it('forwards the shared anchor refs to the visible wrap-row path and resume chips', async () => {
        const styles = {
            pathRow: {},
            actionButtonsLeft: {},
            actionChip: {},
            actionChipIconOnly: {},
            actionChipPressed: {},
            actionChipText: {},
        };
        const pathChipAnchorRef = React.createRef<any>();
        const resumeChipAnchorRef = React.createRef<any>();

        const screen = await renderScreen(React.createElement(PathAndResumeRow, {
                    styles,
                    showChipLabels: true,
                    iconColor: '#000',
                    currentPath: '/workspace',
                    pathChipAnchorRef,
                    onPathClick: () => {},
                    emptyPathLabel: 'Select Path',
                    resumeSessionId: 'session-1',
                    resumeChipAnchorRef,
                    onResumeClick: () => {},
                    resumeLabelTitle: 'Resume session',
                    resumeLabelOptional: 'Resume: Optional',
                }));

        const pathChip = screen.findByTestId('agent-input-path-chip');
        const resumeChip = screen.findByType('ResumeChip');

        expect(pathChip?.props.__ref).toBe(pathChipAnchorRef);
        expect(resumeChip?.props.anchorRef).toBe(resumeChipAnchorRef);
    });
});
