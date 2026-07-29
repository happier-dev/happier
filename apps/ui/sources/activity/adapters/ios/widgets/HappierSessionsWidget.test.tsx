import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';

vi.mock('expo-widgets', () => ({
    createWidget: (_name: string, component: unknown) => component,
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

import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { HappierSessionsWidgetComponent } from './HappierSessionsWidget';

function collectButtons(node: React.ReactNode): React.ReactElement<{ children?: React.ReactNode }>[] {
    if (node == null || typeof node === 'boolean') {
        return [];
    }

    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return [];
    }

    const isButton = typeof node.type === 'function'
        ? node.type.name === 'Button'
        : node.type === 'Button';
    const directButtons = isButton ? [node] : [];
    return [
        ...directButtons,
        ...React.Children.toArray(node.props.children).flatMap((child) => collectButtons(child)),
    ];
}

function countTextChildren(button: React.ReactElement<{ children?: React.ReactNode }>): number {
    function collectTexts(node: React.ReactNode): number {
        if (node == null || typeof node === 'boolean') {
            return 0;
        }

        if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
            return 0;
        }

        const directCount = (typeof node.type === 'function'
            ? node.type.name === 'Text'
            : node.type === 'Text')
            ? React.Children.count(node.props.children)
            : 0;

        let nestedCount = 0;
        for (const child of React.Children.toArray(node.props.children)) {
            nestedCount += collectTexts(child);
        }

        return directCount + nestedCount;
    }

    return collectTexts(button);
}

function createSnapshot() {
    return buildActivitySurfaceSnapshot({
        policy: resolveActivitySurfacePolicy({
            widgets: {
                enabled: true,
                mode: 'attention',
                showPreviewText: true,
                showMachinePath: true,
            },
        }),
        nowMs: 1_000,
        sessions: [
            createSessionFixture({
                id: 'primary',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                pendingRequestObservedAt: 950,
                metadata: {
                    path: '/Users/tester/project/primary',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    name: 'Primary session',
                    summary: { text: 'Primary preview', updatedAt: 2 },
                },
            }),
            createSessionFixture({
                id: 'secondary',
                seq: 2,
                latestReadyEventSeq: 2,
                lastViewedSessionSeq: 1,
                metadata: {
                    path: '/Users/tester/project/secondary',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    name: 'Secondary session',
                    summary: { text: 'Secondary preview', updatedAt: 1 },
                },
            }),
        ],
    });
}

describe('HappierSessionsWidget', () => {
    it('renders compact title-only session cards on systemSmall', () => {
        const rendered = HappierSessionsWidgetComponent(createSnapshot(), { widgetFamily: 'systemSmall' } as never);
        const buttons = collectButtons(rendered);

        expect(buttons).toHaveLength(2);
        expect(countTextChildren(buttons[0])).toBe(1);
        expect(countTextChildren(buttons[1])).toBe(1);
    });

    it('keeps preview text on larger widget families', () => {
        const rendered = HappierSessionsWidgetComponent(createSnapshot(), { widgetFamily: 'systemMedium' } as never);
        const buttons = collectButtons(rendered);

        expect(buttons).toHaveLength(2);
        expect(countTextChildren(buttons[0])).toBeGreaterThan(1);
        expect(countTextChildren(buttons[1])).toBeGreaterThan(1);
    });
});
