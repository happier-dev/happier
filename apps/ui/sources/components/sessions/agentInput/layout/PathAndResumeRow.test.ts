import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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
    ResumeChip: (props: Record<string, unknown>) =>
        React.createElement('Pressable', { ...props, testID: 'agent-input-resume-chip' }, null),
}));

function hasFlexGrowOne(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    return (value as { flexGrow?: number }).flexGrow === 1;
}

function hasFlexShrinkZero(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    return (value as { flexShrink?: number }).flexShrink === 0;
}

function toArray<T>(value: T | readonly T[] | undefined): readonly T[] {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value] as readonly T[];
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

        const actionButtonsLeft = toArray(row?.props?.children)[0];
        const rowChildren = React.Children.toArray(actionButtonsLeft?.props?.children);
        const pathChipPressable = rowChildren.find((child) => (
            React.isValidElement(child) && (child.props as any)?.testID === 'agent-input-path-chip'
        )) as React.ReactElement | undefined;
        expect(pathChipPressable).toBeTruthy();

        const styleFn = (pathChipPressable?.props as any)?.style as ((input: { pressed: boolean }) => unknown) | undefined;
        expect(typeof styleFn).toBe('function');

        const computed = styleFn?.({ pressed: false });
        const styleParts = Array.isArray(computed) ? computed : [computed];
        expect(styleParts.some(hasFlexGrowOne)).toBe(false);
        expect(styleParts.some(hasFlexShrinkZero)).toBe(true);
        expect(styleParts.some((value) => value && typeof value === 'object' && (value as { maxWidth?: unknown }).maxWidth === '100%')).toBe(true);
    });

    it('allows the row chips to wrap when there is not enough horizontal space', async () => {
        const styles = {
            pathRow: {},
            actionButtonsLeft: { flexWrap: 'wrap' as const },
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
            resumeSessionId: 'sess-123',
            onResumeClick: () => {},
            resumeLabelTitle: 'Resume session',
            resumeLabelOptional: 'Resume: Optional',
        }));

        const row = screen.findByTestId('agentInput-pathResumeRow');
        expect(row).toBeTruthy();

        const actionButtonsLeft = toArray(row?.props?.children)[0];
        const style = actionButtonsLeft?.props?.style;
        const styleArray = Array.isArray(style) ? style : [style];
        const flattened = Object.assign({}, ...styleArray.filter(Boolean));
        expect(flattened.flexWrap).not.toBe('nowrap');
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
        const actionButtonsLeft = toArray(row?.props?.children)[0];
        const testIds = React.Children.toArray(actionButtonsLeft?.props?.children)
            .map((node) => (React.isValidElement(node) ? (node.props as any)?.testID : null))
            .filter(Boolean) as string[];

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
        const resumeChip = screen.findByTestId('agent-input-resume-chip');

        expect(pathChip?.props.__ref).toBe(pathChipAnchorRef);
        expect(resumeChip?.props.anchorRef).toBe(resumeChipAnchorRef);
    });
});
