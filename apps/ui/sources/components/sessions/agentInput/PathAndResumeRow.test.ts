import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        AppState: rn.AppState,
        Platform: { ...rn.Platform, OS: 'web' },
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Text', props, props.children),
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    };
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

        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(PathAndResumeRow, {
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
                }),
            );
        });

        const row = tree?.root.findByProps({ testID: 'agentInput-pathResumeRow' });
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

        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(PathAndResumeRow, {
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
                }),
            );
        });

        const pathChip = tree?.root.findAll(
            (node) => String(node.type) === 'Pressable' && node.props?.testID === 'agent-input-path-chip'
        );
        expect(pathChip).toHaveLength(1);
    });
});
