import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';

import type { LiveActivitySnapshot } from './buildLiveActivitySnapshots';

vi.mock('expo-widgets', () => ({
    createLiveActivity: (_name: string, component: unknown) => component,
}));

vi.mock('@expo/ui/swift-ui', () => ({
    Button: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('Button', props, props.children),
    HStack: (props: { children?: React.ReactNode }) => React.createElement('HStack', props, props.children),
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
    Text: (props: { children?: React.ReactNode }) => React.createElement('Text', props, props.children),
    VStack: (props: { children?: React.ReactNode }) => React.createElement('VStack', props, props.children),
}));

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
    background: (value: unknown, shape?: unknown) => ({ $type: 'background', value, shape }),
    border: (value: unknown) => ({ $type: 'border', value }),
    buttonStyle: (value: unknown) => value,
    clipShape: (shape: unknown, cornerRadius?: unknown) => ({ $type: 'clipShape', shape, cornerRadius }),
    font: (value: unknown) => value,
    foregroundStyle: (value: unknown) => value,
    lineLimit: (value: unknown) => ({ $type: 'lineLimit', value }),
    padding: (value: unknown) => value,
    shadow: (value: unknown) => ({ $type: 'shadow', value }),
    shapes: {
        capsule: (value?: unknown) => ({ $type: 'capsule', value }),
        roundedRectangle: (value?: unknown) => ({ $type: 'roundedRectangle', value }),
    },
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        PlatformColor: (value: string) => value,
    };
});

import { HappierFocusLiveActivityComponent } from './HappierFocusLiveActivity';

function createLiveActivitySnapshot(overrides: Partial<LiveActivitySnapshot> = {}): LiveActivitySnapshot {
    return {
        version: 1,
        generatedAt: 1_000,
        sessionId: 'permission',
        title: 'Permission work',
        subtitle: null,
        previewText: null,
        statusText: 'Permission required',
        attentionState: 'permission_required',
        defaultTarget: 'open-session:permission',
        sessionTarget: 'open-session:permission',
        overflowCount: 0,
        totalAttentionCount: 1,
        allowActionButtons: true,
        labels: {
            title: 'Focused session',
            openLabel: 'Open',
            inboxLabel: 'Inbox',
            attentionLabel: 'Attention',
        },
        ...overrides,
    };
}

function asElementWithProps<TProps>(
    value: React.ReactNode,
): React.ReactElement<TProps> {
    return value as React.ReactElement<TProps>;
}

describe('HappierFocusLiveActivityComponent', () => {
    it('omits bottom action buttons when action buttons are disabled', () => {
        const rendered = HappierFocusLiveActivityComponent(createLiveActivitySnapshot({
            allowActionButtons: false,
        }), {} as never);

        expect(rendered.expandedBottom).toBeNull();
    });

    it('keeps the primary live-activity button session-scoped even when the default tap target opens inbox', () => {
        const rendered = HappierFocusLiveActivityComponent(createLiveActivitySnapshot({
            previewText: 'Need your approval',
            defaultTarget: 'open-inbox',
            overflowCount: 1,
            totalAttentionCount: 2,
        }), {} as never);

        const bottom = asElementWithProps<{ children?: React.ReactNode }>(rendered.expandedBottom);
        const buttons = React.Children.toArray(bottom.props.children)
            .filter((child): child is React.ReactElement<{ target?: string }> => React.isValidElement(child));

        expect(buttons[0]?.props.target).toBe('open-session:permission');
        expect(buttons[1]?.props.target).toBe('open-inbox');
    });

    it('uses the shared urgency symbol, preview text, and overflow label in compact and expanded states', () => {
        const rendered = HappierFocusLiveActivityComponent(createLiveActivitySnapshot({
            sessionId: 'action',
            title: 'Action work',
            subtitle: '/Users/tester/project',
            previewText: 'Choose whether to continue',
            statusText: 'Action required',
            attentionState: 'action_required',
            defaultTarget: 'open-session:action',
            sessionTarget: 'open-session:action',
            overflowCount: 2,
            totalAttentionCount: 3,
        }), {} as never);

        expect(asElementWithProps<{ systemName?: string }>(rendered.compactLeading).props.systemName).toBe('exclamationmark.bubble.fill');
        expect(asElementWithProps<{ systemName?: string }>(rendered.minimal).props.systemName).toBe('exclamationmark.bubble.fill');
        const compactTrailing = asElementWithProps<{ children?: React.ReactNode; modifiers?: Array<{ $type?: string }> }>(rendered.compactTrailing);
        expect(compactTrailing.props.children).toBe('+2');
        expect(compactTrailing.props.modifiers?.some((modifier) => modifier?.$type === 'background')).toBe(true);

        const expandedLeading = asElementWithProps<{ children?: React.ReactNode }>(rendered.expandedLeading);
        const textChildren = React.Children.toArray(expandedLeading.props.children)
            .filter((child): child is React.ReactElement<{ children?: React.ReactNode }> => React.isValidElement(child))
            .flatMap((child) => React.Children.toArray(child.props.children));

        expect(textChildren).toEqual(expect.arrayContaining(['Action required', 'Choose whether to continue']));
        expect(textChildren.indexOf('Action required')).toBeLessThan(textChildren.indexOf('Choose whether to continue'));
    });
});
