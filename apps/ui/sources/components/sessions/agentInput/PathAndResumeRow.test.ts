import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
}));

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
    it('does not let the path chip flex-grow (keeps chips left-aligned)', async () => {
        const { PathAndResumeRow } = await import('./PathAndResumeRow');

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
});
