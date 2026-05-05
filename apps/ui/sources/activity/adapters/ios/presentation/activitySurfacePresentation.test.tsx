import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';

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

import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import {
    resolveActivitySurfaceAttentionTintName,
    resolveActivitySurfaceAttentionSymbol,
    resolveActivitySurfaceCompactLabel,
    renderActivitySurfaceCounts,
    resolveActivitySurfaceSessionCardButtonStyle,
    renderActivitySurfaceOverflowBadge,
    renderActivitySurfaceSessionCard,
    resolveActivitySurfacePrimaryDetailText,
} from './activitySurfacePresentation';

function createSessionCard(overrides: Partial<ActivitySurfaceSessionViewModel> = {}): ActivitySurfaceSessionViewModel {
    const { serverId = null, ...rest } = overrides;

    return {
        serverId,
        sessionId: 'session-1',
        title: 'Review auth flow',
        subtitle: '/Users/tester/project',
        previewText: 'Need your approval',
        statusText: 'Waiting for approval',
        attentionState: 'permission_required',
        route: '/session/session-1',
        target: 'open-session:session-1',
        defaultTarget: 'open-session:session-1',
        updatedAt: 1_000,
        isPrimary: true,
        ...rest,
    };
}

function collectTextValues(node: React.ReactNode): React.ReactNode[] {
    if (node == null || typeof node === 'boolean') {
        return [];
    }

    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return [];
    }

    const directTextChildren = (typeof node.type === 'function'
        ? node.type.name === 'Text'
        : node.type === 'Text')
        ? React.Children.toArray(node.props.children)
        : [];

    return [
        ...directTextChildren,
        ...React.Children.toArray(node.props.children).flatMap((child) => collectTextValues(child)),
    ];
}

describe('activitySurfacePresentation helpers', () => {
    it('renders overflow badges with pill chrome instead of plain text', () => {
        const overflowBadge = renderActivitySurfaceOverflowBadge(2);
        expect(overflowBadge).toBeTruthy();

        const badge = overflowBadge as React.ReactElement<{ modifiers?: Array<{ $type?: string }> }>;
        expect(badge.props.modifiers?.some((modifier) => modifier?.$type === 'background')).toBe(true);
    });

    it('prefers overflow counts over long compact labels', () => {
        expect(resolveActivitySurfaceCompactLabel({
            session: createSessionCard(),
            overflowCount: 2,
        })).toBe('+2');
    });

    it('prefers preview text over status text for shared primary detail rendering', () => {
        expect(resolveActivitySurfacePrimaryDetailText(createSessionCard())).toBe('Need your approval');
    });

    it('uses distinct urgency symbols for permission and action attention states', () => {
        expect(resolveActivitySurfaceAttentionSymbol('permission_required')).toBe('hand.raised.fill');
        expect(resolveActivitySurfaceAttentionSymbol('action_required')).toBe('exclamationmark.bubble.fill');
    });

    it('alternates the thinking symbol on a deterministic one second cadence', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
        expect(resolveActivitySurfaceAttentionSymbol('thinking')).toBe('sparkles');

        vi.setSystemTime(new Date('2026-05-05T12:00:01.000Z'));
        expect(resolveActivitySurfaceAttentionSymbol('thinking')).toBe('sparkles.rectangle.stack.fill');

        vi.useRealTimers();
    });

    it('maps attention states to stable system tint names', () => {
        expect(resolveActivitySurfaceAttentionTintName('permission_required')).toBe('systemRed');
        expect(resolveActivitySurfaceAttentionTintName('action_required')).toBe('systemOrange');
        expect(resolveActivitySurfaceAttentionTintName('thinking')).toBe('systemBlue');
        expect(resolveActivitySurfaceAttentionTintName('quiet')).toBe('secondaryLabel');
    });

    it('uses a shared plain button style so the session chrome comes from the custom surface', () => {
        expect(resolveActivitySurfaceSessionCardButtonStyle('permission_required')).toBe('plain');
        expect(resolveActivitySurfaceSessionCardButtonStyle('thinking')).toBe('plain');
    });

    it('renders urgent session cards with status-first detail hierarchy', () => {
        const rendered = renderActivitySurfaceSessionCard(createSessionCard({
            serverId: 'server-a',
            attentionState: 'permission_required',
            previewText: 'Need your approval',
            statusText: 'Permission required',
        }));

        const button = rendered as React.ReactElement<{
            modifiers?: unknown[];
            target?: string;
            children?: React.ReactNode;
        }>;
        expect(button.props.modifiers).toContain('plain');
        expect(button.props.target).toBe('open-session:session-1?serverId=server-a');
        const image = React.Children.toArray(
            (React.Children.toArray(
                (button.props.children as React.ReactElement<{ children?: React.ReactNode }>).props.children
            )[0] as React.ReactElement<{ children?: React.ReactNode }>).props.children
        )[0] as React.ReactElement<{ modifiers?: unknown[] }>;
        expect(image.props.modifiers).toContain('systemRed');
        const texts = collectTextValues(button);

        expect(texts).toEqual([
            'Review auth flow',
            'Permission required',
            'Need your approval',
        ]);
    });

    it('can suppress preview text for compact widget cards', () => {
        const rendered = renderActivitySurfaceSessionCard(createSessionCard({
            previewText: 'Need your approval',
            statusText: 'Permission required',
        }), {
            showPreviewText: false,
            showStatus: true,
            showSubtitle: false,
        });

        const button = rendered as React.ReactElement<{ children?: React.ReactNode }>;
        const texts = collectTextValues(button);

        expect(texts).toEqual([
            'Review auth flow',
            'Permission required',
        ]);
    });

    it('renders count metrics as pill badges to match the compact premium family', () => {
        const snapshot = buildActivitySurfaceSnapshot({
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
                    id: 'permission',
                    pendingPermissionRequestCount: 1,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'running',
                    active: true,
                    presence: 'online',
                    metadata: {
                        path: '/Users/tester/project/running',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Running work', updatedAt: 2 },
                    },
                }),
            ],
        });

        const counts = renderActivitySurfaceCounts(snapshot);
        const countTexts = React.Children.toArray((counts as React.ReactElement<{ children?: React.ReactNode }>).props.children)
            .filter((child): child is React.ReactElement<{ modifiers?: Array<{ $type?: string }>; children?: React.ReactNode }> => React.isValidElement(child));

        expect(countTexts).toHaveLength(3);
        expect(countTexts.every((node) => node.props.modifiers?.some((modifier) => modifier?.$type === 'background'))).toBe(true);
    });
});
