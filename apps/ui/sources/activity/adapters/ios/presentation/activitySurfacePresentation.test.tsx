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
    buttonStyle: (value: unknown) => value,
    controlSize: (value: unknown) => value,
    font: (value: unknown) => value,
    padding: (value: unknown) => value,
}));

import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import {
    resolveActivitySurfaceAttentionSymbol,
    resolveActivitySurfaceCompactLabel,
    resolveActivitySurfacePrimaryDetailText,
} from './activitySurfacePresentation';

function createSessionCard(overrides: Partial<ActivitySurfaceSessionViewModel> = {}): ActivitySurfaceSessionViewModel {
    return {
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
        ...overrides,
    };
}

describe('activitySurfacePresentation helpers', () => {
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
});
