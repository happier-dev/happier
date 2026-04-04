import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';

vi.mock('expo-widgets', () => ({
    createLiveActivity: (_name: string, component: unknown) => component,
}));

vi.mock('@expo/ui/swift-ui', () => ({
    HStack: (props: { children?: React.ReactNode }) => React.createElement('HStack', props, props.children),
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
    Text: (props: { children?: React.ReactNode }) => React.createElement('Text', props, props.children),
    VStack: (props: { children?: React.ReactNode }) => React.createElement('VStack', props, props.children),
}));

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
    font: (value: unknown) => value,
    padding: (value: unknown) => value,
}));

import { HappierFocusLiveActivityComponent } from './HappierFocusLiveActivity';

describe('HappierFocusLiveActivityComponent', () => {
    it('omits bottom action buttons when action buttons are disabled', () => {
        const rendered = HappierFocusLiveActivityComponent({
            version: 1,
            generatedAt: 1_000,
            sessionId: 'permission',
            title: 'Permission work',
            subtitle: null,
            statusText: 'Permission required',
            attentionState: 'permission_required',
            defaultTarget: 'open-session:permission',
            sessionTarget: 'open-session:permission',
            overflowCount: 0,
            totalAttentionCount: 1,
            allowActionButtons: false,
            labels: {
                title: 'Focused session',
                openLabel: 'Open',
                inboxLabel: 'Inbox',
                attentionLabel: 'Attention',
            },
        }, {} as never);

        expect(rendered.expandedBottom).toBeNull();
    });
});
