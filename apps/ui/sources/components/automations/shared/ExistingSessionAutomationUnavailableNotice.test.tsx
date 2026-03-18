import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                warningCritical: '#f00',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('ExistingSessionAutomationUnavailableNotice', () => {
    it('renders the blocked reason in a standard notice row', async () => {
        const { ExistingSessionAutomationUnavailableNotice } = await import('./ExistingSessionAutomationUnavailableNotice');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ExistingSessionAutomationUnavailableNotice reason="Session is not ready yet" />,
            );
        });

        const row = tree.root.findByType('Item');
        expect(row.props.subtitle).toBe('Session is not ready yet');
    });
});
